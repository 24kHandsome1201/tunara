//! 子进程运行器（实施文档 §3.7.1）。
//!
//! 统一终止出口（§3.3.3 / §3.4.2 都收敛到这里）：
//! ```text
//! timeout / cancel / EOF / exit
//!         │
//!         ▼
//! kill if needed → wait → emit terminal event → cleanup → 返回结果
//! ```

use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::Mutex;

use super::error::ProcessError;

/// 描述一次子进程调用。
#[derive(Clone)]
pub struct CommandSpec {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    /// 额外环境变量（如 `GIT_TERMINAL_PROMPT=0`）。
    pub envs: Vec<(String, String)>,
}

impl CommandSpec {
    pub fn new(program: impl Into<String>) -> Self {
        Self {
            program: program.into(),
            args: Vec::new(),
            cwd: None,
            envs: Vec::new(),
        }
    }
    pub fn args<I, S>(mut self, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.args = args.into_iter().map(Into::into).collect();
        self
    }
    pub fn cwd(mut self, cwd: impl Into<String>) -> Self {
        self.cwd = Some(cwd.into());
        self
    }
    pub fn env(mut self, k: impl Into<String>, v: impl Into<String>) -> Self {
        self.envs.push((k.into(), v.into()));
        self
    }

    fn to_command(&self) -> Command {
        let mut cmd = Command::new(&self.program);
        cmd.args(&self.args);
        if let Some(cwd) = &self.cwd {
            cmd.current_dir(cwd);
        }
        for (k, v) in &self.envs {
            cmd.env(k, v);
        }
        cmd.kill_on_drop(true); // 兜底：handle 被 drop 时也会 kill
        cmd
    }
}

/// `run_capture` 的结果。
pub struct CommandOutput {
    pub stdout: String,
    pub stderr: String,
}

/// 用于 git / preflight：跑完拿 stdout/stderr/status。
///
/// 修 P1-7（二轮）：不用 `timeout(Command::output())`——那只丢弃 future，底层进程可能存活。
/// 这里 spawn + select。`wait_with_output()` 消费 child，故超时分支不再碰 child：
/// 依赖 `kill_on_drop(true)`（CommandSpec::to_command 已设）——函数 return 时 child 被
/// drop 即触发 kill，同样杜绝残留进程。
pub async fn run_capture(
    spec: CommandSpec,
    timeout: Duration,
) -> Result<CommandOutput, ProcessError> {
    let child = spec
        .to_command()
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| ProcessError::Spawn(format!("{}：{e}", spec.program)))?;

    let out = tokio::select! {
        res = child.wait_with_output() => res.map_err(|e| ProcessError::Io(e.to_string()))?,
        _ = tokio::time::sleep(timeout) => {
            // child 已被上面分支的 future 借走；超时丢弃该 future + child drop → kill_on_drop 生效
            return Err(ProcessError::Timeout);
        }
    };

    if out.status.success() {
        Ok(CommandOutput {
            stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
        })
    } else {
        Err(ProcessError::NonZeroExit {
            code: out.status.code(),
            stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
        })
    }
}

/// agent 至少需要三类终止条件（§3.3.3 / 新 review）。
#[derive(Clone)]
pub struct TimeoutPolicy {
    /// 总运行时间上限。
    pub wall_clock: Option<Duration>,
    /// 多久没有任何 stdout 行就判定卡死（修 P0-3：result-hang 真兜底）。
    pub idle: Option<Duration>,
    /// 用户手动取消。
    pub cancel: CancelToken,
}

impl TimeoutPolicy {
    pub fn agent_default(cancel: CancelToken) -> Self {
        Self {
            wall_clock: Some(Duration::from_secs(600)),
            idle: Some(Duration::from_secs(120)),
            cancel,
        }
    }
}

/// 可克隆的取消令牌（基于 watch channel，无需轮询）。
#[derive(Clone)]
pub struct CancelToken {
    tx: Arc<tokio::sync::watch::Sender<bool>>,
    rx: tokio::sync::watch::Receiver<bool>,
}

