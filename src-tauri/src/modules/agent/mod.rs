//! 统一 Agent Harness：进程管理 + 流式推送（实施文档 §3.3.3）。
//!
//! 落地策略（§3.7.1/§3.7.3）：harness（args/parse_line）与事件协议各自独立，进程
//! 生命周期一律走 [`ProcessRunner`](crate::modules::process) 底座——stderr-drain、
//! wall-clock/idle/cancel 三超时、统一 kill 出口都在 `run_streaming_lines` 里，本模块
//! 不再手写裸 spawn。CLI 路径走 [`ResolverState`](crate::modules::resolver)（打包 .app
//! 也找得到）。`AgentRunBaseline`（§3.4.3）在 spawn 前拍快照、结束后合成 FileChange。
//!
//! 并发：`tokio::sync::Semaphore` 原子占额（修 P1-6），超限即拒绝（MVP，排队二期，D6）。
//! 名额随 [`AgentHandle`] drop 归还——超时/取消/正常完成三路径都从 `procs` remove → 归还。

pub mod event;
pub mod harness;
pub mod preflight;

#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use tauri::ipc::Channel;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use crate::modules::baseline::AgentRunBaseline;
use crate::modules::process::{run_streaming_lines, CancelToken, CommandSpec, StreamEnd, TimeoutPolicy};
use crate::modules::resolver::ResolverState;
use crate::modules::util::expand_tilde;
use event::AgentEvent;
use harness::AgentKind;

/// D6：软上限默认 4，运行时可从设置（tauri-plugin-store）读后 `set_max`。
const DEFAULT_MAX_CONCURRENT: usize = 4;
const WALL_CLOCK_TIMEOUT: Duration = Duration::from_secs(600); // 单轮总时长上限
const IDLE_TIMEOUT: Duration = Duration::from_secs(120); // 无新事件静默上限

/// 每个在跑的 agent：取消令牌（轮询 kill）+ 占用的并发名额。
/// `_permit` 随本结构 drop 归还名额（修 P1：超时/取消/完成三路径都归还）。
struct AgentHandle {
    cancel: CancelToken,
    _permit: OwnedSemaphorePermit,
}

type Procs = Arc<RwLock<HashMap<u32, Arc<AgentHandle>>>>;

type Baselines = Arc<RwLock<HashMap<u32, AgentRunBaseline>>>;

pub struct AgentState {
    procs: Procs,
    /// spawn 时拍的 baseline 快照(供「丢弃本次 Agent 改动」)。
    baselines: Baselines,
    next_id: AtomicU32,
    /// 修 P1-6：并发用信号量，check+占额原子，无 TOCTOU。
    sem: Arc<Semaphore>,
    /// 仅用于「设置」展示当前上限值。
    max_configured: AtomicUsize,
}

impl Default for AgentState {
    fn default() -> Self {
        Self {
            procs: Arc::new(RwLock::new(HashMap::new())),
            baselines: Arc::new(RwLock::new(HashMap::new())),
            next_id: AtomicU32::new(0),
            sem: Arc::new(Semaphore::new(DEFAULT_MAX_CONCURRENT)),
            max_configured: AtomicUsize::new(DEFAULT_MAX_CONCURRENT),
        }
    }
}

impl AgentState {
    fn procs(&self) -> Procs {
        self.procs.clone()
    }
    #[allow(dead_code)]
    fn baselines(&self) -> Baselines {
        self.baselines.clone()
    }
}

