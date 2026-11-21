use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use ignore::WalkBuilder;
use serde::Serialize;
use tauri::State;

use super::grep::{validate_request_id, FsSearchCancellationState};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    /// Absolute path of the matched file.
    pub path: String,
    /// Path relative to the search root, for display.
    pub rel: String,
    /// File name only.
    pub name: String,
    pub is_dir: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResponse {
    pub hits: Vec<SearchHit>,
    pub unreadable: usize,
}

/// Walks `root` honoring `.gitignore` / `.ignore` / hidden rules and returns
/// entries whose path contains `query` (case-insensitive substring on the
/// path relative to root). Returns up to `limit` hits. An empty query returns
/// nothing — callers should short-circuit before invoking.
fn fs_search_blocking(
    root: String,
    query: String,
    limit: Option<usize>,
    include_hidden: Option<bool>,
    cancelled: Arc<AtomicBool>,
) -> Result<SearchResponse, String> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return Ok(SearchResponse {
            hits: Vec::new(),
            unreadable: 0,
        });
    }
    let cap = limit.unwrap_or(200).min(1000);
    // Collect a larger candidate pool than the response cap, then rank and
    // truncate. Stopping the walk at exactly `cap` hits meant ranking only
    // ever saw the first N matches in walk order — on a big tree a filename
    // match deep in the walk lost to path-substring matches that happened to
    // come first, so "config" surfaced 80 shallow noise paths and never
    // reached src/config.ts. 5× (bounded) keeps the walk cheap while giving
    // the filename-first sort real candidates to choose from.
    let scan_cap = (cap * 5).min(1000);
    let include_hidden = include_hidden.unwrap_or(false);
    let root_path = super::expand_tilde(&root);
    if !root_path.is_dir() {
        return Err(format!("not a directory: {root}"));
    }

    let mut out: Vec<SearchHit> = Vec::with_capacity(cap.min(64));

    let walker = WalkBuilder::new(&root_path)
        .hidden(!include_hidden)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .ignore(true)
        .parents(true)
        .follow_links(false)
        .build();

    let mut unreadable = 0;
    for dent in walker {
        if cancelled.load(Ordering::Acquire) {
            return Err("search cancelled".into());
        }
        if out.len() >= scan_cap {
            break;
        }
        let dent = match dent {
            Ok(dent) => dent,
            Err(err) => {
                if err.io_error().is_some() {
                    unreadable += 1;
                }
                continue;
            }
        };
        let path = dent.path();
        if path == root_path {
            continue;
        }
        let rel = match path.strip_prefix(&root_path) {
            Ok(r) => r.to_string_lossy().into_owned(),
            Err(_) => continue,
        };
        if !rel.to_lowercase().contains(&q) {
            continue;
        }
        let name = path
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        let is_dir = dent.file_type().map(|t| t.is_dir()).unwrap_or(false);
        out.push(SearchHit {
            path: path.to_string_lossy().into_owned(),
            rel,
            name,
            is_dir,
        });
    }

    // Rank: filename matches first, then shorter relative paths — then hand
    // back only the response cap. The frontend infers "more results exist"
    // from hitting `limit` exactly, so the truncation must land on `cap`.
    out.sort_by(|a, b| {
        let an = a.name.to_lowercase().contains(&q);
        let bn = b.name.to_lowercase().contains(&q);
        bn.cmp(&an).then(a.rel.len().cmp(&b.rel.len()))
    });
    out.truncate(cap);

    if cancelled.load(Ordering::Acquire) {
        return Err("search cancelled".into());
    }

    Ok(SearchResponse {
        hits: out,
        unreadable,
    })
}

#[tauri::command]
pub async fn fs_search(
    root: String,
    query: String,
    limit: Option<usize>,
    include_hidden: Option<bool>,
    request_id: String,
    state: State<'_, FsSearchCancellationState>,
) -> Result<SearchResponse, String> {
    validate_request_id(&request_id)?;
    let cancelled = state.register(&request_id);
    let worker_cancelled = cancelled.clone();
    let worker_result = tauri::async_runtime::spawn_blocking(move || {
        fs_search_blocking(root, query, limit, include_hidden, worker_cancelled)
    })
    .await;
    state.finish(&request_id, &cancelled);
    worker_result.map_err(|error| format!("filename search worker failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::fs_search_blocking;
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;
    #[cfg(unix)]
    #[test]
    fn unreadable_folder_preserves_readable_matches() {
        use std::os::unix::fs::PermissionsExt;
        let root =
            std::env::temp_dir().join(format!("tunara-search-unreadable-{}", std::process::id()));
        std::fs::create_dir_all(root.join("locked")).unwrap();
        std::fs::write(root.join("needle.txt"), "needle").unwrap();
        std::fs::write(root.join("locked/needle.txt"), "needle").unwrap();
        std::fs::set_permissions(root.join("locked"), std::fs::Permissions::from_mode(0o0))
            .unwrap();
        if std::fs::read_dir(root.join("locked")).is_ok() {
            std::fs::set_permissions(root.join("locked"), std::fs::Permissions::from_mode(0o700))
                .unwrap();
            std::fs::remove_dir_all(&root).unwrap();
            return;
        }
        let result = fs_search_blocking(
            root.to_string_lossy().into_owned(),
            "needle".into(),
            Some(20),
            None,
            Arc::new(AtomicBool::new(false)),
        );
        std::fs::set_permissions(root.join("locked"), std::fs::Permissions::from_mode(0o700))
            .unwrap();
        std::fs::remove_dir_all(&root).unwrap();
        let response = result.unwrap();
        println!(
            "search: hits={} unreadable={}",
            response.hits.len(),
            response.unreadable
        );
        assert_eq!(response.hits.len(), 1);
        assert_eq!(response.unreadable, 1);
    }

    #[test]
    fn cancelled_filename_search_quits_before_scanning() {
        let result = fs_search_blocking(
            std::env::temp_dir().to_string_lossy().into_owned(),
            "definitely-not-empty".into(),
            Some(20),
            None,
            Arc::new(AtomicBool::new(true)),
        );

        assert_eq!(result.err().as_deref(), Some("search cancelled"));
    }
}
