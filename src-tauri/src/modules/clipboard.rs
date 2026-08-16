//! Native clipboard reads for Safe Paste.
//!
//! `navigator.clipboard.readText()` makes WKWebView and WebKitGTK show a second
//! Paste button after the user already chose Paste. This command reads the OS
//! clipboard through platform helpers so that permission sheet never appears.

use std::io;
use std::process::{Command, Stdio};

#[derive(Debug, PartialEq, Eq)]
enum CommandError {
    NotFound,
    Other(String),
}

#[cfg(target_os = "macos")]
const CANDIDATES: &[&[&str]] = &[&["pbpaste"]];

#[cfg(target_os = "linux")]
const CANDIDATES: &[&[&str]] = &[
    &["wl-paste", "-n"],
    &["xclip", "-selection", "clipboard", "-o"],
    &["xsel", "--clipboard", "--output"],
];

#[cfg(windows)]
const CANDIDATES: &[&[&str]] = &[&[
    "powershell",
    "-NoProfile",
    "-STA",
    "-NonInteractive",
    "-Command",
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-Clipboard -Raw",
]];

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
const CANDIDATES: &[&[&str]] = &[];

fn map_command_error(error: io::Error) -> CommandError {
    if error.kind() == io::ErrorKind::NotFound {
        CommandError::NotFound
    } else {
        CommandError::Other(error.to_string())
    }
}

fn run_clipboard_command(command: &[&str]) -> Result<String, CommandError> {
    let (program, args) = command.split_first().ok_or(CommandError::NotFound)?;
    let output = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .map_err(map_command_error)?;
    String::from_utf8(output.stdout).map_err(|error| CommandError::Other(error.to_string()))
}

fn read_os_clipboard_text() -> Result<String, String> {
    let mut last_error = None;
    for command in CANDIDATES {
        match run_clipboard_command(command) {
            Ok(text) => return Ok(text),
            Err(CommandError::NotFound) => {}
            Err(CommandError::Other(error)) => last_error = Some(error),
        }
    }
    Err(last_error.unwrap_or_else(|| "clipboard helpers unavailable".to_string()))
}

#[tauri::command]
pub async fn clipboard_read_text() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(read_os_clipboard_text)
        .await
        .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::{map_command_error, run_clipboard_command, CommandError};
    use std::io;

    #[test]
    fn missing_helper_is_not_found() {
        assert_eq!(
            map_command_error(io::Error::from(io::ErrorKind::NotFound)),
            CommandError::NotFound
        );
    }

    #[cfg(unix)]
    #[test]
    fn clipboard_command_reads_stdout() {
        let text = run_clipboard_command(&["printf", "%s", "hello-from-helper"]).unwrap();
        assert_eq!(text, "hello-from-helper");
    }

    #[test]
    fn missing_program_is_not_found() {
        assert_eq!(
            run_clipboard_command(&["tunara-missing-clipboard-helper"]),
            Err(CommandError::NotFound)
        );
    }

    #[test]
    fn platform_has_clipboard_candidates() {
        assert!(!super::CANDIDATES.is_empty());
    }
}
