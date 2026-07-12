# M2 macOS 原生窗口关闭草稿门验收

日期：2026-07-13（Asia/Shanghai）  
基线：`db57e8ba2e06b710f833e15f1e6619eb0a68d4f6`  
产品路径：隔离的 optimized release Tauri app、真实 macOS WebView、真实本地文件，以及由 macOS Accessibility 对红色关闭按钮执行的 `AXPress`。

## 结论

原生窗口关闭草稿门通过。dirty 草稿会阻止原生关闭并显示警告；取消后窗口、编辑器与草稿保持；明确丢弃后才写 workspace snapshot 并走既定隐藏流程；重新打开后的 clean 编辑器不残留警告，原生关闭可直接隐藏。用户确认前 snapshot 文件 SHA-256 不变，丢弃后和 clean 关闭时均独立推进。

## 真实流程与结果

1. 隔离 app 从 workspace snapshot 恢复一个真实本地会话，WebView 打开 `/private/tmp/.../draft.md` 并将 textarea 改为 `unsaved native close draft\n`，不点击 Save。
2. runner 等待启动期 PTY/workspace 写入连续 20 次采样稳定，再记录 close 前 store SHA-256。
3. 第一次对 macOS 红色关闭按钮执行 `AXPress`：警告真实可见；WebView 点击取消后，窗口仍可见，textarea 仍连接，未保存草稿完全保留。close 前与取消后 store SHA-256 同为 `0c14dba9...9bb2b`。
4. 第二次执行 `AXPress`：警告再次可见；WebView 明确点击丢弃。窗口随后隐藏，store SHA-256 变为 `717582d5...f5757`，证明确认后才进入 close-time persistence。
5. 用产品既定 Reopen 路径重新显示同一窗口。先前发现的真实缺陷是丢弃后 `closeConfirm` 未清除，导致重开残留旧警告；最小修复在继续 deferred close 前清除该状态。
6. 修复后的重开窗口无警告且编辑器为 clean；第三次执行红色关闭按钮 `AXPress` 不触发 guard，窗口直接隐藏，store SHA-256 再变为 `5153f2c5...471ec`。
7. 应用外读取真实文件仍为 `saved baseline`，未保存草稿没有错误进入磁盘。

## 证据边界

- 原生触发来自 macOS `System Events` 对真实窗口红色关闭按钮的 `AXPress`，不是 DOM close、Tauri mock 或源码正则。
- runner 独立读取窗口计数、真实文件与 plugin-store 文件；WebView 只布置草稿、观察产品警告并点击产品的取消/丢弃按钮。
- 首 PTY 冷启动性能不在本批范围，仍保持未完成。

原始结果：[result.json](./raw/m2-native-close-macos-2026-07-13/result.json)。