impl Default for CancelToken {
    fn default() -> Self {
        Self::new()
    }
}

impl CancelToken {
    pub fn new() -> Self {
        let (tx, rx) = tokio::sync::watch::channel(false);
        Self {
            tx: Arc::new(tx),
            rx,
        }
    }
    pub fn cancel(&self) {
        let _ = self.tx.send(true);
    }
    pub fn is_cancelled(&self) -> bool {
        *self.rx.borrow()
    }
    pub async fn cancelled(&mut self) {
        while !*self.rx.borrow_and_update() {
            if self.rx.changed().await.is_err() {
                return;
            }
        }
    }
}

/// 流式进程的终止原因。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamEnd {
    /// stdout EOF 后进程正常退出（携带成功与否）。
    Exited { success: bool },
    /// wall-clock 或 idle 超时（已 kill）。
    Timeout,
    /// 用户取消（已 kill）。
    Cancelled,
}

/// `run_streaming_lines` 返回的句柄。任务在后台跑，await 它拿终止原因与 stderr。
pub struct ManagedProcessHandle {
    join: tokio::task::JoinHandle<(StreamEnd, String)>,
}

impl ManagedProcessHandle {
    /// 等待进程结束，返回（终止原因，drain 到的 stderr）。
    pub async fn wait(self) -> (StreamEnd, String) {
        self.join
            .await
            .unwrap_or((StreamEnd::Exited { success: false }, String::new()))
    }
}

/// 用于 agent：流式读 stdout 行 + 同时 drain stderr + wall-clock/idle/cancel 三超时。
///
/// `on_line` 在收到每一行 stdout 时被调用（已去掉换行）。三种终止条件收敛到同一
/// "kill if needed → wait" 出口（修 P0-3）。
pub fn run_streaming_lines<F>(
    spec: CommandSpec,
    policy: TimeoutPolicy,
    mut on_line: F,
) -> Result<ManagedProcessHandle, ProcessError>
where
    F: FnMut(String) + Send + 'static,
{
    let mut child = spec
        .to_command()
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| ProcessError::Spawn(format!("{}：{e}", spec.program)))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| ProcessError::Io("no stdout".into()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| ProcessError::Io("no stderr".into()))?;

    // drain stderr（修 P0：管道写满会 hang），攒成失败诊断。
    let stderr_buf = Arc::new(Mutex::new(String::new()));
    {
        let buf = stderr_buf.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(l)) = lines.next_line().await {
                let mut g = buf.lock().await;
                g.push_str(&l);
                g.push('\n');
            }
        });
    }

    let join = tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        let wall = async {
            match policy.wall_clock {
                Some(d) => tokio::time::sleep(d).await,
                None => std::future::pending::<()>().await,
            }
        };
        tokio::pin!(wall);

        let idle_dur = policy.idle;
        let mut cancel = policy.cancel;
        let end = loop {
            let idle = async {
                match idle_dur {
                    Some(d) => tokio::time::sleep(d).await,
                    None => std::future::pending::<()>().await,
                }
            };
            tokio::select! {
                line = lines.next_line() => match line {
                    Ok(Some(l)) => { on_line(l); }
                    _ => {
                        let success = child.wait().await.map(|s| s.success()).unwrap_or(false);
                        break StreamEnd::Exited { success };
                    }
                },
                _ = idle => { break StreamEnd::Timeout; }
                _ = &mut wall => { break StreamEnd::Timeout; }
                _ = cancel.cancelled() => { break StreamEnd::Cancelled; }
            }
        };

        // 统一终止出口：超时/取消需主动 kill；EOF 已自然退出。
        if matches!(end, StreamEnd::Timeout | StreamEnd::Cancelled) {
            let _ = child.start_kill();
            let _ = child.wait().await;
        }
        let stderr_out = stderr_buf.lock().await.clone();
        (end, stderr_out)
    });

    Ok(ManagedProcessHandle { join })
}
