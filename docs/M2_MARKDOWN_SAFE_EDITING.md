# M2 Markdown 阅读与单文件安全轻编辑实施规格

## 唯一目标与用户价值

用户可以在当前 workspace 的右侧 surface 阅读 Markdown/MDX，并安全修改一个小型本地或 SSH 文本文件，不离开终端上下文，不把 Tunara 变成 IDE。复杂编辑仍显著引导到外部编辑器。

## Scope

1. Markdown/MDX 阅读补齐标题目录、锚点、页内查找、代码块、表格和源码/预览切换。
2. 单文件编辑只接受完整读取、UTF-8、不含 NUL、不超过 256 KiB 的普通文件。
3. 读取返回内容 fingerprint；每次保存必须提交原 fingerprint，与当前磁盘/远端内容不一致时返回结构化 conflict。
4. 本地写入使用同目录 `create_new` 临时文件，保留原权限，flush 后再原子 rename；任何失败清理临时文件。
5. SSH 写入使用同样的 fingerprint 合同、同目录临时文件、权限保留和原子 rename；断线/超时不得损坏原文件。
6. 编辑器提供行号、查找、撤销/重做、基础语法高亮、未保存标记、保存反馈和显著外部编辑器逃生口。

## Non-scope

- 多文件 tab、工程级编辑、LSP、补全、格式化、重构、调试和自动保存。
- 新建、删除、重命名或覆盖 symlink 目标。
- 强行覆盖冲突。M2 首版只提供重新读取和复制本地缓冲，不做自动 merge。
- 让 Agent 直接修改未保存的编辑缓冲。

## 数据与错误合同

```text
EditableRead = { content, size, fingerprint, transport, path }
Save(expectedFingerprint, content)
  -> Saved { fingerprint, size }
  -> Conflict { currentFingerprint }
  -> Unsupported | PermissionDenied | Disconnected | Failed
```

- fingerprint 是不透明内容标识，UI 不推断其算法。
- `Conflict` 不是 toast-only 错误；编辑 surface 保留用户缓冲并显示持久冲突栏。
- `Saved` 返回的新 fingerprint 成为下一次保存基线。
- binary、截断预览、非 UTF-8、过大文件和 symlink 不产生 fingerprint，因此不能保存。

## 界面方向

- **Visual thesis**：暖纸面工作台，终端仍是主表面，编辑器是右侧一张克制的工作纸，不复制 IDE chrome。
- **Content plan**：顶部先表达 workspace/path 与未保存状态，中部是唯一文档，底部只显示冲突/保存结果与必要动作。
- **Interaction thesis**：保存成功只做短暂静态反馈；冲突栏保持不消失；源码/预览切换不改变滚动上下文。

## 安全与生命周期

- 编辑缓冲只在前端内存，未保存文本不进入 workspace snapshot、timeline、toast 或日志。
- 关闭编辑 surface、切换 session/worktree 或退出 app 时，有脏缓冲必须明确确认。
- 文件监听只作为早期提示；保存前 fingerprint 复查才是权威冲突门。
- 动态 import 编辑器/Markdown 重依赖，不进入首屏终端启动关键路径。

## 验收与完成门

- 本地与 SSH 各用普通 Markdown 和配置文件完成读取、修改、保存、重开验证。
- 两端都用同尺寸不同内容的外部改写触发 conflict，可同时保持 mtime，原文件与本地缓冲均不丢失。
- SSH 在临时文件上传中、权限复制中、rename 前和断线时都有故障注入，原文件完整、权限不变、临时文件可清理。
- 256 KiB+ 文本、binary、非 UTF-8 和 symlink 继续只读，显著保留外部编辑器入口。
- 本地/SSH、中英文、640×480 和宽窗都通过键盘、焦点、冲突和溢出验收。
- 冷启动不加载编辑器代码，首 PTY 可输入不超过 M1 中位数 1.639s 的 1.1 倍。
