import { cleanTerminalText } from "./terminal-utils.ts";
import type { SshConnectSuggestion } from "@/ui/types";

// 高精度低召回:宁可漏报(返回 null),也不误导用户去连错主机。
// 只认最朴素的交互式 ssh 形态:
//   ssh host
//   ssh user@host
//   ssh -p PORT user@host
//   ssh user@host -p PORT
// 任何带 -o / -L / -D / -i / 命令尾参 / 管道 / && / 别名包装 的复杂形态一律拒识。
// 见 docs 决策:detectSshCommand 是「提示而非自动执行」的触发器,误判成本必须趋零。

const SSH_PORT_FLAG = "-p";

/** host 必须像主机名或 IP:字母数字、点、连字符。排除 IPv6([::1])与含特殊字符的目标。 */
const HOST_RE = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;
/** user@host 中的 user:不含 @ / 空白 / shell 元字符。 */
const USER_RE = /^[A-Za-z0-9._-]+$/;

function parsePort(token: string): number | null {
  if (!/^[0-9]+$/.test(token)) return null;
  const n = Number(token);
  return n >= 1 && n <= 65535 ? n : null;
}

/**
 * 检测一行已提交的命令是否是一条可识别的 `ssh` 连接命令。
 * 命中返回连接目标(只含 host/user/port,绝不含凭证);否则返回 null
 * (包括无法稳妥解析的复杂命令)。
 */
export function detectSshCommand(commandLine: string): SshConnectSuggestion | null {
  const cleaned = cleanTerminalText(commandLine).trim();
  if (!cleaned) return null;

  // 整行不能含 shell 组合/重定向/管道——一旦出现就放弃,无法稳妥定位「当前在连哪台」。
  if (/[|&;<>$`(){}*?\\]/.test(cleaned)) return null;
  if (cleaned.includes("&&") || cleaned.includes("||")) return null;

  const tokens = cleaned.split(/\s+/);
  if (tokens[0] !== "ssh") return null;
  const args = tokens.slice(1);
  if (args.length === 0) return null;

  let port: number | undefined;
  let target: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const tok = args[i];
    if (tok === SSH_PORT_FLAG) {
      // -p PORT
      const next = args[i + 1];
      if (next === undefined) return null;
      const p = parsePort(next);
      if (p === null) return null;
      if (port !== undefined) return null; // 重复 -p,异常,放弃
      port = p;
      i++;
      continue;
    }
    if (/^-p[0-9]+$/.test(tok)) {
      // -pPORT(粘连写法)
      const p = parsePort(tok.slice(2));
      if (p === null) return null;
      if (port !== undefined) return null;
      port = p;
      continue;
    }
    if (tok.startsWith("-")) {
      // 任何其它 flag(-o/-L/-i/-v/-N/-T...):无法稳妥解析,放弃。
      return null;
    }
    // 非 flag 位置参数:第一个当作 [user@]host,出现第二个则说明带了远程命令,放弃。
    if (target !== undefined) return null;
    target = tok;
  }

  if (target === undefined) return null;

  let user: string | undefined;
  let host = target;
  const at = target.indexOf("@");
  if (at >= 0) {
    user = target.slice(0, at);
    host = target.slice(at + 1);
    if (!USER_RE.test(user)) return null;
  }
  if (!HOST_RE.test(host)) return null;

  return { host, ...(user ? { user } : {}), ...(port ? { port } : {}) };
}
