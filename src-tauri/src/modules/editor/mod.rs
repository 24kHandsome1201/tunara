//! 外部编辑器跳转（§6.3）。
//!
//! 产品刻意不暴露通用 shell 执行命令；本模块提供一个**专用**命令，只接受枚举
//! 编辑器名，参数以独立 `arg` 传入 `Command::new(bin)`，绝不走 `sh -c` 字符串拼接，
//! 杜绝命令注入。

use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};

use sha2::{Digest, Sha256};
use tauri::Manager;

use crate::modules::resolver::ResolverState;
use crate::modules::util::expand_tilde;

enum GotoStyle {
    Flag,
    Colon,
}

#[tauri::command]
pub fn open_in_editor(
    state: tauri::State<'_, ResolverState>,
    editor: String,
    path: String,
    line: Option<u32>,
    column: Option<u32>,
) -> Result<(), String> {
    let (bin, goto_style) = match editor.as_str() {
        "vscode" => ("code", GotoStyle::Flag),
        "cursor" => ("cursor", GotoStyle::Flag),
        "zed" => ("zed", GotoStyle::Colon),
        "sublime" => ("subl", GotoStyle::Colon),
        _ => return Err(format!("unsupported editor: {editor}")),
    };

    let resolved = state.resolve(bin);
    let resolved_path = match resolved.path {
        Some(p) => p,
        None => return Err(format!("editor not found: {bin}")),
    };

    let expanded_path = expand_tilde(&path);
    let target = match (line, column) {
        (Some(l), Some(c)) => format!("{expanded_path}:{l}:{c}"),
        (Some(l), None) => format!("{expanded_path}:{l}"),
        (None, _) => expanded_path,
    };

    let mut cmd = Command::new(resolved_path);
    match goto_style {
        GotoStyle::Flag => {
            cmd.arg("--goto").arg(&target);
        }
        GotoStyle::Colon => {
            cmd.arg(&target);
        }
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    cmd.spawn().map_err(|e| e.to_string())?;
    Ok(())
}

fn sanitize_remote_edit_segment(value: &str) -> String {
    let mut out = String::new();
    for ch in value.chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.') {
            out.push(ch);
        } else {
            out.push('_');
        }
        if out.len() >= 64 {
            break;
        }
    }
    if out.is_empty() {
        "_".into()
    } else {
        out
    }
}

pub(crate) fn remote_edit_staging_relative(
    session_id: &str,
    remote_path: &str,
) -> Result<PathBuf, String> {
    if session_id.is_empty() || session_id.len() > 128 || session_id.contains('\0') {
        return Err("invalid remote edit session".into());
    }
    if !remote_path.starts_with('/')
        || remote_path.contains('\0')
        || Path::new(remote_path)
            .components()
            .any(|component| matches!(component, Component::ParentDir))
    {
        return Err("remote edit path must be an absolute POSIX path".into());
    }
    let file_name = Path::new(remote_path)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty() && *name != "." && *name != "..")
        .ok_or("remote edit path must name a file")?;
    let digest = format!("{:x}", Sha256::digest(remote_path.as_bytes()));
    Ok(PathBuf::from("remote-edit")
        .join(sanitize_remote_edit_segment(session_id))
        .join(&digest[..16])
        .join(sanitize_remote_edit_segment(file_name)))
}

/// Allocate a local staging file under the app data dir so an external editor
/// can save a remote file; the frontend then uploads on change.
#[tauri::command]
pub fn remote_edit_staging_path(
    app: tauri::AppHandle,
    session_id: String,
    remote_path: String,
) -> Result<String, String> {
    let relative = remote_edit_staging_relative(&session_id, &remote_path)?;
    let root = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("resolve app data dir failed: {error}"))?;
    let local = root.join(relative);
    if let Some(parent) = local.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("create remote-edit staging directory failed: {error}"))?;
    }
    if local.exists() {
        std::fs::remove_file(&local)
            .map_err(|error| format!("replace remote-edit staging file failed: {error}"))?;
    }
    Ok(local.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::remote_edit_staging_relative;

    #[test]
    fn staging_path_is_bounded_and_rejects_parent_segments() {
        let relative = remote_edit_staging_relative("sess-1", "/var/log/app.log").unwrap();
        let text = relative.to_string_lossy();
        assert!(text.starts_with("remote-edit/"));
        assert!(text.ends_with("app.log"));
        assert!(!text.contains(".."));
        assert!(remote_edit_staging_relative("sess-1", "/tmp/../etc/passwd").is_err());
        assert!(remote_edit_staging_relative("", "/tmp/a").is_err());
    }
}
