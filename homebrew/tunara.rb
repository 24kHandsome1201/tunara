cask "tunara" do
  version "1.7.2"
  sha256 "5aeaa8b1b5683007b9ce0290bacd7840802a3c506f37af0d4b0ccb1c14083ac4"

  url "https://github.com/24kHandsome1201/tunara/releases/download/v#{version}/Tunara_#{version}_aarch64.dmg"
  name "Tunara"
  desc "Terminal with an intelligent session sidebar"
  homepage "https://github.com/24kHandsome1201/tunara"

  # auto_updates: 应用内 tauri_plugin_updater 已接管升级，
  # 设为 true 让 brew 不再提示 brew upgrade，避免双重升级冲突。
  auto_updates true

  app "Tunara.app"

  # 沙盒限制：Tunara 需要访问终端 / PTY / 文件系统，不加 sandbox。
  zap trash: [
    "~/Library/Application Support/dev.tunara.app",
    "~/Library/Preferences/dev.tunara.app.plist",
    "~/Library/Saved Application State/dev.tunara.app.savedState",
    "~/Library/Caches/dev.tunara.app",
  ]
end
