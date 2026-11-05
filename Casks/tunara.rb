cask "tunara" do
  version "3.1.4"
  sha256 "dcafeee05618e410214d2282597e4c82417b063b45b17c7ec1b425631c3a9bde"

  url "https://github.com/24kHandsome1201/tunara/releases/download/v#{version}/Tunara_#{version}_aarch64.dmg"
  name "Tunara"
  desc "Terminal with an intelligent session sidebar"
  homepage "https://github.com/24kHandsome1201/tunara"

  # auto_updates: 应用内 tauri_plugin_updater 已接管升级，
  # 设为 true 让 brew 不再提示 brew upgrade，避免双重升级冲突。
  auto_updates true
  depends_on macos: :ventura

  app "Tunara.app"

  # 沙盒限制：Tunara 需要访问终端 / PTY / 文件系统，不加 sandbox。
  zap trash: [
    "~/Library/Application Support/dev.tunara.app",
    "~/Library/Caches/dev.tunara.app",
    "~/Library/Preferences/dev.tunara.app.plist",
    "~/Library/Saved Application State/dev.tunara.app.savedState",
  ]
end
