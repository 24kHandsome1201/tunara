# 第三方代码声明（Third-Party Notices）

本项目（Conduit）的终端核心脚手架复用自以下开源项目，遵守其许可证。

## terax-ai-tauri-terminal

- **来源**：https://github.com/emee-dev/terax-ai-tauri-terminal
- **许可证**：Apache License 2.0（见仓库根 `LICENSE`）
- **复用范围**：作为脚手架基线，保留并复用其终端核心实现：
  - `src-tauri/src/modules/pty/`（真实终端：PTY 会话、三线程 + 背压、shell 集成 / OSC 注入）
  - `src-tauri/src/modules/fs/`（文件树 / 搜索 / grep）
  - `src-tauri/src/modules/shell/`（shell 命令执行）
  - `src-tauri/src/modules/secrets.rs`（keyring 凭证存储）
  - 前端 xterm 接线层与 `src/components/WindowControls.tsx` 等基础组件
- **改动范围**：包名 / 产品标识改为 Conduit；新增 agent harness、git 集成、Conduit 三栏 UI 外壳、以及 `src-tauri/src/modules/{process,resolver,baseline}` 等本项目特有模块（见 `docs/实施文档-从零到完整功能.md`）。
- **版权头**：保留 terax 源文件中原有的版权与许可声明。

> 新增代码（Conduit 特有）版权独立，整体仍以兼容方式分发。升级或替换复用部分时，请同步更新本文件与 `LICENSE`。
