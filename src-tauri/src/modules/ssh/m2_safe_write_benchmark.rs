//! One-shot fault control for the isolated M2 safe-write product benchmark.
//!
//! This entire module and its Tauri plugin are absent unless the explicit
//! `m2-safe-write-benchmark` Cargo feature is enabled. The command cannot run
//! arbitrary stages or paths: it only arms a release-lock failure for an
//! existing SSH session and a dedicated `/tmp` benchmark fixture.

use crate::modules::pty::{PtyState, Session};
use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

const FIXTURE_PREFIX: &str = "/tmp/tunara-m2-safe-write-benchmark-";
const PLUGIN_NAME: &str = "m2-safe-write-benchmark";

type FaultKey = (u32, String);
static RELEASE_FAILURES: OnceLock<Mutex<HashSet<FaultKey>>> = OnceLock::new();

fn release_failures() -> &'static Mutex<HashSet<FaultKey>> {
    RELEASE_FAILURES.get_or_init(|| Mutex::new(HashSet::new()))
}

fn validate_fixture_path(path: &str) -> Result<(), String> {
    super::sftp::validate_remote_edit_path(path)?;
    let suffix = path
        .strip_prefix(FIXTURE_PREFIX)
        .ok_or_else(|| "benchmark path must use the isolated M2 fixture prefix".to_string())?;
    let (fixture_id, relative) = suffix.split_once('/').ok_or_else(|| {
        "benchmark path must name a file inside its fixture directory".to_string()
    })?;
    if fixture_id.is_empty()
        || !fixture_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        || relative.is_empty()
        || relative.contains('/')
    {
        return Err(
            "benchmark path must be one direct file inside a safe fixture directory".into(),
        );
    }
    Ok(())
}

fn arm(id: u32, path: String) -> Result<(), String> {
    validate_fixture_path(&path)?;
    let inserted = release_failures()
        .lock()
        .map_err(|_| "benchmark fault registry unavailable".to_string())?
        .insert((id, path));
    if !inserted {
        return Err("benchmark release failure is already armed".into());
    }
    Ok(())
}

pub(crate) fn take_release_failure(id: u32, path: &str) -> bool {
    release_failures()
        .lock()
        .map(|mut faults| faults.remove(&(id, path.to_string())))
        .unwrap_or(false)
}

#[tauri::command]
fn arm_release_failure(
    state: tauri::State<'_, PtyState>,
    id: u32,
    path: String,
) -> Result<(), String> {
    let session = state.get(id).ok_or_else(|| "no session".to_string())?;
    if !matches!(session.as_ref(), Session::Ssh(_)) {
        return Err("benchmark fault requires an SSH session".into());
    }
    arm(id, path)
}

pub(crate) fn init<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new(PLUGIN_NAME)
        .invoke_handler(tauri::generate_handler![arm_release_failure])
        .build()
}

#[cfg(test)]
mod tests {
    use super::{arm, take_release_failure, validate_fixture_path};

    #[test]
    fn fixture_paths_are_narrow_and_non_traversing() {
        assert!(
            validate_fixture_path("/tmp/tunara-m2-safe-write-benchmark-run-42/配置 file.md")
                .is_ok()
        );
        for path in [
            "/tmp/ordinary/file.md",
            "/root/tunara-m2-safe-write-benchmark-run/file.md",
            "/tmp/tunara-m2-safe-write-benchmark-/file.md",
            "/tmp/tunara-m2-safe-write-benchmark-run/nested/file.md",
            "/tmp/tunara-m2-safe-write-benchmark-run/../file.md",
        ] {
            assert!(validate_fixture_path(path).is_err(), "accepted {path}");
        }
    }

    #[test]
    fn release_faults_are_scoped_and_consumed_once() {
        let path = "/tmp/tunara-m2-safe-write-benchmark-one/file.md".to_string();
        arm(41, path.clone()).expect("arm first fault");
        assert!(arm(41, path.clone()).is_err(), "duplicate arm must fail");
        assert!(!take_release_failure(42, &path));
        assert!(take_release_failure(41, &path));
        assert!(!take_release_failure(41, &path));
        arm(41, path.clone()).expect("consumed fault can be armed again");
        assert!(take_release_failure(41, &path));
    }
}
