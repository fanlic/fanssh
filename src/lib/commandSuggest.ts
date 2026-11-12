/**
 * 纯本地命令建议：会话历史（按 host+user 分桶）+ 内置常用命令/参数。
 * 不做逐键 AI 请求，也不猜测路径。
 */

const HISTORY_LIMIT = 200;
const STORAGE_PREFIX = "fanssh.cmd-history:";

/** 内置命令与常见参数，仅补齐命令本身与固定子命令，不含路径。 */
const BUILTIN: [string, ...string[]][] = [
  ["ls", "-la", "-lh", "-l", "-a"],
  ["cd", "-"],
  ["pwd"],
  ["cat"],
  ["tail", "-f", "-n 100"],
  ["head", "-n 20"],
  ["less"],
  ["grep", "-rn", "-i", "-E"],
  ["find"],
  ["df", "-h"],
  ["du", "-sh", "-h"],
  ["free", "-h"],
  ["top"],
  ["htop"],
  ["ps", "aux", "-ef"],
  ["systemctl", "status ", "restart ", "start ", "stop "],
  ["journalctl", "-xe", "-f", "-u "],
  ["docker", "ps", "images", "logs ", "exec -it "],
  ["kubectl", "get pods", "get svc", "logs "],
  ["git", "status", "pull", "push", "log --oneline"],
  ["tar", "-xzvf", "-czvf"],
  ["chmod"],
  ["chown"],
  ["ss", "-tulnp"],
  ["netstat", "-tulnp"],
  ["curl"],
  ["wget"],
  ["vim"],
  ["nano"],
  ["sudo"],
  ["apt", "update", "upgrade", "install "],
  ["yum", "install "],
  ["dnf", "install "],
];

function builtinLines(): string[] {
  const lines: string[] = [];
  for (const [command, ...args] of BUILTIN) {
    lines.push(command);
    for (const arg of args) {
      lines.push(`${command} ${arg}`);
    }
  }
  return lines;
}

const BUILTIN_LINES = builtinLines();

export function loadHistory(bucket: string): string[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + bucket);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string").slice(0, HISTORY_LIMIT);
  } catch {
    return [];
  }
}

/** 记录一条已提交命令，最近使用排在前面。 */
export function rememberCommand(bucket: string, command: string): string[] {
  const trimmed = command.trim();
  if (!trimmed) return loadHistory(bucket);
  const next = [trimmed, ...loadHistory(bucket).filter((item) => item !== trimmed)].slice(
    0,
    HISTORY_LIMIT,
  );
  try {
    window.localStorage.setItem(STORAGE_PREFIX + bucket, JSON.stringify(next));
  } catch {
    // 隐私模式下写入失败时只保留内存结果
  }
  return next;
}

/**
 * 返回补全整行（含已输入部分），没有匹配时返回 null。
 * 只做前缀补全，避免无法计算后缀的模糊匹配。
 */
export function suggestCommand(line: string, history: string[]): string | null {
  if (!line.trim() || line.endsWith(" ")) return null;
  for (const candidate of history) {
    if (candidate.length > line.length && candidate.startsWith(line)) return candidate;
  }
  for (const candidate of BUILTIN_LINES) {
    if (candidate.length > line.length && candidate.startsWith(line)) return candidate;
  }
  return null;
}
