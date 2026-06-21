cask "conduit" do
  version "1.0.2"
  sha256 "PLACEHOLDER_SHA256"

  url "https://github.com/mawei/conduit/releases/download/v#{version}/Conduit_#{version}_aarch64.dmg"
  name "Conduit"
  desc "Terminal with an intelligent session sidebar"
  homepage "https://github.com/mawei/conduit"

  # auto_updates: 应用内 tauri_plugin_updater 已接管升级，
  # 设为 true 让 brew 不再提示 brew upgrade，避免双重升级冲突。
  auto_updates true

  app "Conduit.app"

  # 沙盒限制：Conduit 需要访问终端 / PTY / 文件系统，不加 sandbox。
  zap trash: [
    "~/Library/Application Support/com.conduit.app",
    "~/Library/Preferences/com.conduit.app.plist",
    "~/Library/Saved Application State/com.conduit.app.savedState",
    "~/Library/Caches/com.conduit.app",
  ]
end
