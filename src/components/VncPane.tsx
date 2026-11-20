import { useEffect, useRef, useState } from "react";
import { errorText, vncClose, vncInput, vncOpen } from "../api";
import { useAppStore, type PaneState } from "../store";
import type { VncEvent } from "../types";
import { Icon } from "./Icon";

interface Props {
  tabId: string;
  pane: PaneState;
  active: boolean;
}

const SPECIAL_KEYS: Record<string, number> = {
  Backspace: 0xff08,
  Tab: 0xff09,
  Enter: 0xff0d,
  Escape: 0xff1b,
  Insert: 0xff63,
  Delete: 0xffff,
  Home: 0xff50,
  End: 0xff57,
  PageUp: 0xff55,
  PageDown: 0xff56,
  ArrowLeft: 0xff51,
  ArrowUp: 0xff52,
  ArrowRight: 0xff53,
  ArrowDown: 0xff54,
  Shift: 0xffe1,
  Control: 0xffe3,
  Alt: 0xffe9,
  Meta: 0xffeb,
  CapsLock: 0xffe5,
  " ": 0x20,
};

function keysymFor(event: React.KeyboardEvent): number | null {
  if (SPECIAL_KEYS[event.key] !== undefined) return SPECIAL_KEYS[event.key];
  const match = /^F(\d{1,2})$/.exec(event.key);
  if (match) {
    const index = Number(match[1]);
    if (index >= 1 && index <= 12) return 0xffbe + index - 1;
  }
  if (event.key.length === 1) {
    const code = event.key.codePointAt(0);
    if (code === undefined) return null;
    return code <= 0xff ? code : 0x01000000 + code;
  }
  return null;
}

