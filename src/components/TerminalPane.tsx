import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import {
  errorText,
  serialClose,
  serialInput,
  serialOpen,
  serialSetLines,
  termClose,
  termInput,
  termOpen,
  termResize,
} from "../api";
import { loadHistory, rememberCommand, suggestCommand } from "../lib/commandSuggest";
import { terminalRegistry } from "../lib/terminalRegistry";
import { useAppStore, type PaneState } from "../store";
import type { TermEvent } from "../types";
import { Icon } from "./Icon";

const THEME = {
  background: "#0d1117",
  foreground: "#e6edf3",
  cursor: "#7ee787",
  selectionBackground: "#264f78",
  black: "#484f58",
  red: "#ff7b72",
  green: "#3fb950",
  yellow: "#d29922",
  blue: "#79c0ff",
  magenta: "#bc8cff",
  cyan: "#39c5cf",
  white: "#b1bac4",
  brightBlack: "#6e7681",
  brightRed: "#ffa198",
  brightGreen: "#56d364",
  brightYellow: "#e3b341",
  brightBlue: "#a5d6ff",
  brightMagenta: "#d2a8ff",
  brightCyan: "#56d4dd",
  brightWhite: "#f0f6fc",
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

  const setPaneStatus = useAppStore((s) => s.setPaneStatus);
  const setPaneSession = useAppStore((s) => s.setPaneSession);
  const setPaneTitle = useAppStore((s) => s.setPaneTitle);
  const setActivePane = useAppStore((s) => s.setActivePane);
  const closePane = useAppStore((s) => s.closePane);
  const profile = useAppStore((s) => s.profiles.find((item) => item.id === pane.profileId));
  const isSerial = profile?.protocol === "serial";
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

    // ---- 内联命令建议（ghost text）：仅 SSH 会话启用；串口没有 shell ----
    let hideSuggestion: () => void = () => {};
    let trackInput: (data: string) => void = () => {};

    if (!isSerial) {
      const bucket = profile ? `${profile.target.user}@${profile.target.host}` : pane.profileId;
      let history = loadHistory(bucket);
      let line = "";
      let suggestion = "";
      const ghost = ghostRef.current;

      hideSuggestion = () => {
        suggestion = "";
        if (ghost) {
          ghost.textContent = "";
          ghost.style.display = "none";
        }
      };

      const positionSuggestion = () => {
        if (!ghost) return;
        const screen = host.querySelector(".xterm-screen") as HTMLElement | null;
        const paneEl = host.parentElement;
        if (!screen || !paneEl) return;
        const screenRect = screen.getBoundingClientRect();
        const paneRect = paneEl.getBoundingClientRect();
        const buffer = term.buffer.active;
        const cellW = screenRect.width / term.cols;
        const cellH = screenRect.height / term.rows;
        ghost.style.left = `${screenRect.left - paneRect.left + buffer.cursorX * cellW}px`;
        ghost.style.top = `${screenRect.top - paneRect.top + (buffer.cursorY - buffer.viewportY) * cellH}px`;
      };

      const refreshSuggestion = () => {
        if (!line) {
          hideSuggestion();
          return;
        }
        const candidate = suggestCommand(line, history);
        if (!candidate) {
          hideSuggestion();
          return;
        }
        suggestion = candidate.slice(line.length);
        if (ghost) {
          ghost.textContent = suggestion;
          ghost.style.display = "block";
          positionSuggestion();
        }
      };

      trackInput = (data: string) => {
        if (data === "\r") {
          const command = line.trim();
          if (command) history = rememberCommand(bucket, command);
          line = "";
          hideSuggestion();
          return;
        }
        if (data === "\t") {
          hideSuggestion();
          return;
        }
        if (data === "\x7f") {
          line = line.slice(0, -1);
          refreshSuggestion();
          return;
        }
        if (data === "\x03" || data === "\x15") {
          line = "";
          hideSuggestion();
          return;
        }
        if (data.length === 1 && data >= " " && data < "\x7f") {
          line += data;
          refreshSuggestion();
          return;
        }
        // 方向键等控制序列会移动光标，无法可靠跟踪输入行，直接取消建议
        hideSuggestion();
      };

      const acceptSuggestion = () => {
        if (!suggestion) return;
        const text = suggestion;
        line += text;
        hideSuggestion();
        const session = sessionRef.current;
        if (session) {
          termInput(session, new TextEncoder().encode(text)).catch(() => undefined);
        }
      };

      // 有建议时 Tab / → 接受补全；没有建议时不拦截，让 \t 原样发给远端 shell
      term.attachCustomKeyEventHandler((event) => {
        if (event.type !== "keydown" || !suggestion) return true;
        if (event.key === "Tab" || event.key === "ArrowRight") {
          event.preventDefault();
          acceptSuggestion();
          return false;
        }
        if (event.key === "Escape") {
          hideSuggestion();
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

    (async () => {
      const onEvent = (event: TermEvent) => {
        switch (event.type) {
          case "data":
            term.write(event.text);
            break;
          case "state":
            if (event.state.state === "connecting") {
              setPaneStatus(tabId, pane.key, "connecting", "连接中…");
            } else if (event.state.state === "authenticating") {
              setPaneStatus(tabId, pane.key, "connecting", "认证中…");
            } else if (event.state.state === "ready") {
              setPaneStatus(tabId, pane.key, "ready", "已连接");
              window.setTimeout(doFit, 60);
            } else if (event.state.state === "closed") {
              setPaneStatus(tabId, pane.key, "closed", event.state.reason ?? "已断开");
            }
            break;
          case "title":
            setPaneTitle(tabId, pane.key, event.title);
            break;
          case "exit":
            setPaneStatus(
              tabId,
              pane.key,
              "closed",
              event.reason ?? (event.code != null ? `进程退出 (${event.code})` : "会话结束"),
            );
            break;
          case "error":
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
        sessionRef.current = session;
        setPaneSession(tabId, pane.key, session);
        // Docker「进入终端」：把命令写进输入行但不回车，留给用户确认 / 修改。
        if (pane.initialInput) {
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
      }
    })();

    return () => {
      disposedRef.current = true;
      if (seedTimer) window.clearTimeout(seedTimer);
      window.cancelAnimationFrame(raf);
      observer.disconnect();
      hideSuggestion();
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

  /** 运行中切换 DTR / RTS，立即作用于当前串口句柄。 */
  const toggleLine = (which: "dtr" | "rts") => {
    const next = { ...lines, [which]: !lines[which] };
    setLines(next);
    const session = sessionRef.current;
    if (session) serialSetLines(session, next.dtr, next.rts).catch(() => undefined);
  };

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
      <div className="terminal-host" ref={hostRef} />
      {!isSerial && <span className="ghost-text" ref={ghostRef} />}
      {showOverlay && (
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
