cask "tunara" do
  version "1.9.0"
  sha256 "2f4becaf388efc48173e4936cd373c38ec250258b5e385e4a7c410af2e5fea8c"

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
