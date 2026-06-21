//! 外部编辑器跳转（§6.3）。
//!
//! 产品刻意不暴露通用 shell 执行命令；本模块提供一个**专用**命令，只接受枚举
//! 编辑器名，参数以独立 `arg` 传入 `Command::new(bin)`，绝不走 `sh -c` 字符串拼接，
//! 杜绝命令注入。

use std::process::{Command, Stdio};

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
    let target = match line {
        Some(l) => format!("{expanded_path}:{l}"),
        None => expanded_path,
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
