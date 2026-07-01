// 全局 Agent 活动条（GlobalAgentBar）的分组逻辑。纯函数，方便 node 测试。
//
// 三组的语义（对应 .design/global-agent-bar.html 原型的 wait/run/done）：
// - wait      agent 进程存活且 activity 为 idle —— 完成一轮、prompt 就绪，等用户输入。
// - run       agent 进程存活且 busy（starting/running）。
// - resumable agent 已退出，但留下了可执行的 resume 命令（CC/CX，见 agent-resume.ts）。
import type { Session } from "../../ui/types.ts";
import { isAgentActivityBusy } from "../terminal/lib/agent-lifecycle.ts";
import { buildAgentResumeCommand } from "../terminal/lib/agent-resume.ts";

export interface AgentActivityGroups {
  wait: Session[];
  run: Session[];
  /** [session, resume 命令] —— 命令由 buildAgentResumeCommand 保证非空。 */
  resumable: Array<{ session: Session; resumeCommand: string }>;
  total: number;
}

export function groupAgentActivity(sessions: readonly Session[]): AgentActivityGroups {
  const wait: Session[] = [];
  const run: Session[] = [];
  const resumable: AgentActivityGroups["resumable"] = [];
  for (const session of sessions) {
    if (session.agent) {
      if (isAgentActivityBusy(session.agentActivity)) run.push(session);
      else wait.push(session);
      continue;
    }
    const resumeCommand = buildAgentResumeCommand(session.agentResume);
    if (resumeCommand) resumable.push({ session, resumeCommand });
  }
  return { wait, run, resumable, total: wait.length + run.length + resumable.length };
}
