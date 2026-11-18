/**
 * 纯本地命令候选：会话历史（按 user@host 分桶）+ 内置常用命令/参数 + 少量别名。
 * 只补当前 token，不猜路径、不请求网络。
 */

const HISTORY_LIMIT = 200;
const STORAGE_PREFIX = "fanssh.cmd-history:";

export type SuggestionSource = "history" | "builtin" | "alias";

export interface CommandSuggestion {
  /** 替换当前 token 的文本，可能包含空格（如别名展开）。 */
  value: string;
  source: SuggestionSource;
  detail: string;
}

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

const BUILTIN_DESC: Record<string, string> = {
  ls: "列出目录",
  cd: "切换目录",
  pwd: "当前路径",
  cat: "查看文件",
  tail: "查看末尾",
  head: "查看开头",
  less: "分页查看",
  grep: "文本搜索",
  find: "查找文件",
  df: "磁盘空间",
  du: "目录占用",
  free: "内存使用",
  top: "进程监控",
  htop: "进程监控",
  ps: "进程列表",
  systemctl: "服务管理",
  journalctl: "系统日志",
  docker: "容器管理",
  kubectl: "K8s 管理",
  git: "版本控制",
  tar: "归档",
  chmod: "权限",
  chown: "属主",
  ss: "套接字",
  netstat: "网络连接",
  curl: "HTTP 请求",
  wget: "下载",
  vim: "编辑器",
  nano: "编辑器",
  sudo: "提权执行",
  apt: "Debian 包管理",
  yum: "RHEL 包管理",
  dnf: "Fedora 包管理",
};

/** 少量常用别名；接受后替换当前 token。 */
const ALIASES: [string, string][] = [
  ["ll", "ls -la"],
  ["la", "ls -la"],
  ["gst", "git status"],
  ["dc", "docker compose"],
  ["k", "kubectl"],
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
    return parsed
      .filter((item): item is string => typeof item === "string")
      .slice(0, HISTORY_LIMIT);
  } catch {
    return [];
  }
}

/** 记录一条已提交命令（整行原样，含 sudo），最近使用排在前面。 */
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
    // 隐私模式写入失败时只保留内存结果
  }
  return next;
}

/** 当前行的最后一个 token 及其起始位置。 */
export function currentToken(line: string): { prefix: string; token: string; start: number } {
  const start = line.lastIndexOf(" ") + 1;
  return { prefix: line.slice(0, start), token: line.slice(start), start };
}

function collect(
  lines: string[],
  prefix: string,
  token: string,
  source: SuggestionSource,
  detail: (next: string) => string,
  out: CommandSuggestion[],
) {
  for (const line of lines) {
    const normalized = line.replace(/\s+/g, " ");
    if (!normalized.startsWith(prefix)) continue;
    const rest = normalized.slice(prefix.length);
    const next = rest.split(" ")[0];
    if (!next || next === token || !next.startsWith(token)) continue;
    out.push({ value: next, source, detail: detail(next) });
  }
}

/**
 * 返回最多 `limit` 条候选：别名 → 历史（最近优先）→ 内置。
 * 只匹配当前 token 前缀，重复值按优先级去重。
 */
export function suggestCommands(
  line: string,
  history: string[],
  limit = 8,
): CommandSuggestion[] {
  if (!line.trim()) return [];
  const { prefix, token } = currentToken(line);
  const matchPrefix = prefix.replace(/\s+/g, " ");
  const out: CommandSuggestion[] = [];

  if (token) {
    for (const [name, expansion] of ALIASES) {
      if (name !== token && name.startsWith(token)) {
        out.push({ value: expansion, source: "alias", detail: `别名 → ${expansion}` });
      }
    }
  }

  collect(history, matchPrefix, token, "history", () => "历史命令", out);
  collect(BUILTIN_LINES, matchPrefix, token, "builtin", (next) => {
    if (prefix) return "内置参数";
    return BUILTIN_DESC[next] ?? "内置命令";
  }, out);

  const seen = new Set<string>();
  const unique: CommandSuggestion[] = [];
  for (const item of out) {
    if (seen.has(item.value)) continue;
    seen.add(item.value);
    unique.push(item);
    if (unique.length >= limit) break;
  }
  return unique;
}
