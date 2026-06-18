#![allow(dead_code)] // 底座为 M4 agent / M5 git 预留，尚未接入调用点
//! 统一的子进程基础设施（实施文档 §3.7.1）。
//!
//! agent CLI / git commit·push / preflight 三类子进程都要处理 stdout-drain、
//! stderr-drain、timeout、cancel、kill_on_drop、超时显式 kill+wait、错误回显。
//! 若各 command 手写一份必然行为漂移，故抽到这里统一。
//!
//! 两个 API：
//! - [`run_capture`]：跑完拿 stdout/stderr/status（git / preflight 用）。
//! - [`run_streaming_lines`]：流式读 stdout 行 + 同时 drain stderr + 支持 cancel/timeout（agent 用）。

mod error;
mod runner;

// 这些是给 M4 agent / M5 git 用的公共底座 API，当前尚未接入调用点，
// 故暂未使用——保留导出，避免后续重复定义。
#[allow(unused_imports)]
pub use error::ProcessError;
#[allow(unused_imports)]
pub use runner::{
    run_capture, run_streaming_lines, CancelToken, CommandOutput, CommandSpec,
    ManagedProcessHandle, StreamEnd, TimeoutPolicy,
};
