<p align="center">
  <img src="assets/brand/tunara-app-icon-preview-128.png" width="120" alt="Tunara">
</p>

<h1 align="center">Tunara</h1>

<p align="center">
  A lightweight, good-looking, AI-native sidebar terminal.
</p>

<p align="center">
  <strong>English</strong> · <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="https://github.com/24kHandsome1201/tunara/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/24kHandsome1201/tunara?label=release"></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-Apache--2.0-blue"></a>
  <img alt="Platforms" src="https://img.shields.io/badge/macOS-Apple%20Silicon-black">
  <img alt="Built with" src="https://img.shields.io/badge/Tauri-2.x-24C8DB">
</p>

---

<p align="center">
  <img src="assets/screenshots/tunara-split-agents.jpg" width="960" alt="Tunara running Claude Code and Codex in a split terminal workspace">
</p>

Tunara is a terminal. The sidebar on the left groups your sessions by project and by machine, and you see when an agent needs you. Glance right to see what it changed.

## Install

### From a Release (recommended)

Grab the latest `.dmg` from [Releases](https://github.com/24kHandsome1201/tunara/releases/latest). Use the normal `Tunara_<version>_aarch64.dmg` for direct install. Only signed macOS Apple Silicon builds are supported for the direct installer.

Release pages may also include `Tunara_<version>_aarch64-legacy.dmg`. That is the previous manual install path for cases where Apple notarization is delayed; it is not used by Homebrew or the in-app updater and may require right-click Open in Finder.

### Homebrew

```bash
brew tap 24kHandsome1201/tunara https://github.com/24kHandsome1201/tunara
brew install --cask tunara
```

Use Settings to check, install, and restart into a new release. Homebrew users can also update with `brew upgrade --cask tunara`.

## What it is not

Not a Warp replacement. No built-in AI chat. It does not commit or push for you. No account, no telemetry.

The full capability list is in [docs/FEATURES.md](docs/FEATURES.md).

## Contributing

Bug fixes, new agent detection, and new terminal themes are welcome. For anything larger, please open an Issue first. See [CONTRIBUTING](CONTRIBUTING.md) and [CODE_OF_CONDUCT](CODE_OF_CONDUCT.md).

Security issues go through the private channel described in [SECURITY](SECURITY.md) — please do not open a public Issue.

## License

[Apache-2.0](LICENSE)
