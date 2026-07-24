use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Manager};

const CURRENT_STORE: &str = "tunara-sessions.json";
const LEGACY_STORE: &str = "conduit-sessions.json";
const LEGACY_AGENT_EVENTS_DIR: &str = "agent-events";

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WorkspaceStoreFileState {
    Missing,
    Present,
}

fn is_known_store_file(file: &str) -> bool {
    matches!(file, CURRENT_STORE | LEGACY_STORE)
}

fn legacy_agent_data_path(app_local_data_dir: &Path) -> PathBuf {
    app_local_data_dir.join(LEGACY_AGENT_EVENTS_DIR)
}

fn legacy_agent_data_state(path: &Path) -> Result<WorkspaceStoreFileState, String> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => Ok(WorkspaceStoreFileState::Present),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(WorkspaceStoreFileState::Missing)
        }
        Err(error) => Err(format!("inspect legacy Agent data failed: {error}")),
    }
}

fn delete_legacy_agent_data_at(
    path: &Path,
    confirmed: bool,
) -> Result<WorkspaceStoreFileState, String> {
    if !confirmed {
        return Err("confirmation required".to_string());
    }

    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(WorkspaceStoreFileState::Missing);
        }
        Err(error) => return Err(format!("inspect legacy Agent data failed: {error}")),
    };

    if metadata.file_type().is_symlink() {
        // Remove the link itself. Never traverse a replacement link into data
        // outside Tunara's fixed app-local-data directory.
        std::fs::remove_file(path)
            .map_err(|error| format!("delete legacy Agent data link failed: {error}"))?;
    } else if metadata.is_dir() {
        // std::fs::remove_dir_all does not follow directory symlinks. The path
        // is derived entirely by the backend and never accepted from the UI.
        std::fs::remove_dir_all(path)
            .map_err(|error| format!("delete legacy Agent data failed: {error}"))?;
    } else {
        // A corrupt/partial old installation can leave a regular file at the
        // fixed legacy path. It is still safe to remove that exact backend-
        // derived path, while preserving every sibling.
        std::fs::remove_file(path)
            .map_err(|error| format!("delete legacy Agent data file failed: {error}"))?;
    }

    Ok(WorkspaceStoreFileState::Missing)
}

/// The store plugin's first `load` intentionally ignores disk read/parse
/// errors and returns defaults. Frontend code needs to know whether a file was
/// actually present so it can force `reload` and surface corruption instead of
/// treating it as a first launch.
#[tauri::command]
pub fn workspace_store_file_state(
    app: AppHandle,
    file: String,
) -> Result<WorkspaceStoreFileState, String> {
    if !is_known_store_file(&file) {
        return Err("unsupported workspace store file".to_string());
    }
    let path = tauri_plugin_store::resolve_store_path(&app, &file)
        .map_err(|e| format!("resolve workspace store path failed: {e}"))?;
    match std::fs::metadata(&path) {
        Ok(meta) if meta.is_file() => Ok(WorkspaceStoreFileState::Present),
        Ok(_) => Err(format!(
            "workspace store path is not a file: {}",
            path.display()
        )),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(WorkspaceStoreFileState::Missing),
        Err(e) => Err(format!("inspect workspace store failed: {e}")),
    }
}

/// v1.16 briefly shipped an opt-in persistent Agent event store. The current
/// product does not read it, but an upgraded user must still be able to remove
/// that private local data explicitly.
#[tauri::command]
pub fn legacy_agent_data_status(app: AppHandle) -> Result<WorkspaceStoreFileState, String> {
    let app_local_data_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("resolve legacy Agent data location failed: {error}"))?;
    legacy_agent_data_state(&legacy_agent_data_path(&app_local_data_dir))
}

