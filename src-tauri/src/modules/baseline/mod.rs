#![allow(dead_code)] // 底座为 M5 git / 「丢弃本次 Agent 改动」预留，尚未接入调用点
//! 本轮改动模型 AgentRunBaseline（实施文档 §3.4.3，修 P0/P1-8）。
//!
//! D1 让 agent 直接写盘，核心风险随之从"apply patch"转移到 **区分 agent 本轮改动
//! 与用户原有 dirty work**。这是数据模型问题，不是 UI 文案问题。
//!
//! `agent_spawn` 前 [`AgentRunBaseline::capture`] 拍快照（仅指纹，不拷内容）；
//! 结束后 [`AgentRunBaseline::diff_now`] 分类出本轮 delta，驱动「丢弃本次 Agent 改动」
//! 与 commit 范围：
//! - `agent_only`：启动前干净、本轮 agent 新增 → 可安全展示/丢弃。
//! - `pre_existing`：启动前已有 → 永不自动丢弃。
//! - `conflicted`：同一路径启动前已改、agent 又改 → 拒绝自动丢弃，提示人工。
//!
//! MVP 落 `agent_only` vs `pre_existing` 两分类 + `conflicted` 拒绝路径；
//! `external`（运行期外部修改）二期。

use std::collections::HashMap;
use std::path::PathBuf;

use git2::{Repository, Status, StatusOptions};
use serde::Serialize;

/// 单文件指纹（够区分"是否变过"即可，不存内容）。
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct FileFingerprint {
    pub status_bits: u32, // git2 Status::bits 快照
}

/// spawn 前对仓库拍的快照。
#[derive(Clone, Debug)]
pub struct AgentRunBaseline {
    pub repo_root: PathBuf,
    /// 启动时"已 dirty"的文件指纹（路径 → 指纹）。干净文件不入表。
    pub dirty_at_start: HashMap<String, FileFingerprint>,
    pub captured_at: i64,
}

/// 结束后用"baseline vs 当前"分类。
#[derive(Serialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunDelta {
    /// 启动前干净、本轮新增 → 可安全展示/丢弃。
    pub agent_only: Vec<String>,
    /// 启动前已有 → 永不自动丢弃。
    pub pre_existing: Vec<String>,
    /// 同一路径启动前已改、agent 又改 → 拒绝自动丢弃。
    pub conflicted: Vec<String>,
}

impl AgentRunBaseline {
    /// 拍快照。非 git 仓库返回 None（agent 仍可跑，只是没有 diff 保护）。
    pub fn capture(repo_path: &str) -> Option<Self> {
        let repo = Repository::discover(repo_path).ok()?;
        let dirty = collect_dirty(&repo);
        let root = repo.workdir().map(|p| p.to_path_buf())?;
        Some(Self {
            repo_root: root,
            dirty_at_start: dirty,
            captured_at: now_unix(),
        })
    }

    /// 用当前工作区状态对比 baseline，分类出本轮 delta。
    pub fn diff_now(&self) -> Result<AgentRunDelta, String> {
        let repo = Repository::discover(&self.repo_root).map_err(|e| e.to_string())?;
        let current = collect_dirty(&repo);
        let mut delta = AgentRunDelta::default();

        for (path, cur_fp) in &current {
            match self.dirty_at_start.get(path) {
                // 启动前就 dirty
                Some(start_fp) => {
                    if start_fp == cur_fp {
                        // 指纹没变 → 纯用户原有改动
                        delta.pre_existing.push(path.clone());
                    } else {
                        // 启动前已改、现在又不同 → 冲突，无法安全区分
                        delta.conflicted.push(path.clone());
                    }
                }
                // 启动前干净 → 本轮 agent 新增
                None => delta.agent_only.push(path.clone()),
            }
        }
        delta.agent_only.sort();
        delta.pre_existing.sort();
        delta.conflicted.sort();
        Ok(delta)
    }
}

fn collect_dirty(repo: &Repository) -> HashMap<String, FileFingerprint> {
    let mut opts = StatusOptions::new();
    opts.include_untracked(true).recurse_untracked_dirs(true);
    let mut map = HashMap::new();
    if let Ok(statuses) = repo.statuses(Some(&mut opts)) {
        for entry in statuses.iter() {
            let s = entry.status();
            if s == Status::CURRENT {
                continue;
            }
            if let Some(path) = entry.path() {
                map.insert(path.to_string(), FileFingerprint { status_bits: s.bits() });
            }
        }
    }
    map
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
