// TerminalArea — 中栏终端区域（M2 静态 mock）
// 含：内容区（shell 输出 + 内联 AI 块）+ 底部状态栏（30px）
// M3 将替换为真实 xterm.js 实例

import { InlineAgentBlock } from "./InlineAgentBlock";
import { type Session } from "./types";

interface TerminalAreaProps {
  session: Session;
  onViewDiff: () => void;
}

/** 终端 mock 行（shell 专属配色） */
interface TermLineProps {
  type: "path" | "prompt" | "cmd" | "output" | "pass" | "error" | "blank";
  children: React.ReactNode;
}

function TermLine({ type, children }: TermLineProps) {
  const colorMap: Record<TermLineProps["type"], string> = {
    path: "var(--c-shell-path)",
    prompt: "var(--c-shell-prompt)",
    cmd: "var(--c-text-primary)",
    output: "var(--c-text-4)",
    pass: "var(--c-shell-prompt)",
    error: "var(--c-shell-error)",
    blank: "transparent",
  };

  return (
    <div
      style={{
        color: colorMap[type],
        fontFamily: "var(--font-mono)",
        fontSize: "var(--fs-body)",
        lineHeight: 1.85,
        whiteSpace: "pre",
      }}
    >
      {children}
    </div>
  );
}

/** 闪烁光标（8×16） */
function BlinkCursor() {
  return (
    <span
      style={{
        display: "inline-block",
        width: 8,
        height: 16,
        background: "var(--c-text-primary)",
        verticalAlign: "middle",
        animation: "blink 1.1s step-start infinite",
        marginLeft: 2,
      }}
    />
  );
}

export function TerminalArea({ session, onViewDiff }: TerminalAreaProps) {
  const now = new Date();
  const timeStr = `${now.getHours().toString().padStart(2, "0")}:${now.getMinutes().toString().padStart(2, "0")}`;

  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        background: "var(--c-bg-white)",
        overflow: "hidden",
        minWidth: 0,
      }}
    >
      {/* 终端内容区（可滚动） */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "20px 24px",
        }}
        className="no-scrollbar"
      >
        {/* mock: 初始路径 + 上一次命令 */}
        <TermLine type="path">{session.dir}/</TermLine>
        <TermLine type="prompt">❯ <span style={{ color: "var(--c-text-primary)" }}>npm test</span></TermLine>
        <TermLine type="blank">{""}</TermLine>
        <TermLine type="output">{'> ' + (session.dir.split("/").pop() ?? "project") + '@1.0.0 test'}</TermLine>
        <TermLine type="output">{'> jest --coverage'}</TermLine>
        <TermLine type="blank">{""}</TermLine>
        <TermLine type="pass"> PASS  src/auth/middleware.test.ts</TermLine>
        <TermLine type="pass"> PASS  src/api/client.test.ts</TermLine>
        <TermLine type="blank">{""}</TermLine>
        <TermLine type="output">{'Test Suites: 2 passed, 2 total'}</TermLine>
        <TermLine type="output">{'Tests:       14 passed, 14 total'}</TermLine>
        <TermLine type="output">{'Coverage:    94.2% | Statements | Branches | Functions | Lines'}</TermLine>
        <TermLine type="blank">{""}</TermLine>

        {/* 内联 AI 回复块 */}
        <InlineAgentBlock
          agent={session.agent}
          agentName={session.agent === "CC" ? "Claude Code" : "Codex"}
          sessionTitle={session.title}
          content={`已完成认证模块重构。主要改动：\n• 将 checkToken 迁移到 Bearer token 验证模式\n• 新增 AuthGuard 类，覆盖 JWT 过期与无效签名场景\n• 补充类型定义，消除 implicit any\n\n测试覆盖率从 87% 提升至 94.2%，所有 14 个测试通过。`}
          applied={true}
          onViewDiff={onViewDiff}
        />

        {/* 后续 shell 操作 */}
        <TermLine type="path">{session.dir}/</TermLine>
        <TermLine type="prompt">❯ <span style={{ color: "var(--c-text-primary)" }}>git status</span></TermLine>
        <TermLine type="blank">{""}</TermLine>
        <TermLine type="output">{'On branch ' + session.branch}</TermLine>
        <TermLine type="output">{'Changes to be committed:'}</TermLine>
        <TermLine type="output">{'  (use "git restore --staged <file>..." to unstage)'}</TermLine>
        {session.changedFiles?.slice(0, 3).map((f) => (
          <TermLine key={f.path} type="pass">
            {"        " + (f.status === "A" ? "new file:   " : "modified:   ") + f.path}
          </TermLine>
        ))}
        <TermLine type="blank">{""}</TermLine>

        {/* 当前输入行 + 闪烁光标 */}
        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "var(--fs-body)",
            lineHeight: 1.85,
            color: "var(--c-shell-prompt)",
            display: "flex",
            alignItems: "center",
          }}
        >
          <span>❯ </span>
          <BlinkCursor />
        </div>
      </div>

      {/* 底部状态栏（30px） */}
      <div
        style={{
          height: "var(--h-statusbar)",
          background: "var(--c-bg-1)",
          borderTop: "1px solid var(--c-border-1)",
          display: "flex",
          alignItems: "center",
          padding: "0 16px",
          gap: 10,
          flexShrink: 0,
        }}
      >
        <span
          style={{
            fontSize: 11.5,
            color: "var(--c-shell-path)",
            fontFamily: "var(--font-mono)",
          }}
        >
          {session.dir}
        </span>
        <span style={{ fontSize: 11.5, color: "var(--c-text-6)", fontFamily: "var(--font-mono)" }}>·</span>
        <span
          style={{
            fontSize: 11.5,
            color: "var(--c-text-4)",
            fontFamily: "var(--font-mono)",
          }}
        >
          ⎇ {session.branch}
        </span>
        <span style={{ fontSize: 11.5, color: "var(--c-text-6)", fontFamily: "var(--font-mono)" }}>·</span>
        <span style={{ fontSize: 11.5, color: "var(--c-text-4)", fontFamily: "var(--font-mono)" }}>
          node 20.11
        </span>
        <span style={{ fontSize: 11.5, color: "var(--c-text-6)", fontFamily: "var(--font-mono)" }}>·</span>
        <span style={{ fontSize: 11.5, color: "var(--c-text-4)", fontFamily: "var(--font-mono)" }}>
          UTF-8
        </span>
        <span
          style={{
            fontSize: 11.5,
            color: "var(--c-text-4)",
            fontFamily: "var(--font-mono)",
            marginLeft: "auto",
          }}
        >
          {timeStr}
        </span>
      </div>
    </div>
  );
}