#[tauri::command]
pub async fn agent_spawn(
    state: tauri::State<'_, AgentState>,
    resolver: tauri::State<'_, ResolverState>,
    agent: String,          // "CC"|"CX"
    prompt: String,
    cwd: String,
    resume: Option<String>, // agent_session_id（CC=session_id / CX=thread_id）
    on_event: Channel<AgentEvent>,
) -> Result<u32, String> {
    // 修 P1-6：D6 软上限用 Semaphore，check+占额原子——并发 spawn 不会都通过检查而
    // 突破上限。MVP = 超限即拒绝（try_acquire），排队二期。
    let permit = state
        .sem
        .clone()
        .try_acquire_owned()
        .map_err(|_| "并发上限：请等待其他会话完成或在设置中调高上限".to_string())?;

    let kind = AgentKind::from_code(&agent).ok_or("未知 agent")?;

    // 展开 ~ —— 前端会话目录可能是 ~/foo,子进程 current_dir 不展开波浪号。
    let cwd = expand_tilde(&cwd);

    // CLI 路径走 resolver（§3.7.2）——dev / 打包 .app 一致；找不到给明确报错。
    let resolved = resolver.resolve(kind.bin());
    let program = resolved.path.as_ref().map(|p| p.to_string_lossy().into_owned()).ok_or_else(|| {
        format!(
            "未找到 {}（是否已安装/登录/PATH 可见？可在设置里指定绝对路径，见 §3.3.4/§3.7.2）",
            kind.bin()
        )
    })?;

    // spawn 前拍 baseline 快照（非 git 仓库返回 None，agent 仍可跑，只是没有 diff 保护）。
    let baseline = AgentRunBaseline::capture(&cwd);

    let spec = CommandSpec::new(program)
        .args(kind.args(&prompt, resume.as_deref()))
        .cwd(cwd.clone());

    let cancel = CancelToken::new();
    let policy = TimeoutPolicy {
        wall_clock: Some(WALL_CLOCK_TIMEOUT),
        idle: Some(IDLE_TIMEOUT),
        cancel: cancel.clone(),
    };

    let id = state.next_id.fetch_add(1, Ordering::Relaxed) + 1;

    // 是否已见过终态事件（CC 偶发 result 缺失，issue #1920/#8126/#25629）——
    // 闭包里收到 Done/Failed 标记，结束后据此决定是否补发兜底终态。
    let saw_done = Arc::new(AtomicBool::new(false));

    let ch = on_event.clone();
    let saw_done_line = saw_done.clone();
    // 每行 stdout：解析 → 推前端。on_line 是 FnMut + Send + 'static。
    let handle = run_streaming_lines(spec, policy, move |line| {
        if let Some(ev) = kind.parse_line(&line) {
            if matches!(ev, AgentEvent::Done { .. } | AgentEvent::Failed { .. }) {
                saw_done_line.store(true, Ordering::SeqCst);
            }
            let _ = ch.send(ev);
        }
    })
    .map_err(|e| e.to_string())?;

    // 占额 + 取消令牌交给 AgentHandle；任务结束 remove 时 drop，名额归还。
    let running = Arc::new(AgentHandle {
        cancel,
        _permit: permit,
    });
    state.procs.write().expect("AgentState procs lock poisoned").insert(id, running);
    if let Some(ref b) = baseline {
        state.baselines.write().expect("AgentState baselines lock poisoned").insert(id, b.clone());
    }

    let procs = state.procs();
    let ch_end = on_event.clone();
    tokio::spawn(async move {
        let (end, stderr) = handle.wait().await;
        emit_terminal(&ch_end, end, &stderr, saw_done.load(Ordering::SeqCst), &baseline);
        // 统一出口：从 procs 移除 → AgentHandle drop → 名额（_permit）归还。
        // 超时 / 取消 / 正常退出同一出口。
        procs.write().expect("AgentState procs lock poisoned").remove(&id);
    });

    Ok(id)
}

