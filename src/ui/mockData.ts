// 静态 mock 数据 — 按设计稿示例
import { type Session, type Notification } from "./types";

export const MOCK_SESSIONS: Session[] = [
  // ~/orbit 组 (3个)
  {
    id: "s1",
    title: "重构认证模块",
    dir: "~/orbit",
    branch: "feat/auth-refactor",
    agent: "CC",
    status: "running",
    duration: "2m",
    progress: 45,
    diffSummary: "3 文件 · +26 −6",
    changedFiles: [
      {
        path: "src/auth/middleware.ts",
        status: "M",
        added: 18,
        removed: 4,
        patch: `@@ -12,7 +12,21 @@
-function checkToken(req) {
-  return req.headers.auth;
+function checkToken(req: Request): string | null {
+  const header = req.headers.get('authorization');
+  if (!header?.startsWith('Bearer ')) return null;
+  return header.slice(7);
 }`,
      },
      {
        path: "src/auth/types.ts",
        status: "M",
        added: 5,
        removed: 2,
      },
      {
        path: "src/auth/guards.ts",
        status: "A",
        added: 3,
        removed: 0,
      },
    ],
    commitMsg: "refactor(auth): 迁移到 Bearer token 验证",
  },
  {
    id: "s2",
    title: "修复 API 超时问题",
    dir: "~/orbit",
    branch: "fix/api-timeout",
    agent: "CX",
    status: "fresh",
    duration: "8m",
    diffSummary: "1 文件 · +4 −1",
    changedFiles: [
      {
        path: "src/api/client.ts",
        status: "M",
        added: 4,
        removed: 1,
      },
    ],
    commitMsg: "fix(api): 增加请求超时与重试逻辑",
  },
  {
    id: "s3",
    title: "更新依赖版本",
    dir: "~/orbit",
    branch: "chore/deps-update",
    agent: "CC",
    status: "done",
    duration: "15m",
  },
  // ~/web 组 (1个)
  {
    id: "s4",
    title: "落地页重设计",
    dir: "~/web",
    branch: "design/landing-v2",
    agent: "CX",
    status: "running",
    duration: "5m",
    progress: 70,
    diffSummary: "5 文件 · +102 −38",
    changedFiles: [
      {
        path: "src/pages/index.tsx",
        status: "M",
        added: 80,
        removed: 30,
      },
      {
        path: "src/styles/landing.css",
        status: "M",
        added: 22,
        removed: 8,
      },
    ],
  },
  // ~/infra 组 (1个)
  {
    id: "s5",
    title: "Docker 配置优化",
    dir: "~/infra",
    branch: "ops/docker-optimize",
    agent: "CC",
    status: "done",
    duration: "23m",
  },
];

/** 按目录分组 */
export function groupSessionsByDir(sessions: Session[]): Map<string, Session[]> {
  const map = new Map<string, Session[]>();
  for (const s of sessions) {
    const group = map.get(s.dir) ?? [];
    group.push(s);
    map.set(s.dir, group);
  }
  return map;
}

export const MOCK_NOTIFICATIONS: Notification[] = [
  {
    id: "n1",
    type: "error",
    message: "任务运行失败：依赖安装超时",
    sessionTitle: "更新依赖版本",
  },
  {
    id: "n2",
    type: "success",
    message: "已完成：修复 API 超时问题",
    sessionTitle: "修复 API 超时问题",
  },
];
