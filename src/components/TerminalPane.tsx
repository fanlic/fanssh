import { useEffect, useRef } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { errorText, termClose, termInput, termOpen, termResize } from "../api";
import { terminalRegistry } from "../lib/terminalRegistry";
import { useAppStore, type PaneState } from "../store";

const THEME = {
  background: "#0d1117",
  foreground: "#d6deeb",
  cursor: "#7ee787",
  selectionBackground: "#264f78",
  black: "#1b1f27",
  red: "#ff6b6b",
  green: "#7ee787",
  yellow: "#ffd580",
  blue: "#79b8ff",
  magenta: "#d2a8ff",
  cyan: "#56d4dd",
  white: "#d6deeb",
  brightBlack: "#5b6778",
  brightRed: "#ff9d9d",
  brightGreen: "#a8f0b0",
  brightYellow: "#ffe3a3",
  brightBlue: "#a5d6ff",
  brightMagenta: "#e2c5ff",
  brightCyan: "#8be9fd",
  brightWhite: "#ffffff",
};

interface Props {
  tabId: string;
  pane: PaneState;
  active: boolean;
}

export function TerminalPane({ tabId, pane, active }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionRef = useRef<string | null>(null);
  const disposedRef = useRef(false);

  const setPaneStatus = useAppStore((s) => s.setPaneStatus);
  const setPaneSession = useAppStore((s) => s.setPaneSession);
  const setPaneTitle = useAppStore((s) => s.setPaneTitle);
  const setActivePane = useAppStore((s) => s.setActivePane);

  // 终端实例与会话生命周期：只随 pane.key 变化重建。
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    disposedRef.current = false;

    const term = new Terminal({
      fontFamily:
        '"Cascadia Mono", "JetBrains Mono", Consolas, "Noto Sans Mono CJK SC", monospace',
      fontSize: 14,
      lineHeight: 1.2,
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
      if (sessionRef.current) {
        termResize(sessionRef.current, term.cols, term.rows).catch(() => undefined);
      }
    };
    const raf = window.requestAnimationFrame(doFit);
    const observer = new ResizeObserver(() => doFit());
    observer.observe(host);

    const dataSub = term.onData((data) => {
      const session = sessionRef.current;
      if (session) {
        termInput(session, new TextEncoder().encode(data)).catch((error) => {
          term.writeln(`\r\n\x1b[31m写入失败: ${errorText(error)}\x1b[0m`);
        });
      }
    });

    (async () => {
      try {
        const session = await termOpen(pane.profileId, (event) => {
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
        });
        if (disposedRef.current) {
          termClose(session).catch(() => undefined);
          return;
        }
        sessionRef.current = session;
        setPaneSession(tabId, pane.key, session);
      } catch (error) {
        if (disposedRef.current) return;
        setPaneStatus(tabId, pane.key, "error", errorText(error));
        term.writeln(`\r\n\x1b[31m连接失败: ${errorText(error)}\x1b[0m`);
        term.writeln("按 Tab 关闭该面板后重新连接。");
      }
    })();

    return () => {
      disposedRef.current = true;
      window.cancelAnimationFrame(raf);
      observer.disconnect();
      dataSub.dispose();
      const session = sessionRef.current;
      sessionRef.current = null;
      if (session) {
        termClose(session).catch(() => undefined);
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

  return (
    <div
      className={`terminal-pane${active ? " is-active" : ""}`}
      onMouseDown={() => setActivePane(tabId, useAppStore.getState().tabs.find((t) => t.id === tabId)?.panes.findIndex((p) => p.key === pane.key) ?? 0)}
    >
      <div className="terminal-host" ref={hostRef} />
      {showOverlay && (
        <div className="terminal-overlay">
          <div className={`terminal-status status-${pane.status}`}>
            <span className="dot" />
            <span>{pane.statusText}</span>
          </div>
        </div>
      )}
    </div>
  );
}
