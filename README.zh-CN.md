<p align="center">
  <img src="assets/brand/tunara-app-icon-preview-128.png" width="120" alt="Tunara">
</p>

<h1 align="center">Tunara</h1>

<p align="center">
  轻量好看的 AI 原生侧栏终端
</p>

<p align="center">
  <a href="README.md">English</a> · <strong>简体中文</strong>
</p>

<p align="center">
  <a href="https://github.com/24kHandsome1201/tunara/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/24kHandsome1201/tunara?label=release"></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-Apache--2.0-blue"></a>
  <img alt="Platforms" src="https://img.shields.io/badge/macOS-Apple%20Silicon-black">
  <img alt="Built with" src="https://img.shields.io/badge/Tauri-2.x-24C8DB">
</p>

---

<p align="center">
  <img src="assets/screenshots/tunara-split-agents.jpg" width="960" alt="Tunara 在分栏终端工作区里同时运行 Claude Code 和 Codex">
</p>

Tunara 是一个终端。左边侧栏按项目和机器分组你的会话，agent 需要你时你会知道。右边随手看一眼它改了什么。

## 安装

### 从 Release 下载（推荐）

到 [Releases](https://github.com/24kHandsome1201/tunara/releases/latest) 下载最新版的 `.dmg`。普通用户请用默认的 `Tunara_<version>_aarch64.dmg` 直接安装；当前仅支持签名的 macOS Apple Silicon 构建。

Release 页面也可能带 `Tunara_<version>_aarch64-legacy.dmg`。这是保留旧行为的手动安装包，用于 Apple 公证延迟时兜底；它不用于 Homebrew 或应用内自动更新，首次打开可能需要在 Finder 里右键打开。

### Homebrew

```bash
brew tap 24kHandsome1201/tunara https://github.com/24kHandsome1201/tunara
brew install --cask tunara
```

可在设置中检查、安装更新并重启；Homebrew 用户也可运行 `brew upgrade --cask tunara`。

## 它不是什么

不是 Warp 替代品。没有内置 AI 聊天。不会替你 commit 或 push。没有账号，没有遥测。

完整能力清单见 [docs/FEATURES.md](docs/FEATURES.md)。

## 贡献

欢迎 Bug 修复、新 agent 识别、新终端配色。非小改动请先开 Issue 讨论。详见 [CONTRIBUTING](CONTRIBUTING.md) 和 [CODE_OF_CONDUCT](CODE_OF_CONDUCT.md)。

安全问题请走 [SECURITY](SECURITY.md) 里说的私有渠道，不要直接开 Issue。

## 许可证

[Apache-2.0](LICENSE)