/** VNC 画面面板：Rust 侧维护帧缓冲，这里只应用脏矩形并用 canvas 绘制。 */
export function VncPane({ tabId, pane, active }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sessionRef = useRef<string | null>(null);
  const sizeRef = useRef<{ width: number; height: number } | null>(null);
  const buttonsRef = useRef(0);
  const disposedRef = useRef(false);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<"connecting" | "ready" | "error" | "closed">("connecting");
  const [message, setMessage] = useState("正在连接 VNC 服务器…");
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);

  const profile = useAppStore((store) => store.profiles.find((item) => item.id === pane.profileId));
  const setPaneStatus = useAppStore((store) => store.setPaneStatus);
  const setPaneSession = useAppStore((store) => store.setPaneSession);
  const setPaneTitle = useAppStore((store) => store.setPaneTitle);
  const setActivePane = useAppStore((store) => store.setActivePane);

  const prefs = profile?.options.vnc;
  const readOnly = prefs?.read_only ?? false;
  const shared = prefs?.shared ?? true;
  const scaleViewport = prefs?.scale_viewport ?? true;
  const cropViewport = prefs?.crop_viewport ?? false;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    disposedRef.current = false;
    sessionRef.current = null;
    sizeRef.current = null;
    setStatus("connecting");
    setMessage("正在连接 VNC 服务器…");
    setSize(null);
    setPaneStatus(tabId, pane.key, "connecting", "连接中…");

    const applyCopyRect = (event: Extract<VncEvent, { type: "copy_rect" }>) => {
      if (!sizeRef.current) return;
      context.drawImage(
        canvas,
        event.src_x,
        event.src_y,
        event.width,
        event.height,
        event.x,
        event.y,
        event.width,
        event.height,
      );
    };

    const onEvent = (event: VncEvent) => {
      switch (event.type) {
        case "state":
          if (event.state === "ready") {
            setStatus("ready");
          } else if (event.state === "error") {
            setStatus("error");
            setMessage(event.message ?? "VNC 连接失败");
            setPaneStatus(tabId, pane.key, "error", event.message ?? "连接失败");
          } else if (event.state === "closed") {
            setStatus("closed");
            setMessage("连接已关闭");
            setPaneStatus(tabId, pane.key, "closed", "已断开");
          }
          break;
        case "size": {
          const next = { width: event.width, height: event.height };
          canvas.width = event.width;
          canvas.height = event.height;
          sizeRef.current = next;
          setSize(next);
          setPaneStatus(tabId, pane.key, "ready", `${event.width}×${event.height}`);
          if (event.name) setPaneTitle(tabId, pane.key, profile?.name ?? event.name);
          break;
        }
        case "copy_rect":
          applyCopyRect(event);
          break;
        case "exit":
          setStatus((current) => (current === "error" ? current : "closed"));
          setMessage((current) => (current === "连接已关闭" ? current : event.reason || "连接已关闭"));
          break;
        default:
          break;
      }
    };

    const onFrame = (buffer: ArrayBuffer) => {
      if (buffer.byteLength < 8) return;
      const view = new DataView(buffer);
      const x = view.getUint16(0);
      const y = view.getUint16(2);
      const width = view.getUint16(4);
      const height = view.getUint16(6);
      if (width === 0 || height === 0) return;
      const pixels = new Uint8ClampedArray(buffer, 8, width * height * 4);
      context.putImageData(new ImageData(pixels, width, height), x, y);
    };

    vncOpen(pane.profileId, onEvent, onFrame)
      .then((session) => {
        if (disposedRef.current) {
          vncClose(session).catch(() => undefined);
          return;
        }
        sessionRef.current = session;
        setPaneSession(tabId, pane.key, session);
      })
      .catch((error) => {
        if (disposedRef.current) return;
        const text = errorText(error);
        setStatus("error");
        setMessage(text);
        setPaneStatus(tabId, pane.key, "error", text);
      });

    return () => {
      disposedRef.current = true;
      const session = sessionRef.current;
      sessionRef.current = null;
      if (session) vncClose(session).catch(() => undefined);
    };
    // shared 变化需要重连，其余显示参数在渲染时读取。
  }, [pane.key, pane.profileId, shared, attempt, tabId, setPaneSession, setPaneStatus, setPaneTitle, profile?.name]);

  const remotePoint = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    const current = sizeRef.current;
    if (!canvas || !current) return null;
    const rect = canvas.getBoundingClientRect();
    let scale = 1;
    let offsetX = 0;
    let offsetY = 0;
    if (scaleViewport) {
      scale = Math.min(rect.width / current.width, rect.height / current.height) || 1;
      offsetX = (rect.width - current.width * scale) / 2;
      offsetY = (rect.height - current.height * scale) / 2;
    }
    const x = Math.floor((event.clientX - rect.left - offsetX) / scale);
    const y = Math.floor((event.clientY - rect.top - offsetY) / scale);
    if (x < 0 || y < 0 || x >= current.width || y >= current.height) return null;
    return { x, y };
  };

  const pointer = (event: React.MouseEvent<HTMLCanvasElement>, mask: number) => {
    const session = sessionRef.current;
    if (readOnly || !session) return;
    const point = remotePoint(event);
    if (!point) return;
    vncInput(session, { type: "pointer", mask, x: point.x, y: point.y }).catch(() => undefined);
  };

  const buttonBit = (button: number) => {
    if (button === 1) return 2;
    if (button === 2) return 4;
    return 1;
  };

  const key = (event: React.KeyboardEvent<HTMLCanvasElement>, down: boolean) => {
    const session = sessionRef.current;
    if (readOnly || !session) return;
    const keysym = keysymFor(event);
    if (keysym === null) return;
    event.preventDefault();
    vncInput(session, { type: "key", down, keysym }).catch(() => undefined);
  };

  return (
    <div
      className={`terminal-pane vnc-pane${active ? " is-active" : ""}`}
      onMouseDown={() =>
        setActivePane(
          tabId,
          useAppStore.getState().tabs.find((tab) => tab.id === tabId)?.panes.findIndex((item) => item.key === pane.key) ?? 0,
        )
      }
    >
      <div className="pane-head">
        <span className="proto-tag vnc">VNC</span>
        <span className="pane-name">{pane.profileName}</span>
        {readOnly && <span className="vnc-badge">只读</span>}
        {!scaleViewport && <span className="vnc-badge">1:1</span>}
        <span className="pane-state">
          <span className={`dot st-${pane.status}`} />
          {pane.statusText}
        </span>
      </div>

      <div className="vnc-host">
        <canvas
          ref={canvasRef}
          tabIndex={0}
          className={scaleViewport ? "is-scaled" : "is-cropped"}
          onContextMenu={(event) => event.preventDefault()}
          onMouseDown={(event) => {
            event.preventDefault();
            canvasRef.current?.focus();
            buttonsRef.current |= buttonBit(event.button);
            pointer(event, buttonsRef.current);
          }}
          onMouseUp={(event) => {
            buttonsRef.current &= ~buttonBit(event.button);
            pointer(event, buttonsRef.current);
          }}
          onMouseMove={(event) => pointer(event, buttonsRef.current)}
          onMouseLeave={(event) => {
            buttonsRef.current = 0;
            pointer(event, 0);
          }}
          onWheel={(event) => {
            event.preventDefault();
            pointer(event, event.deltaY < 0 ? 8 : 16);
            pointer(event, buttonsRef.current);
          }}
          onKeyDown={(event) => key(event, true)}
          onKeyUp={(event) => key(event, false)}
        />
        {status !== "ready" && (
          <div className="vnc-overlay">
            <Icon name={status === "error" ? "x" : "link"} size={26} />
            <div className={`vnc-overlay-text${status === "error" ? " is-error" : ""}`}>{message}</div>
            {status === "error" && (
              <button className="btn-primary sm" onClick={() => setAttempt((value) => value + 1)}>
                重试
              </button>
            )}
          </div>
        )}
      </div>

      <div className="vnc-foot">
        <span>{size ? `${size.width} × ${size.height}` : "尺寸未知"}</span>
        <span className="spacer" />
        <span>{scaleViewport ? (cropViewport ? "缩放 · 裁剪" : "缩放视口") : "原始尺寸 1:1"}</span>
        <span>{shared ? "共享连接" : "独占连接"}</span>
      </div>
    </div>
  );
}
