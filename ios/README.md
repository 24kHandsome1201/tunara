# 好读（iOS 原型）

把长文字变成微信里读得下去的长图。

- **两种入口**：在 App 里粘贴；或在微信、备忘录、Safari 里选中文字，点「分享」→「好读」，分享扩展里直接出图，点「发给微信好友」发回微信。
- **AI 不改原文**：默认只分段、加小标题、标出关键句，并在顶部写一句话要点。「精简」「要点」两档才缩写，图上会注明"AI 精简版 · 原文 N 字 → M 字"，可选附上原文。
- **为微信输出**：每张图 1080 像素宽，单张不超过约 1:4。更长的内容平均拆成几张，微信不勾"原图"也看得清。
- **保留格式**：网页（HTML）、富文本（RTF）、Markdown 的标题、列表、粗体、引用、表格都会保留。
- **AI 来源**：优先用苹果端侧模型（Foundation Models）；手机用不了时，可以在设置里填 OpenAI 兼容接口（通义千问、DeepSeek、Kimi、本地 Ollama 等）。苹果模型调用失败时自动改用这个接口。API Key 只存在本机钥匙串里。
- 核心功能免费，图片不带水印。

## 构建

需要 Xcode 26 或更新版本，以及 [XcodeGen](https://github.com/yonaskolb/XcodeGen)（`brew install xcodegen`）。

```sh
cd ios
xcodegen                     # 由 project.yml 生成 Haodu.xcodeproj
open Haodu.xcodeproj
```

真机运行要在 Xcode 里给 `Haodu` 和 `HaoduShare` 两个 target 选开发团队，并启用 App Group `group.com.tunara.haodu`。

## 测试

```sh
xcodebuild -project Haodu.xcodeproj -scheme Haodu -destination 'platform=iOS Simulator,name=iPhone 17 Pro' test -only-testing:HaoduTests
```

`HaoduUITests` 从 Safari 把 `UITests/article.html` 分享到「好读」，需要先在 `ios/UITests` 目录里运行 `python3 -m http.server 8765`。设置环境变量 `TEST_RUNNER_API_BASE` 和 `TEST_RUNNER_API_MODEL` 后，它还会先在设置页里填好自定义 API。

## 演示用的启动参数（仅 Debug）

- `-fill notice`：把示例文字填进输入框。
- `-demo notice` 或 `-demo article`：直接打开示例的预览；`-demo settings`：打开设置。
- `-demo.length points`：预览默认选「要点」。
- `-demo.dumpDir /tmp/x`：把生成的图片写到这个目录。
