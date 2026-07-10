use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

use globset::{Glob, GlobSet, GlobSetBuilder};
use grep_regex::RegexMatcherBuilder;
use grep_searcher::sinks::UTF8;
use grep_searcher::{BinaryDetection, SearcherBuilder};
use ignore::{WalkBuilder, WalkState};
use parking_lot::Mutex;
use serde::Serialize;
use tauri::State;

const FILE_SIZE_CAP: u64 = 5 * 1024 * 1024;
const DEFAULT_MAX_RESULTS: usize = 200;
const HARD_MAX_RESULTS: usize = 2000;
const MAX_REQUEST_ID_LEN: usize = 128;
const MAX_RECENTLY_FINISHED_REQUESTS: usize = 256;

#[derive(Default)]
struct FsSearchCancellationRegistry {
    pending: HashMap<String, Arc<AtomicBool>>,
    cancelled_before_start: HashSet<String>,
    pre_cancel_order: VecDeque<String>,
    recently_finished: HashSet<String>,
    finished_order: VecDeque<String>,
}

#[derive(Default)]
pub struct FsSearchCancellationState {
    inner: Mutex<FsSearchCancellationRegistry>,
}

impl FsSearchCancellationState {
    pub(crate) fn register(&self, request_id: &str) -> Arc<AtomicBool> {
        let cancelled = Arc::new(AtomicBool::new(false));
        let mut registry = self.inner.lock();
        registry.recently_finished.remove(request_id);
        registry
            .finished_order
            .retain(|finished| finished != request_id);
        if registry.cancelled_before_start.remove(request_id) {
            registry
                .pre_cancel_order
                .retain(|cancelled| cancelled != request_id);
            cancelled.store(true, Ordering::Release);
        }
        registry
            .pending
            .insert(request_id.to_string(), cancelled.clone());
        cancelled
    }

    pub(crate) fn finish(&self, request_id: &str, cancelled: &Arc<AtomicBool>) {
        let mut registry = self.inner.lock();
        if registry
            .pending
            .get(request_id)
            .is_some_and(|current| Arc::ptr_eq(current, cancelled))
        {
            registry.pending.remove(request_id);
        }
        if registry.cancelled_before_start.remove(request_id) {
            registry
                .pre_cancel_order
                .retain(|cancelled| cancelled != request_id);
        }
        if registry.recently_finished.insert(request_id.to_string()) {
            registry.finished_order.push_back(request_id.to_string());
        }
        while registry.finished_order.len() > MAX_RECENTLY_FINISHED_REQUESTS {
            if let Some(expired) = registry.finished_order.pop_front() {
                registry.recently_finished.remove(&expired);
            }
        }
    }

    pub(super) fn cancel(&self, request_id: &str) -> bool {
        let mut registry = self.inner.lock();
        if registry.recently_finished.contains(request_id) {
            return false;
        }
        if let Some(cancelled) = registry.pending.get(request_id) {
            cancelled.store(true, Ordering::Release);
        } else {
            // The cancel IPC can overtake async command registration. Remember
            // it so an obsolete query cannot begin a full filesystem scan.
            if registry
                .cancelled_before_start
                .insert(request_id.to_string())
            {
                registry.pre_cancel_order.push_back(request_id.to_string());
            }
            while registry.pre_cancel_order.len() > MAX_RECENTLY_FINISHED_REQUESTS {
                if let Some(expired) = registry.pre_cancel_order.pop_front() {
                    registry.cancelled_before_start.remove(&expired);
                }
            }
        }
        true
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrepHit {
    pub path: String,
    pub rel: String,
    pub line: u64,
    pub text: String,
}

// camelCase matters here: the frontend GrepResponse type reads `filesScanned`,
// and without the rename this struct serialized `files_scanned`, so the field
// silently arrived as undefined on the TS side.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrepResponse {
    pub hits: Vec<GrepHit>,
    pub truncated: bool,
    pub files_scanned: usize,
}

fn build_globset(patterns: &[String]) -> Result<Option<GlobSet>, String> {
    if patterns.is_empty() {
        return Ok(None);
    }
    let mut b = GlobSetBuilder::new();
    for p in patterns {
        let g = Glob::new(p).map_err(|e| format!("bad glob {p:?}: {e}"))?;
        b.add(g);
    }
    let set = b.build().map_err(|e| format!("globset build: {e}"))?;
    Ok(Some(set))
}

pub(crate) fn validate_request_id(request_id: &str) -> Result<(), String> {
    if request_id.is_empty()
        || request_id.len() > MAX_REQUEST_ID_LEN
        || !request_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err("invalid filesystem search request id".into());
    }
    Ok(())
}

