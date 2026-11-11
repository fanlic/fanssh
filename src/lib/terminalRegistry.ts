import type { Terminal } from "@xterm/xterm";

/**
 * xterm 实例登记表。
 * store 里只保存可序列化的会话状态，真正的 Terminal 对象放在这里，
 * 避免把大量对象塞进 zustand 引发无谓渲染。
 */
class TerminalRegistry {
  private terms = new Map<string, Terminal>();

  register(paneKey: string, term: Terminal) {
    this.terms.set(paneKey, term);
  }

  unregister(paneKey: string) {
    this.terms.delete(paneKey);
  }

  get(paneKey: string): Terminal | undefined {
    return this.terms.get(paneKey);
  }

  /** 终端中当前选中的文本，没有选中返回空串。 */
  selection(paneKey: string): string {
    return this.terms.get(paneKey)?.getSelection() ?? "";
  }

  /** 最近若干行输出，作为 AI 分析上下文。 */
  tail(paneKey: string, lines = 60): string {
    const term = this.terms.get(paneKey);
    if (!term) return "";
    const buffer = term.buffer.active;
    const end = buffer.baseY + buffer.cursorY;
    const start = Math.max(0, end - lines);
    const out: string[] = [];
    for (let i = start; i <= end; i += 1) {
      out.push(buffer.getLine(i)?.translateToString(true) ?? "");
    }
    return out.join("\n");
  }

  /** 向终端写入文本（AI 生成命令确认后插入）。 */
  insert(paneKey: string, text: string, execute: boolean) {
    const term = this.terms.get(paneKey);
    if (!term) return false;
    term.focus();
    // 用 bracketed paste 语义写入，避免多行命令被 shell 立即执行。
    term.paste(execute ? text : text.replace(/\n$/, ""));
    if (execute) {
      term.paste("\r");
    }
    return true;
  }
}

export const terminalRegistry = new TerminalRegistry();
