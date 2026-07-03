//! 统一进程错误 → UI 字符串（实施文档 §3.7.1）。

use std::fmt;

#[derive(Debug)]
pub enum ProcessError {
    /// 可执行找不到 / 无法 spawn（含 PATH 不可见，见 §3.7.2）。
    Spawn(String),
    /// 超时（已 kill + 回收子进程）。
    Timeout,
    /// 用户主动取消。
    Cancelled,
    /// 进程以非零码退出，携带 stderr 回显。
    NonZeroExit { code: Option<i32>, stderr: String },
    /// IO 错误。
    Io(String),
}

// Display strings are English on purpose: they cross the IPC boundary as raw
// error strings (e.g. agent preflight failures shown in the Settings CLI tab),
// and every other backend error string is English. UI-language messages belong
// in the frontend i18n layer; baking Chinese here produced mixed-language
// errors for English users.
impl fmt::Display for ProcessError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ProcessError::Spawn(m) => write!(f, "failed to start subprocess: {m}"),
            ProcessError::Timeout => write!(f, "subprocess timed out and was terminated"),
            ProcessError::Cancelled => write!(f, "cancelled"),
            ProcessError::NonZeroExit { code, stderr } => {
                let c = code
                    .map(|c| c.to_string())
                    .unwrap_or_else(|| "signal".into());
                if stderr.is_empty() {
                    write!(f, "subprocess exited with code {c}")
                } else {
                    write!(f, "{stderr}")
                }
            }
            ProcessError::Io(m) => write!(f, "IO error: {m}"),
        }
    }
}

impl std::error::Error for ProcessError {}

/// Tauri command 返回 `Result<_, String>`，统一转换。
impl From<ProcessError> for String {
    fn from(e: ProcessError) -> String {
        e.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::ProcessError;

    #[test]
    fn display_maps_each_variant_to_its_ui_string() {
        assert_eq!(
            ProcessError::Spawn("no PATH".into()).to_string(),
            "failed to start subprocess: no PATH"
        );
        assert_eq!(
            ProcessError::Timeout.to_string(),
            "subprocess timed out and was terminated"
        );
        assert_eq!(ProcessError::Cancelled.to_string(), "cancelled");
        assert_eq!(
            ProcessError::Io("disk full".into()).to_string(),
            "IO error: disk full"
        );
    }

    #[test]
    fn nonzero_exit_echoes_stderr_when_present() {
        let e = ProcessError::NonZeroExit {
            code: Some(1),
            stderr: "fatal: not a git repo".into(),
        };
        assert_eq!(e.to_string(), "fatal: not a git repo");
    }

    #[test]
    fn nonzero_exit_reports_exit_code_when_stderr_is_empty() {
        let e = ProcessError::NonZeroExit {
            code: Some(127),
            stderr: String::new(),
        };
        assert_eq!(e.to_string(), "subprocess exited with code 127");
    }

    #[test]
    fn nonzero_exit_reports_signal_when_code_is_none_and_no_stderr() {
        let e = ProcessError::NonZeroExit {
            code: None,
            stderr: String::new(),
        };
        assert_eq!(e.to_string(), "subprocess exited with code signal");
    }

    #[test]
    fn from_process_error_for_string_uses_display() {
        let s: String = ProcessError::Cancelled.into();
        assert_eq!(s, "cancelled");
    }
}