fn fs_grep_blocking(
    pattern: String,
    root: String,
    glob: Option<Vec<String>>,
    case_insensitive: Option<bool>,
    max_results: Option<usize>,
    cancelled: Arc<AtomicBool>,
) -> Result<GrepResponse, String> {
    if pattern.is_empty() {
        return Err("empty pattern".into());
    }
    let root_path = super::expand_tilde(&root);
    if !root_path.is_dir() {
        return Err(format!("not a directory: {root}"));
    }
    let cap = max_results
        .unwrap_or(DEFAULT_MAX_RESULTS)
        .clamp(1, HARD_MAX_RESULTS);

    let matcher = RegexMatcherBuilder::new()
        .case_insensitive(case_insensitive.unwrap_or(false))
        .line_terminator(Some(b'\n'))
        .build(&pattern)
        .map_err(|e| format!("bad regex: {e}"))?;

    let globs = build_globset(glob.as_deref().unwrap_or(&[]))?;

    let num_threads = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .min(8);

    let walker = WalkBuilder::new(&root_path)
        .hidden(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .ignore(true)
        .parents(true)
        .follow_links(false)
        .threads(num_threads)
        .build_parallel();

    let hits: Arc<Mutex<Vec<GrepHit>>> = Arc::new(Mutex::new(Vec::new()));
    let scanned = Arc::new(AtomicUsize::new(0));
    let truncated = Arc::new(std::sync::atomic::AtomicBool::new(false));

    let root_path = Arc::new(root_path);
    let matcher = Arc::new(matcher);
    let globs = Arc::new(globs);

    walker.run(|| {
        let hits = hits.clone();
        let scanned = scanned.clone();
        let truncated = truncated.clone();
        let root_path = root_path.clone();
        let matcher = matcher.clone();
        let globs = globs.clone();
        let cancelled = cancelled.clone();

        Box::new(move |dent| {
            if cancelled.load(Ordering::Acquire) || truncated.load(Ordering::Relaxed) {
                return WalkState::Quit;
            }
            let dent = match dent {
                Ok(d) => d,
                Err(_) => return WalkState::Continue,
            };
            if !dent.file_type().map(|t| t.is_file()).unwrap_or(false) {
                return WalkState::Continue;
            }
            let path = dent.path();
            let rel = match path.strip_prefix(&*root_path) {
                Ok(r) => r.to_string_lossy().into_owned(),
                Err(_) => return WalkState::Continue,
            };
            if let Some(set) = globs.as_ref() {
                if !set.is_match(&rel) {
                    return WalkState::Continue;
                }
            }
            if let Ok(meta) = std::fs::metadata(path) {
                if meta.len() > FILE_SIZE_CAP {
                    return WalkState::Continue;
                }
            }

            scanned.fetch_add(1, Ordering::Relaxed);

            let abs = path.to_string_lossy().into_owned();
            let rel_clone = rel.clone();
            let hits_ref = hits.clone();
            let truncated_ref = truncated.clone();
            let mut searcher = SearcherBuilder::new()
                .binary_detection(BinaryDetection::quit(b'\x00'))
                .line_number(true)
                .build();

            let _ = searcher.search_path(
                &*matcher,
                path,
                UTF8(|line_num, text| {
                    if cancelled.load(Ordering::Acquire) {
                        return Ok(false);
                    }
                    let line_text = text.trim_end_matches('\n').to_string();
                    let mut guard = hits_ref.lock();
                    if guard.len() >= cap {
                        truncated_ref.store(true, Ordering::Relaxed);
                        return Ok(false);
                    }
                    guard.push(GrepHit {
                        path: abs.clone(),
                        rel: rel_clone.clone(),
                        line: line_num,
                        text: line_text,
                    });
                    Ok(true)
                }),
            );

            WalkState::Continue
        })
    });

    let final_hits = match Arc::try_unwrap(hits) {
        Ok(m) => m.into_inner(),
        Err(arc) => arc.lock().clone(),
    };

    if cancelled.load(Ordering::Acquire) {
        return Err("search cancelled".into());
    }

    Ok(GrepResponse {
        hits: final_hits,
        truncated: truncated.load(Ordering::Relaxed),
        files_scanned: scanned.load(Ordering::Relaxed),
    })
}

#[tauri::command]
pub async fn fs_grep(
    pattern: String,
    root: String,
    glob: Option<Vec<String>>,
    case_insensitive: Option<bool>,
    max_results: Option<usize>,
    request_id: String,
    state: State<'_, FsSearchCancellationState>,
) -> Result<GrepResponse, String> {
    validate_request_id(&request_id)?;
    let cancelled = state.register(&request_id);
    let worker_cancelled = cancelled.clone();
    let worker_result = tauri::async_runtime::spawn_blocking(move || {
        fs_grep_blocking(
            pattern,
            root,
            glob,
            case_insensitive,
            max_results,
            worker_cancelled,
        )
    })
    .await;
    state.finish(&request_id, &cancelled);
    worker_result.map_err(|error| format!("grep worker failed: {error}"))?
}

#[tauri::command]
pub fn fs_cancel_search(
    request_id: String,
    state: State<'_, FsSearchCancellationState>,
) -> Result<bool, String> {
    validate_request_id(&request_id)?;
    Ok(state.cancel(&request_id))
}

#[cfg(test)]
mod tests {
    use super::{build_globset, fs_grep_blocking, validate_request_id, FsSearchCancellationState};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    #[test]
    fn build_globset_returns_none_for_empty_patterns() {
        let set = build_globset(&[]).expect("empty is ok");
        assert!(set.is_none());
    }

    #[test]
    fn build_globset_matches_paths_against_valid_globs() {
        let set = build_globset(&["*.rs".to_string(), "src/**/*.ts".to_string()])
            .expect("valid globs")
            .expect("some globset");
        assert!(set.is_match("main.rs"));
        assert!(set.is_match("src/app/index.ts"));
        assert!(!set.is_match("README.md"));
        assert!(!set.is_match("index.ts")); // not under src/
    }

    #[test]
    fn build_globset_reports_an_error_for_an_invalid_glob() {
        let err = build_globset(&["[unterminated".to_string()]).unwrap_err();
        assert!(err.starts_with("bad glob"), "unexpected error: {err}");
    }

    #[test]
    fn cancellation_state_handles_cancel_before_and_after_registration() {
        let state = FsSearchCancellationState::default();
        assert!(state.cancel("before-start"));
        let pre_cancelled = state.register("before-start");
        assert!(pre_cancelled.load(Ordering::Acquire));
        state.finish("before-start", &pre_cancelled);

        let in_flight = state.register("in-flight");
        assert!(state.cancel("in-flight"));
        assert!(in_flight.load(Ordering::Acquire));
        state.finish("in-flight", &in_flight);
        assert!(!state.cancel("in-flight"));
    }

    #[test]
    fn cancelled_grep_quits_before_scanning() {
        let cancelled = Arc::new(AtomicBool::new(true));
        let result = fs_grep_blocking(
            "needle".into(),
            std::env::temp_dir().to_string_lossy().into_owned(),
            None,
            None,
            Some(20),
            cancelled,
        );
        let error = match result {
            Ok(_) => panic!("pre-cancelled grep must not return partial results"),
            Err(error) => error,
        };
        assert_eq!(error, "search cancelled");
    }

    #[test]
    fn grep_request_ids_are_bounded_and_shell_safe() {
        assert!(validate_request_id("grep-42.local").is_ok());
        assert!(validate_request_id("").is_err());
        assert!(validate_request_id("bad/id").is_err());
        assert!(validate_request_id(&"x".repeat(129)).is_err());
    }
}
