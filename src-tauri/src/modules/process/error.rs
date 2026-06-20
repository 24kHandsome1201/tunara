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

impl fmt::Display for ProcessError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ProcessError::Spawn(m) => write!(f, "无法启动子进程：{m}"),
            ProcessError::Timeout => write!(f, "子进程超时，已终止"),
            ProcessError::Cancelled => write!(f, "已取消"),
            ProcessError::NonZeroExit { code, stderr } => {
                let c = code
                    .map(|c| c.to_string())
                    .unwrap_or_else(|| "signal".into());
                if stderr.is_empty() {
                    write!(f, "子进程退出码 {c}")
                } else {
                    write!(f, "{stderr}")
                }
            }
            ProcessError::Io(m) => write!(f, "IO 错误：{m}"),
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
