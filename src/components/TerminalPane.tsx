import { useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import {
  errorText,
  serialClose,
  serialInput,
  serialOpen,
  serialSetLines,
  termAuthRespond,
  termClose,
  termInput,
  termOpen,
  termResize,
} from "../api";
import {
  currentToken,
  loadHistory,
  rememberCommand,
  suggestCommands,
  type CommandSuggestion,
} from "../lib/commandSuggest";
import { terminalRegistry } from "../lib/terminalRegistry";
import { useAppStore, type PaneState } from "../store";
import type { TermEvent } from "../types";
import { Icon } from "./Icon";

const THEME = {
  background: "#0e1019",
  foreground: "#ffffff",
  cursor: "#3dbe71",
  selectionBackground: "rgba(61, 190, 113, 0.25)",
  black: "#1a1a1a",
  red: "#ff5c5c",
  green: "#3dbe71",
  yellow: "#d7a54a",
  blue: "#6a9fb5",
  magenta: "#b3a4d8",
  cyan: "#56d4dd",
  white: "#d6d6d6",
  brightBlack: "#6e6e6e",
  brightRed: "#ff8a8a",
  brightGreen: "#5fd88c",
  brightYellow: "#e8c879",
  brightBlue: "#8fbccf",
  brightMagenta: "#cbbde8",
  brightCyan: "#8fe3e8",
  brightWhite: "#ffffff",
};

interface Props {
  tabId: string;
  pane: PaneState;
  active: boolean;
}

export function TerminalPane({ tabId, pane, active }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLSpanElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionRef = useRef<string | null>(null);
  const disposedRef = useRef(false);
  const [completions, setCompletions] = useState<CommandSuggestion[]>([]);
  const [completionIndex, setCompletionIndex] = useState(0);
  const [completionPos, setCompletionPos] = useState<{
    left: number;
    top: number;
    above: boolean;
  } | null>(null);
  const completionsRef = useRef<CommandSuggestion[]>([]);
  const completionIndexRef = useRef(0);
  const acceptRef = useRef<(index: number) => void>(() => {});
  const reconnectRef = useRef<() => void>(() => {});
  const searchRef = useRef<SearchAddon | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResult, setSearchResult] = useState({ index: -1, count: 0 });
  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    hasSelection: boolean;
    selection: string;
  } | null>(null);
  const [authPrompt, setAuthPrompt] = useState<{
    promptId: string;
    name: string;
    instructions: string;
    prompts: Array<{ prompt: string; echo: boolean }>;
    values: string[];
  } | null>(null);

  const setPaneStatus = useAppStore((s) => s.setPaneStatus);
  const setPaneSession = useAppStore((s) => s.setPaneSession);
  const setPaneTitle = useAppStore((s) => s.setPaneTitle);
  const setActivePane = useAppStore((s) => s.setActivePane);
  const closePane = useAppStore((s) => s.closePane);
  const profile = useAppStore((s) => s.profiles.find((item) => item.id === pane.profileId));
  const isSerial = profile?.protocol === "serial";
  const isSsh = profile?.protocol === "ssh";
  const serialPrefs = profile?.options.serial ?? null;
  // 串口控制线状态；连接后可在面板顶部实时切换。
  const [lines, setLines] = useState(() => ({
    dtr: serialPrefs?.dtr ?? true,
    rts: serialPrefs?.rts ?? true,
  }));

  // 终端实例与会话生命周期：只随 pane.key 变化重建。
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    disposedRef.current = false;

    const term = new Terminal({
      fontFamily:
        '"Cascadia Mono", "JetBrains Mono", Consolas, "Noto Sans Mono CJK SC", monospace',
      fontSize: 13,
      lineHeight: 1.4,
      cursorBlink: true,
      scrollback: 8000,
      theme: THEME,
      allowTransparency: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const search = new SearchAddon();
    term.loadAddon(search);
    searchRef.current = search;
    search.onDidChangeResults(({ resultIndex, resultCount }) => {
      setSearchResult({ index: resultIndex, count: resultCount });
    });
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;
    terminalRegistry.register(pane.key, term);

    const doFit = () => {
      try {
        fit.fit();
      } catch {
        // 容器尚未布局完成时忽略
      }
      // 串口没有 PTY 尺寸概念，不做远端 resize
      if (sessionRef.current && !isSerial) {
        termResize(sessionRef.current, term.cols, term.rows).catch(() => undefined);
      }
    };
    const raf = window.requestAnimationFrame(doFit);
    const observer = new ResizeObserver(() => doFit());
    observer.observe(host);

    // ---- 命令候选：仅 SSH 会话启用；串口/RDP 没有可用的 shell 输入行 ----
    let trackInput: (data: string) => void = () => {};
    let noteOutput: (text: string) => void = () => {};

    const openSearch = () => {
      setSearchOpen(true);
      window.setTimeout(() => {
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }, 30);
    };

    /** 依据：https://docs.xterminal.cn/reference/shortcuts —— 有选中复制，无选中发送中断。 */
    const handleCopy = (event: KeyboardEvent): boolean | null => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "c") return null;
      if (!term.hasSelection()) return null;
      event.preventDefault();
      void navigator.clipboard.writeText(term.getSelection()).catch(() => undefined);
      return false;
    };

    if (isSsh) {
      const bucket = `${profile.target.user}@${profile.target.host}`;
      let history = loadHistory(bucket);
      let line = "";
      let tokenStart = 0;
      let tokenText = "";
      let outputTail = "";
      let passwordPrompt = false;
      const ghost = ghostRef.current;

      // 推测（官方文档未明确）：Xterminal 的命令历史依赖 Shell Integration 的命令边界，
      // 密码提示不属于命令，因此这里按“密码提示处不写历史”处理，安全优先。
      // 参考命令块/历史文档：https://docs.xterminal.cn/terminal/command-blocks
      noteOutput = (text: string) => {
        outputTail = (outputTail + text).slice(-240);
        passwordPrompt = /(?:password|passphrase|密码)[^\n]{0,60}[:：]\s*$/i.test(outputTail);
      };

      const hideAll = () => {
        completionsRef.current = [];
        completionIndexRef.current = 0;
        setCompletions([]);
        setCompletionIndex(0);
        setCompletionPos(null);
        if (ghost) {
          ghost.textContent = "";
          ghost.style.display = "none";
        }
      };

      const cursorMetrics = () => {
        const screen = host.querySelector(".xterm-screen") as HTMLElement | null;
        const paneEl = host.parentElement;
        if (!screen || !paneEl) return null;
        const screenRect = screen.getBoundingClientRect();
        const paneRect = paneEl.getBoundingClientRect();
        const buffer = term.buffer.active;
        const cellW = screenRect.width / term.cols;
        const cellH = screenRect.height / term.rows;
        const row = buffer.cursorY - buffer.viewportY;
        return {
          paneRect,
          cellW,
          cellH,
          row,
          left: screenRect.left - paneRect.left + buffer.cursorX * cellW,
          top: screenRect.top - paneRect.top + row * cellH,
        };
      };

      const positionGhost = () => {
        if (!ghost) return;
        const metrics = cursorMetrics();
        if (!metrics) return;
        ghost.style.left = `${metrics.left}px`;
        ghost.style.top = `${metrics.top}px`;
      };

      const renderActive = () => {
        if (!ghost) return;
        const item = completionsRef.current[completionIndexRef.current];
        const rest =
          item && item.value.startsWith(tokenText) ? item.value.slice(tokenText.length) : "";
        ghost.textContent = rest;
        ghost.style.display = rest ? "block" : "none";
        if (rest) positionGhost();
      };

      const refresh = () => {
        if (!line.trim()) {
          hideAll();
          return;
        }
        const info = currentToken(line);
        tokenStart = info.start;
        tokenText = info.token;
        const list = suggestCommands(line, history);
        completionsRef.current = list;
        if (list.length === 0) {
          hideAll();
          return;
        }
        const index = Math.min(completionIndexRef.current, list.length - 1);
        completionIndexRef.current = index;
        setCompletions(list);
        setCompletionIndex(index);
        const metrics = cursorMetrics();
        if (metrics) {
          const above = metrics.row > term.rows - 6;
          setCompletionPos({
            left: Math.min(Math.max(8, metrics.left), Math.max(8, metrics.paneRect.width - 320)),
            top: above ? metrics.top - 4 : metrics.top + metrics.cellH,
            above,
          });
        }
        renderActive();
      };

      const accept = (index: number) => {
        const item = completionsRef.current[index];
        if (!item) return;
        // 只回退并替换当前 token，避免覆盖整行。
        const removeCount = Array.from(line.slice(tokenStart)).length;
        const payload = `${"\x7f".repeat(removeCount)}${item.value}`;
        line = line.slice(0, tokenStart) + item.value;
        hideAll();
        const session = sessionRef.current;
        if (session) {
          termInput(session, new TextEncoder().encode(payload)).catch(() => undefined);
        }
      };
      acceptRef.current = accept;

      trackInput = (data: string) => {
        if (data === "\r") {
          const command = line.trim();
          if (command && !passwordPrompt) history = rememberCommand(bucket, command);
          line = "";
          passwordPrompt = false;
          outputTail = "";
          hideAll();
          return;
        }
        if (data === "\t") {
          hideAll();
          return;
        }
        if (data === "\x7f") {
          line = line.slice(0, -1);
          refresh();
          return;
        }
        if (data === "\x03" || data === "\x15") {
          line = "";
          hideAll();
          return;
        }
        // 普通文本（含 IME 上屏的多字符）；控制序列一律视为光标不可跟踪。
        if (!/[\x00-\x1f\x7f]/.test(data)) {
          line += data;
          refresh();
          return;
        }
        hideAll();
      };

      term.attachCustomKeyEventHandler((event) => {
        if (event.type !== "keydown") return true;
        const copied = handleCopy(event);
        if (copied !== null) return copied;
        // 依据：https://docs.xterminal.cn/terminal/search —— Ctrl/Cmd+F 打开终端内搜索。
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
          event.preventDefault();
          openSearch();
          return false;
        }
        const list = completionsRef.current;
        if (event.key === "Escape") {
          if (list.length > 0) {
            event.preventDefault();
            hideAll();
            return false;
          }
          return true;
        }
        if (list.length === 0) return true;
        // 依据：https://docs.xterminal.cn/reference/shortcuts
        // Xterminal 把 Tab 列为 Shell 标准键（命令/文件名补全），终端不拦截。
        if (event.key === "Tab") {
          hideAll();
          return true;
        }
        // 依据：https://docs.xterminal.cn/terminal/command-completion
        // 候选确认键为 Enter（或鼠标点击），只填入、不执行。
        if (event.key === "Enter") {
          event.preventDefault();
          accept(completionIndexRef.current);
          return false;
        }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          if (list.length < 2) {
            // 单条候选时把方向键让给远端 shell 的历史记录
            hideAll();
            return true;
          }
          event.preventDefault();
          const delta = event.key === "ArrowDown" ? 1 : -1;
          const next = (completionIndexRef.current + delta + list.length) % list.length;
          completionIndexRef.current = next;
          setCompletionIndex(next);
          renderActive();
          return false;
        }
        if (
          event.key === "ArrowLeft" ||
          event.key === "ArrowRight" ||
          event.key === "Home" ||
          event.key === "End"
        ) {
          hideAll();
          return true;
        }
        return true;
      });

      // 滚动/回看历史时输入行位置不可靠，直接收起候选，避免浮层错位。
      term.onScroll(() => hideAll());
    } else {
      // 串口没有候选列表，但复制/搜索仍可用。
      term.attachCustomKeyEventHandler((event) => {
        if (event.type !== "keydown") return true;
        const copied = handleCopy(event);
        if (copied !== null) return copied;
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
          event.preventDefault();
          openSearch();
          return false;
        }
        return true;
      });
    }

    /** 按会话配置转换发送换行；串口设备对行尾要求不一。 */
    const encodeForDevice = (text: string): Uint8Array => {
      let out = text;
      if (serialPrefs?.newline === "cr_to_crlf") {
        out = out.replace(/\r\n/g, "\n").replace(/\r/g, "\r\n");
      } else if (serialPrefs?.newline === "lf_to_crlf") {
        out = out.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
      }
      return new TextEncoder().encode(out);
    };

    let seedTimer: number | undefined;
    const dataSub = term.onData((data) => {
      const session = sessionRef.current;
      if (isSerial) {
        const bytes = encodeForDevice(data);
        // 设备自己会回显时不要重复显示，仅在开启本地回显时写入终端
        if (serialPrefs?.local_echo) term.write(new TextDecoder().decode(bytes));
        if (session) {
          serialInput(session, bytes).catch((error) => {
            term.writeln(`\r\n\x1b[31m写入串口失败: ${errorText(error)}\x1b[0m`);
          });
        }
        return;
      }
      trackInput(data);
      if (session) {
        termInput(session, new TextEncoder().encode(data)).catch((error) => {
          term.writeln(`\r\n\x1b[31m写入失败: ${errorText(error)}\x1b[0m`);
        });
      }
    });

    let seeded = false;
    let connecting = false;
    let generation = 0;
    const connect = async () => {
      if (connecting) return;
      connecting = true;
      const current = ++generation;
      const previous = sessionRef.current;
      if (previous) {
        sessionRef.current = null;
        (isSerial ? serialClose(previous) : termClose(previous)).catch(() => undefined);
      }
      setPaneStatus(tabId, pane.key, "connecting", "连接中…");
      const onEvent = (event: TermEvent) => {
        if (current !== generation) return;
        switch (event.type) {
          case "data":
            term.write(event.text);
            noteOutput(event.text);
            break;
          case "state":
            if (event.state.state === "connecting") {
              setPaneStatus(tabId, pane.key, "connecting", "连接中…");
            } else if (event.state.state === "authenticating") {
              setPaneStatus(tabId, pane.key, "connecting", "认证中…");
            } else if (event.state.state === "ready") {
              setAuthPrompt(null);
              setPaneStatus(tabId, pane.key, "ready", "已连接");
              window.setTimeout(doFit, 60);
            } else if (event.state.state === "closed") {
              setAuthPrompt(null);
              setPaneStatus(tabId, pane.key, "closed", event.state.reason ?? "已断开");
            }
            break;
          case "auth_prompt":
            setAuthPrompt({
              promptId: event.prompt_id,
              name: event.name,
              instructions: event.instructions,
              prompts: event.prompts,
              values: event.prompts.map(() => ""),
            });
            setPaneStatus(tabId, pane.key, "connecting", "等待认证输入…");
            break;
          case "title":
            setPaneTitle(tabId, pane.key, event.title);
            break;
          case "exit":
            setAuthPrompt(null);
            setPaneStatus(
              tabId,
              pane.key,
              "closed",
              event.reason ?? (event.code != null ? `进程退出 (${event.code})` : "会话结束"),
            );
            break;
          case "error":
            setAuthPrompt(null);
            setPaneStatus(tabId, pane.key, "error", event.message);
            term.writeln(`\r\n\x1b[31m[${event.code}] ${event.message}\x1b[0m`);
            break;
        }
      };

      try {
        const session = isSerial
          ? await serialOpen(pane.profileId, onEvent)
          : await termOpen(pane.profileId, onEvent);
        if (disposedRef.current) {
          (isSerial ? serialClose(session) : termClose(session)).catch(() => undefined);
          return;
        }
        if (current !== generation) {
          (isSerial ? serialClose(session) : termClose(session)).catch(() => undefined);
          return;
        }
        sessionRef.current = session;
        setPaneSession(tabId, pane.key, session);
        // Docker「进入终端」：把命令写进输入行但不回车，留给用户确认 / 修改。
        if (pane.initialInput && !seeded) {
          seeded = true;
          const seed = pane.initialInput;
          seedTimer = window.setTimeout(() => {
            if (disposedRef.current) return;
            termInput(session, new TextEncoder().encode(seed)).catch(() => undefined);
          }, 400);
        }
      } catch (error) {
        if (disposedRef.current) return;
        setPaneStatus(tabId, pane.key, "error", errorText(error));
        term.writeln(`\r\n\x1b[31m连接失败: ${errorText(error)}\x1b[0m`);
        term.writeln("关闭该面板后重新连接。");
      } finally {
        connecting = false;
      }
    };

    reconnectRef.current = () => {
      if (searchRef.current) searchRef.current.clearDecorations();
      setSearchOpen(false);
      setSearchResult({ index: -1, count: 0 });
      term.reset();
      void connect();
    };
    void connect();

    return () => {
      disposedRef.current = true;
      if (seedTimer) window.clearTimeout(seedTimer);
      window.cancelAnimationFrame(raf);
      observer.disconnect();
      completionsRef.current = [];
      setCompletions([]);
      setCompletionPos(null);
      if (ghostRef.current) {
        ghostRef.current.textContent = "";
        ghostRef.current.style.display = "none";
      }
      dataSub.dispose();
      const session = sessionRef.current;
      sessionRef.current = null;
      if (session) {
        (isSerial ? serialClose(session) : termClose(session)).catch(() => undefined);
      }
      terminalRegistry.unregister(pane.key);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane.key]);

  useEffect(() => {
    if (!active) return;
    const timer = window.setTimeout(() => {
      try {
        fitRef.current?.fit();
      } catch {
        /* ignore */
      }
      termRef.current?.focus();
    }, 30);
    return () => window.clearTimeout(timer);
  }, [active]);

  const showOverlay = pane.status === "connecting" || pane.status === "closed" || pane.status === "error";

  const closeMenu = () => setCtxMenu(null);

  const runSearch = (query: string, direction: 1 | -1, incremental = false) => {
    const search = searchRef.current;
    if (!search) return;
    if (!query) {
      search.clearDecorations();
      setSearchResult({ index: -1, count: 0 });
      return;
    }
    const options = {
      incremental,
      decorations: {
        matchBackground: "#2b3a55",
        activeMatchBackground: "#d19a66",
        matchOverviewRuler: "#2b3a55",
        activeMatchColorOverviewRuler: "#d19a66",
      },
    };
    if (direction === 1) search.findNext(query, options);
    else search.findPrevious(query, options);
  };

  const closeSearch = () => {
    setSearchOpen(false);
    searchRef.current?.clearDecorations();
    setSearchResult({ index: -1, count: 0 });
    termRef.current?.focus();
  };

  const copySelection = () => {
    if (ctxMenu?.selection) {
      void navigator.clipboard.writeText(ctxMenu.selection).catch(() => undefined);
    }
    closeMenu();
  };

  const pasteClipboard = async () => {
    closeMenu();
    try {
      const text = await navigator.clipboard.readText();
      if (text) termRef.current?.paste(text);
    } catch {
      /* 剪贴板不可用时保持静默 */
    }
  };

  const selectAll = () => {
    termRef.current?.selectAll();
    closeMenu();
  };

  const clearScreen = () => {
    termRef.current?.clear();
    closeMenu();
  };

  const splitHere = (direction: "row" | "column") => {
    closeMenu();
    if (!profile) return;
    useAppStore.getState().openProfileInSplit(tabId, profile, direction);
  };

  const askAi = () => {
    const text = ctxMenu?.selection ?? "";
    closeMenu();
    if (text) window.dispatchEvent(new CustomEvent("fanssh:ask-ai", { detail: text }));
  };

  useEffect(() => {
    if (!ctxMenu) return;
    const onDown = () => setCtxMenu(null);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("blur", onDown);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("blur", onDown);
    };
  }, [ctxMenu]);

  // 全局字号快捷键只作用于当前活动面板。
  useEffect(() => {
    const onZoom = (event: Event) => {
      if (!active) return;
      const term = termRef.current;
      if (!term) return;
      const delta = Number((event as CustomEvent<number>).detail) || 0;
      const current = term.options.fontSize ?? 13;
      term.options.fontSize = Math.max(10, Math.min(22, current + delta));
      try {
        fitRef.current?.fit();
      } catch {
        /* ignore */
      }
      term.focus();
    };
    window.addEventListener("fanssh:zoom", onZoom);
    return () => window.removeEventListener("fanssh:zoom", onZoom);
  }, [active]);

  /** 打开终端右键菜单；菜单项顺序参考 Xterminal 终端右键菜单。 */
  const openMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const term = termRef.current;
    const selection = term?.getSelection() ?? "";
    const rect = event.currentTarget.closest(".terminal-pane")?.getBoundingClientRect();
    const left = rect ? event.clientX - rect.left : event.clientX;
    const top = rect ? event.clientY - rect.top : event.clientY;
    setCtxMenu({
      x: Math.max(8, Math.min(left, (rect?.width ?? 400) - 190)),
      y: Math.max(8, Math.min(top, (rect?.height ?? 300) - 280)),
      hasSelection: selection.length > 0,
      selection,
    });
  };

  /** 运行中切换 DTR / RTS，立即作用于当前串口句柄。 */
  const toggleLine = (which: "dtr" | "rts") => {
    const next = { ...lines, [which]: !lines[which] };
    setLines(next);
    const session = sessionRef.current;
    if (session) serialSetLines(session, next.dtr, next.rts).catch(() => undefined);
  };

  const submitAuth = async (responses: string[] | null) => {
    const current = authPrompt;
    if (!current) return;
    setAuthPrompt(null);
    try {
      await termAuthRespond(current.promptId, responses);
    } catch (error) {
      setPaneStatus(tabId, pane.key, "error", errorText(error));
      termRef.current?.writeln(`\r\n\x1b[31m认证提示提交失败: ${errorText(error)}\x1b[0m`);
    }
  };

  const setAuthValue = (index: number, value: string) =>
    setAuthPrompt((prev) =>
      prev
        ? { ...prev, values: prev.values.map((item, i) => (i === index ? value : item)) }
        : prev,
    );

  return (
    <div
      className={`terminal-pane${active ? " is-active" : ""}`}
      onMouseDown={() => setActivePane(tabId, useAppStore.getState().tabs.find((t) => t.id === tabId)?.panes.findIndex((p) => p.key === pane.key) ?? 0)}
    >
      <div className="pane-head">
        <span className={`proto-tag ${profile?.protocol ?? "ssh"}`}>
          {profile?.protocol === "rdp" ? "RDP" : profile?.protocol === "serial" ? "SER" : "SSH"}
        </span>
        <span className="pane-name">{pane.profileName}</span>
        {isSerial && (
          <span className="pane-lines">
            <button
              className={`line-btn${lines.dtr ? " on" : ""}`}
              title="DTR（数据终端就绪）：部分交换机 console 需要拉高才有输出，点击立即切换"
              aria-pressed={lines.dtr}
              disabled={!pane.sessionId}
              onClick={() => toggleLine("dtr")}
            >
              DTR
            </button>
            <button
              className={`line-btn${lines.rts ? " on" : ""}`}
              title="RTS（请求发送）：点击立即切换；启用硬件流控时由驱动接管"
              aria-pressed={lines.rts}
              disabled={!pane.sessionId}
              onClick={() => toggleLine("rts")}
            >
              RTS
            </button>
          </span>
        )}
        <span className="pane-state">
          <span className={`dot st-${pane.status}`} />
          {pane.statusText}
        </span>
      </div>
      <div className="terminal-host" ref={hostRef} onContextMenu={openMenu} />
      {searchOpen && (
        <div className="term-search" role="search">
          <input
            ref={searchInputRef}
            value={searchQuery}
            placeholder="在终端中搜索…"
            spellCheck={false}
            onChange={(event) => {
              const value = event.target.value;
              setSearchQuery(value);
              runSearch(value, 1, true);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                runSearch(searchQuery, event.shiftKey ? -1 : 1);
              } else if (event.key === "Escape") {
                event.preventDefault();
                closeSearch();
              }
            }}
          />
          <span className="term-search-count">
            {searchResult.count > 0 ? `${searchResult.index + 1}/${searchResult.count}` : "0/0"}
          </span>
          <button className="icon-btn" title="上一个" onClick={() => runSearch(searchQuery, -1)}>
            ↑
          </button>
          <button className="icon-btn" title="下一个" onClick={() => runSearch(searchQuery, 1)}>
            ↓
          </button>
          <button className="icon-btn" title="关闭 (Esc)" onClick={closeSearch}>
            ×
          </button>
        </div>
      )}
      {ctxMenu && (
        <div
          className="term-menu"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <button className="term-menu-item" disabled={!ctxMenu.hasSelection} onMouseDown={copySelection}>
            <Icon name="copy" size={13} />
            复制
          </button>
          <button className="term-menu-item" onMouseDown={() => void pasteClipboard()}>
            <Icon name="import" size={13} />
            粘贴
          </button>
          <button className="term-menu-item" onMouseDown={selectAll}>
            <Icon name="check" size={13} />
            全选
          </button>
          <button className="term-menu-item" onMouseDown={clearScreen}>
            <Icon name="trash" size={13} />
            清屏
          </button>
          <div className="term-menu-sep" />
          <button className="term-menu-item" onMouseDown={() => splitHere("row")}>
            <Icon name="split" size={13} />
            水平切分
          </button>
          <button className="term-menu-item" onMouseDown={() => splitHere("column")}>
            <Icon name="panel" size={13} />
            垂直切分
          </button>
          <button
            className="term-menu-item"
            onMouseDown={() => {
              closeMenu();
              reconnectRef.current();
            }}
          >
            <Icon name="refresh" size={13} />
            重新连接
          </button>
          <div className="term-menu-sep" />
          <button className="term-menu-item" disabled={!ctxMenu.hasSelection} onMouseDown={askAi}>
            <Icon name="spark" size={13} />
            问 AI
          </button>
        </div>
      )}
      {isSsh && <span className="ghost-text" ref={ghostRef} />}
      {isSsh && completions.length > 0 && completionPos && (
        <div
          className={`cmd-pop${completionPos.above ? " is-above" : ""}`}
          style={{ left: completionPos.left, top: completionPos.top }}
          role="listbox"
          aria-label="命令候选"
        >
          {completions.map((item, index) => (
            <div
              key={`${item.source}:${item.value}`}
              className={`cmd-item${index === completionIndex ? " is-active" : ""}`}
              role="option"
              aria-selected={index === completionIndex}
              onMouseDown={(event) => {
                event.preventDefault();
                acceptRef.current(index);
              }}
            >
              <span className="cmd-val">{item.value}</span>
              <span className="cmd-detail">{item.detail}</span>
              <span className={`cmd-src src-${item.source}`}>
                {item.source === "history" ? "历史" : item.source === "alias" ? "别名" : "内置"}
              </span>
            </div>
          ))}
        </div>
      )}
      {authPrompt && (
        <div className="auth-mask">
          <div className="auth-dialog" role="dialog" aria-modal="true">
            <div className="auth-head">
              交互认证
              <span className="auth-target">{pane.profileName}</span>
            </div>
            <div className="auth-body">
              {authPrompt.name && <p className="auth-prompt-name">{authPrompt.name}</p>}
              {authPrompt.instructions && (
                <pre className="auth-instructions">{authPrompt.instructions}</pre>
              )}
              {authPrompt.prompts.map((item, index) => (
                <label key={`${index}-${item.prompt}`} className="auth-field">
                  {item.prompt || `第 ${index + 1} 项输入`}
                  <input
                    autoFocus={index === 0}
                    type={item.echo ? "text" : "password"}
                    value={authPrompt.values[index] ?? ""}
                    spellCheck={false}
                    onChange={(event) => setAuthValue(index, event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && authPrompt.values.every(Boolean)) {
                        event.preventDefault();
                        void submitAuth(authPrompt.values);
                      }
                    }}
                  />
                </label>
              ))}
              <p className="muted">
                服务端每一轮提示都需要逐项输入；取消或 120 秒未操作将按认证失败处理。
              </p>
            </div>
            <div className="auth-foot">
              <span className="spacer" />
              <button className="btn-ghost" onClick={() => void submitAuth(null)}>
                取消连接
              </button>
              <button
                className="btn-primary"
                disabled={authPrompt.values.some((value) => !value)}
                onClick={() => void submitAuth(authPrompt.values)}
              >
                提交
              </button>
            </div>
          </div>
        </div>
      )}
      {showOverlay && !authPrompt && (
        <div className={`pane-overlay overlay-${pane.status}`}>
          <div className="ov-card">
            <span className="ov-icon">
              {pane.status === "connecting" ? (
                <span className="spinner" />
              ) : (
                <Icon name={pane.status === "error" ? "alert" : "plug"} size={18} />
              )}
            </span>
            <div className="ov-title">
              {pane.status === "connecting" ? "正在连接" : pane.status === "error" ? "连接失败" : "会话已断开"}
            </div>
            <div className="ov-desc">{pane.statusText}</div>
            {pane.status !== "connecting" && (
              <div className="ov-actions">
                <button className="btn-ghost sm" onClick={() => closePane(tabId, pane.key)}>
                  关闭面板
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