/// 把底座的 [`StreamEnd`] 映射成终态事件（§4.4：run 完成用 baseline 合成 FileChange）。
fn emit_terminal(
    ch: &Channel<AgentEvent>,
    end: StreamEnd,
    stderr: &str,
    saw_done: bool,
    baseline: &Option<AgentRunBaseline>,
) {
    match end {
        StreamEnd::Timeout => {
            let _ = ch.send(AgentEvent::Failed {
                message: "agent 超时未完成，已终止（可能 hang，见 §3.3.3/§8）".into(),
            });
        }
        StreamEnd::Cancelled => {
            let _ = ch.send(AgentEvent::Failed {
                message: "已取消".into(),
            });
        }
        StreamEnd::Exited { success } => {
            // 兜底：CC 偶发 result 缺失——没见过终态才补发，用真实退出码定 Done/Failed。
            if !saw_done {
                if success {
                    let _ = ch.send(AgentEvent::Done {
                        ok: true,
                        result: None,
                        cost_usd: None,
                    });
                } else {
                    let _ = ch.send(AgentEvent::Failed {
                        message: if stderr.trim().is_empty() {
                            "agent 异常退出".into()
                        } else {
                            stderr.trim().to_string()
                        },
                    });
                }
            }
        }
    }

    // run 完成：用 baseline delta 合成 FileChange[]（不依赖 CLI 字段，§3.4.3/§4.4）。
    // 仅对 agent 本轮新增（agent_only）发 FileChange；pre_existing/conflicted 不当作本轮改动。
    if let Some(b) = baseline {
        if let Ok(delta) = b.diff_now() {
            for path in delta.agent_only {
                let _ = ch.send(AgentEvent::FileChange { path });
            }
        }
    }
}

#[tauri::command]
pub async fn agent_cancel(state: tauri::State<'_, AgentState>, id: u32) -> Result<(), String> {
    // 触发取消令牌；流式任务轮询到后走统一 kill 出口，从 procs remove（名额随之归还）。
    let running = state.procs.read().expect("AgentState procs lock poisoned").get(&id).cloned();
    if let Some(r) = running {
        r.cancel.cancel();
    }
    Ok(())
}

/// 当前并发软上限（设置页展示用）。
#[tauri::command]
pub fn agent_max_concurrent(state: tauri::State<'_, AgentState>) -> usize {
    state.max_configured.load(Ordering::SeqCst)
}

/// 丢弃本次 Agent 改动（§4.4 修 P1-8）：只回滚 agent_only，conflicted 拒绝。
#[tauri::command]
pub async fn agent_discard_changes(
    state: tauri::State<'_, AgentState>,
    resolver: tauri::State<'_, ResolverState>,
    id: u32,
) -> Result<crate::modules::baseline::AgentRunDelta, String> {
    let baseline = state
        .baselines
        .read()
        .expect("AgentState baselines lock poisoned")
        .get(&id)
        .cloned()
        .ok_or("未找到该会话的 baseline（非 git 仓库或会话已清理）")?;

    let delta = baseline.diff_now()?;

    if !delta.conflicted.is_empty() {
        return Err(format!(
            "以下文件在 Agent 启动前已有改动且 Agent 也修改了，无法安全区分，请手动处理：{}",
            delta.conflicted.join(", ")
        ));
    }

    // 只回滚 agent_only（启动前干净、本轮 agent 新增的文件）
    if !delta.agent_only.is_empty() {
        let resolved = resolver.resolve("git");
        if let Some(git_path) = resolved.path {
            let program = git_path.to_string_lossy().into_owned();
            let repo = baseline.repo_root.to_string_lossy().into_owned();
            let mut args: Vec<String> = vec!["checkout".into(), "--".into()];
            args.extend(delta.agent_only.iter().cloned());
            let spec = crate::modules::process::CommandSpec::new(program)
                .args(args)
                .cwd(&repo)
                .env("GIT_TERMINAL_PROMPT", "0");
            let _ = crate::modules::process::run_capture(
                spec,
                std::time::Duration::from_secs(30),
            )
            .await;
            // 新增的 untracked 文件需要手动删除(checkout 不处理)
            for path in &delta.agent_only {
                if path.contains("..") {
                    continue;
                }
                let full = baseline.repo_root.join(path);
                if let Ok(canonical) = full.canonicalize() {
                    if !canonical.starts_with(&baseline.repo_root) {
                        continue;
                    }
                    let _ = std::fs::remove_file(&canonical);
                }
            }
        }
    }

    Ok(delta)
}

// 多轮对话主路径 = 用 resume 重新 spawn（CC --resume / CX exec resume），不走 agent
// stdin。故不注册 agent_write，前端也不暴露该契约。若未来要做"同一进程内多轮"，需
// 另行实现：spawn 时 .stdin(piped())、持有 ChildStdin、提供写入/换行/关闭与取消语义——非 MVP。
