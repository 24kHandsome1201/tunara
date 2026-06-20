pub mod fs;
pub mod pty;
pub mod secrets;
pub mod shell;

// Conduit 新增底座（实施文档 §3.7 / §3.4.3）
pub mod process;
pub mod resolver;
pub mod util;

// Conduit 新增功能模块
pub mod agent;  // §3.3 agent harness
pub mod git;    // §3.4 git 集成
