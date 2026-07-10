# 第三方代码声明（Third-Party Notices）

本项目（Tunara）的终端核心脚手架复用自以下开源项目，遵守其许可证。

## terax-ai-tauri-terminal

- **来源**：https://github.com/emee-dev/terax-ai-tauri-terminal
- **许可证**：Apache License 2.0（见仓库根 `LICENSE`）
- **当前复用范围**：作为脚手架基线，保留并复用其终端核心实现思路和部分代码：
  - `src-tauri/src/modules/pty/`（真实终端：PTY 会话、三线程 + 背压、shell 集成 / OSC 注入）
  - `src-tauri/src/modules/fs/`（文件树 / 搜索 / grep）
  - 前端 xterm 接线层和 shell integration 处理
- **改动范围**：包名 / 产品标识改为 Tunara；新增 agent lifecycle、Git 只读审查、Tunara 三栏 UI 外壳、配置持久化、CLI resolver、外部编辑器跳转等本项目特有模块。
- **版权头**：保留 terax 源文件中原有的版权与许可声明。

> 新增代码（Tunara 特有）版权独立，整体仍以兼容方式分发。升级或替换复用部分时，请同步更新本文件与 `LICENSE`。

## Microsoft Fluent Emoji

- **来源**：https://github.com/microsoft/fluentui-emoji
- **来源版本**：`62ecdc0d7ca5c6df32148c169556bc8d3782fca4`
- **许可证**：MIT License
- **当前复用范围**：`src/assets/mascots/` 中 8 个 Flat 风格动物 SVG，用作可选会话吉祥物。
- **许可证副本**：`src/assets/mascots/LICENSE.md`
