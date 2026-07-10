use serde::Serialize;
use tauri::AppHandle;

const CURRENT_STORE: &str = "tunara-sessions.json";
const LEGACY_STORE: &str = "conduit-sessions.json";

#[derive(Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WorkspaceStoreFileState {
    Missing,
    Present,
}

fn is_known_store_file(file: &str) -> bool {
    matches!(file, CURRENT_STORE | LEGACY_STORE)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_workspace_store_names_are_accepted() {
        assert!(is_known_store_file(CURRENT_STORE));
        assert!(is_known_store_file(LEGACY_STORE));
        assert!(!is_known_store_file("../config.toml"));
        assert!(!is_known_store_file("other.json"));
    }
}