/// Deletes only `<app_local_data_dir>/agent-events`. No caller-provided path is
/// accepted, and deletion requires both UI confirmation and this command-level
/// confirmation flag. Missing data is an idempotent success.
#[tauri::command]
pub async fn legacy_agent_data_delete(
    app: AppHandle,
    confirmed: bool,
) -> Result<WorkspaceStoreFileState, String> {
    if !confirmed {
        return Err("confirmation required".to_string());
    }
    let app_local_data_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("resolve legacy Agent data location failed: {error}"))?;
    let path = legacy_agent_data_path(&app_local_data_dir);
    tauri::async_runtime::spawn_blocking(move || delete_legacy_agent_data_at(&path, true))
        .await
        .map_err(|_| "legacy Agent data cleanup worker failed".to_string())?
}

#[cfg(test)]
mod tests {
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(label: &str) -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "tunara-workspace-store-{label}-{}-{nonce}",
                std::process::id()
            ));
            std::fs::create_dir_all(&path).expect("create test directory");
            Self(path)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn only_workspace_store_names_are_accepted() {
        assert!(is_known_store_file(CURRENT_STORE));
        assert!(is_known_store_file(LEGACY_STORE));
        assert!(!is_known_store_file("../config.toml"));
        assert!(!is_known_store_file("other.json"));
    }

    #[test]
    fn legacy_agent_data_cleanup_is_confirmed_scoped_and_idempotent() {
        let base = TempDir::new("legacy-agent-data");
        let path = legacy_agent_data_path(&base.0);
        let sibling = base.0.join("keep.txt");
        std::fs::create_dir_all(path.join("v1/payloads")).expect("create legacy data");
        std::fs::write(path.join("v1/payloads/private.json"), b"private")
            .expect("write legacy data");
        std::fs::write(&sibling, b"keep").expect("write sibling");

        assert_eq!(
            legacy_agent_data_state(&path).expect("inspect legacy data"),
            WorkspaceStoreFileState::Present
        );
        assert_eq!(
            delete_legacy_agent_data_at(&path, false).expect_err("confirmation is required"),
            "confirmation required"
        );
        assert!(path.exists());

        assert_eq!(
            delete_legacy_agent_data_at(&path, true).expect("delete legacy data"),
            WorkspaceStoreFileState::Missing
        );
        assert!(!path.exists());
        assert_eq!(std::fs::read(&sibling).expect("read sibling"), b"keep");
        assert_eq!(
            delete_legacy_agent_data_at(&path, true).expect("repeat delete"),
            WorkspaceStoreFileState::Missing
        );

        std::fs::write(&path, b"partial legacy data").expect("write legacy data file");
        assert_eq!(
            delete_legacy_agent_data_at(&path, true).expect("delete legacy data file"),
            WorkspaceStoreFileState::Missing
        );
        assert!(!path.exists());
        assert_eq!(
            std::fs::read(&sibling).expect("read sibling again"),
            b"keep"
        );
    }

    #[cfg(unix)]
    #[test]
    fn legacy_agent_data_cleanup_never_follows_symlinks() {
        use std::os::unix::fs::symlink;

        let base = TempDir::new("legacy-agent-data-symlink");
        let external = base.0.join("external");
        std::fs::create_dir_all(&external).expect("create external directory");
        std::fs::write(external.join("private.json"), b"keep").expect("write external file");

        let path = legacy_agent_data_path(&base.0);
        std::fs::create_dir_all(&path).expect("create legacy directory");
        symlink(&external, path.join("outside")).expect("create nested symlink");
        delete_legacy_agent_data_at(&path, true).expect("delete legacy directory");
        assert_eq!(
            std::fs::read(external.join("private.json")).expect("read external file"),
            b"keep"
        );

        symlink(&external, &path).expect("replace legacy directory with symlink");
        delete_legacy_agent_data_at(&path, true).expect("delete top-level symlink");
        assert!(!path.exists());
        assert_eq!(
            std::fs::read(external.join("private.json")).expect("read external file again"),
            b"keep"
        );
    }
}
