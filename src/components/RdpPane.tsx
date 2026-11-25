import { useEffect, useRef, useState } from "react";
import { errorText, rdpClose, rdpInput, rdpOpen } from "../api";
import { useAppStore, type PaneState } from "../store";
import type { RdpEvent } from "../types";
import { Icon } from "./Icon";

interface Props {
  tabId: string;
  pane: PaneState;
  active: boolean;
}

/**
 * IBM PC Set 1 扫描码。RDP 用扫描码而不是虚拟键码，才能让远端按物理键位处理。
 * 扩展键用 0xE000 高位标记（与 ironrdp-input 的 Scancode 约定一致）。
 */
const SCANCODES: Record<string, number> = {
  Escape: 0x01,
  Digit1: 0x02,
  Digit2: 0x03,
  Digit3: 0x04,
  Digit4: 0x05,
  Digit5: 0x06,
  Digit6: 0x07,
  Digit7: 0x08,
  Digit8: 0x09,
  Digit9: 0x0a,
  Digit0: 0x0b,
  Minus: 0x0c,
  Equal: 0x0d,
  Backspace: 0x0e,
  Tab: 0x0f,
  KeyQ: 0x10,
  KeyW: 0x11,
  KeyE: 0x12,
  KeyR: 0x13,
  KeyT: 0x14,
  KeyY: 0x15,
  KeyU: 0x16,
  KeyI: 0x17,
  KeyO: 0x18,
  KeyP: 0x19,
  BracketLeft: 0x1a,
  BracketRight: 0x1b,
  Enter: 0x1c,
  ControlLeft: 0x1d,
  KeyA: 0x1e,
  KeyS: 0x1f,
  KeyD: 0x20,
  KeyF: 0x21,
  KeyG: 0x22,
  KeyH: 0x23,
  KeyJ: 0x24,
  KeyK: 0x25,
  KeyL: 0x26,
  Semicolon: 0x27,
  Quote: 0x28,
  Backquote: 0x29,
  ShiftLeft: 0x2a,
  Backslash: 0x2b,
  KeyZ: 0x2c,
  KeyX: 0x2d,
  KeyC: 0x2e,
  KeyV: 0x2f,
  KeyB: 0x30,
  KeyN: 0x31,
  KeyM: 0x32,
  Comma: 0x33,
  Period: 0x34,
  Slash: 0x35,
  ShiftRight: 0x36,
  NumpadMultiply: 0x37,
  AltLeft: 0x38,
  Space: 0x39,
  CapsLock: 0x3a,
  F1: 0x3b,
  F2: 0x3c,
  F3: 0x3d,
  F4: 0x3e,
  F5: 0x3f,
  F6: 0x40,
  F7: 0x41,
  F8: 0x42,
  F9: 0x43,
  F10: 0x44,
  NumLock: 0x45,
  ScrollLock: 0x46,
  Numpad7: 0x47,
  Numpad8: 0x48,
  Numpad9: 0x49,
  NumpadSubtract: 0x4a,
  Numpad4: 0x4b,
  Numpad5: 0x4c,
  Numpad6: 0x4d,
  NumpadAdd: 0x4e,
  Numpad1: 0x4f,
  Numpad2: 0x50,
  Numpad3: 0x51,
  Numpad0: 0x52,
  NumpadDecimal: 0x53,
  IntlBackslash: 0x56,
  F11: 0x57,
  F12: 0x58,
  NumpadEnter: 0xe01c,
  ControlRight: 0xe01d,
  NumpadDivide: 0xe035,
  PrintScreen: 0xe037,
  AltRight: 0xe038,
  Home: 0xe047,
  ArrowUp: 0xe048,
  PageUp: 0xe049,
  ArrowLeft: 0xe04b,
  ArrowRight: 0xe04d,
  End: 0xe04f,
  ArrowDown: 0xe050,
  PageDown: 0xe051,
  Insert: 0xe052,
  Delete: 0xe053,
  MetaLeft: 0xe05b,
  MetaRight: 0xe05c,
  ContextMenu: 0xe05d,
};

/** 内嵌 RDP 画面面板：Rust 侧维护 ironrdp 会话与帧缓冲，这里只应用脏矩形。 */
export function RdpPane({ tabId, pane, active }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sessionRef = useRef<string | null>(null);
  const sizeRef = useRef<{ width: number; height: number } | null>(null);
  const buttonsRef = useRef(0);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const pressedKeysRef = useRef(new Set<number>());
  // 一次性密码只保存在内存里，用于本次面板重试；卸载即丢弃。
  const passwordRef = useRef<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<"connecting" | "ready" | "error" | "closed">("connecting");
  const [message, setMessage] = useState("正在连接 RDP 服务器…");
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [needPassword, setNeedPassword] = useState(false);
  const [passwordInput, setPasswordInput] = useState("");

  const profile = useAppStore((store) => store.profiles.find((item) => item.id === pane.profileId));
  const setPaneStatus = useAppStore((store) => store.setPaneStatus);
  const setPaneSession = useAppStore((store) => store.setPaneSession);
  const setPaneTitle = useAppStore((store) => store.setPaneTitle);
  const setActivePane = useAppStore((store) => store.setActivePane);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    let disposed = false;
    sessionRef.current = null;
    sizeRef.current = null;
    buttonsRef.current = 0;
    lastPointRef.current = null;
    pressedKeysRef.current.clear();
    setStatus("connecting");
    setMessage("正在连接 RDP 服务器…");
    setSize(null);
    setNeedPassword(false);
    setPaneStatus(tabId, pane.key, "connecting", "连接中…");

    const onEvent = (event: RdpEvent) => {
      if (disposed) return;
      switch (event.type) {
        case "state":
          if (event.state === "ready") {
            setStatus("ready");
            setNeedPassword(false);
          } else if (event.state === "error") {
            setStatus("error");
            setMessage(event.message ?? "RDP 连接失败");
            setPaneStatus(tabId, pane.key, "error", event.message ?? "连接失败");
          } else if (event.state === "closed") {
            setStatus("closed");
            setMessage(event.message || "连接已关闭");
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
        case "exit":
          setStatus((current) => (current === "error" ? current : "closed"));
          setMessage((current) =>
            current === "连接已关闭" ? current : event.reason || "连接已关闭",
          );
          break;
        default:
          break;
      }
    };

    const onFrame = (buffer: ArrayBuffer) => {
      if (disposed || buffer.byteLength < 8) return;
      const view = new DataView(buffer);
      const x = view.getUint16(0);
      const y = view.getUint16(2);
      const width = view.getUint16(4);
      const height = view.getUint16(6);
      if (width === 0 || height === 0 || buffer.byteLength !== 8 + width * height * 4) return;
      const pixels = new Uint8ClampedArray(buffer, 8, width * height * 4);
      context.putImageData(new ImageData(pixels, width, height), x, y);
    };

    rdpOpen(pane.profileId, passwordRef.current, onEvent, onFrame)
      .then((session) => {
        if (disposed) {
          rdpClose(session).catch(() => undefined);
          return;
        }
        sessionRef.current = session;
        setPaneSession(tabId, pane.key, session);
      })
      .catch((error) => {
        if (disposed) return;
        const shape = error as { code?: string } | null;
        if (shape?.code === "rdp.password_required") {
          setStatus("connecting");
          setNeedPassword(true);
          setMessage("该配置没有已保存的密码，请输入本次连接使用的密码");
          setPaneStatus(tabId, pane.key, "connecting", "等待密码");
          return;
        }
        const text = errorText(error);
        setStatus("error");
        setMessage(text);
        setPaneStatus(tabId, pane.key, "error", text);
      });

    return () => {
      disposed = true;
      const session = sessionRef.current;
      sessionRef.current = null;
      if (session) rdpClose(session).catch(() => undefined);
    };
    // passwordRef 不进依赖：只有用户主动提交密码时才通过 attempt 触发重连。
  }, [pane.key, pane.profileId, attempt, tabId, setPaneSession, setPaneStatus, setPaneTitle, profile?.name]);

  const remotePoint = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    const current = sizeRef.current;
    if (!canvas || !current) return null;
    const rect = canvas.getBoundingClientRect();
    const scale = Math.min(rect.width / current.width, rect.height / current.height) || 1;
    const offsetX = (rect.width - current.width * scale) / 2;
    const offsetY = (rect.height - current.height * scale) / 2;
    const x = Math.floor((event.clientX - rect.left - offsetX) / scale);
    const y = Math.floor((event.clientY - rect.top - offsetY) / scale);
    if (x < 0 || y < 0 || x >= current.width || y >= current.height) return null;
    return { x, y };
  };

  const pointer = (event: React.MouseEvent<HTMLCanvasElement>, mask: number, release = false) => {
    const session = sessionRef.current;
    if (!session) return;
    const point = remotePoint(event) ?? (release ? lastPointRef.current : null);
    if (!point) return;
    lastPointRef.current = point;
    rdpInput(session, { type: "pointer", mask, x: point.x, y: point.y }).catch(() => undefined);
  };

  const releasePointer = () => {
    const session = sessionRef.current;
    const point = lastPointRef.current;
    if (session && point && buttonsRef.current) {
      rdpInput(session, { type: "pointer", mask: 0, x: point.x, y: point.y }).catch(() => undefined);
    }
    buttonsRef.current = 0;
  };

  const buttonBit = (button: number) => {
    if (button === 0) return 1;
    if (button === 1) return 2;
    if (button === 2) return 4;
    return 0;
  };

  const key = (event: React.KeyboardEvent<HTMLCanvasElement>, down: boolean) => {
    const session = sessionRef.current;
    if (!session) return;
    const scancode = SCANCODES[event.code];
    if (scancode === undefined) return;
    event.preventDefault();
    if (down) pressedKeysRef.current.add(scancode);
    else if (!pressedKeysRef.current.delete(scancode)) return;
    rdpInput(session, { type: "key", down, scancode }).catch(() => undefined);
  };

  const releaseKeys = () => {
    const session = sessionRef.current;
    if (session) {
      for (const scancode of pressedKeysRef.current) {
        rdpInput(session, { type: "key", down: false, scancode }).catch(() => undefined);
      }
    }
    pressedKeysRef.current.clear();
  };

  const releaseInput = () => {
    releasePointer();
    releaseKeys();
  };

  useEffect(() => {
    if (!active) {
      releaseInput();
      return;
    }

    const releaseWhenHidden = () => {
      if (document.hidden) releaseInput();
    };

    window.addEventListener("mouseup", releasePointer);
    window.addEventListener("blur", releaseInput);
    document.addEventListener("visibilitychange", releaseWhenHidden);
    return () => {
      window.removeEventListener("mouseup", releasePointer);
      window.removeEventListener("blur", releaseInput);
      document.removeEventListener("visibilitychange", releaseWhenHidden);
    };
  });

  const connectWithPassword = (value: string) => {
    passwordRef.current = value;
    setNeedPassword(false);
    setAttempt((current) => current + 1);
  };

  return (
    <div
      className={`terminal-pane vnc-pane rdp-pane${active ? " is-active" : ""}`}
      onMouseDown={() =>
        setActivePane(
          tabId,
          useAppStore.getState().tabs.find((tab) => tab.id === tabId)?.panes.findIndex((item) => item.key === pane.key) ?? 0,
        )
      }
    >
      <div className="pane-head">
        <span className="proto-tag rdp">RDP</span>
        <span className="pane-name">{pane.profileName}</span>
        <span className="pane-state">
          <span className={`dot st-${pane.status}`} />
          {pane.statusText}
        </span>
      </div>

      <div className="vnc-host">
        <canvas
          ref={canvasRef}
          tabIndex={0}
          className="is-scaled"
          onContextMenu={(event) => event.preventDefault()}
          onMouseDown={(event) => {
            event.preventDefault();
            canvasRef.current?.focus();
            const bit = buttonBit(event.button);
            if (!bit || !remotePoint(event)) return;
            buttonsRef.current |= bit;
            pointer(event, buttonsRef.current);
          }}
          onMouseUp={(event) => {
            buttonsRef.current &= ~buttonBit(event.button);
            pointer(event, buttonsRef.current, true);
          }}
          onMouseMove={(event) => pointer(event, buttonsRef.current)}
          onMouseLeave={() => {
            if (!buttonsRef.current) return;
            releasePointer();
          }}
          onWheel={(event) => {
            event.preventDefault();
            if (event.deltaY === 0) return;
            pointer(event, buttonsRef.current | (event.deltaY < 0 ? 8 : 16));
          }}
          onKeyDown={(event) => key(event, true)}
          onKeyUp={(event) => key(event, false)}
          onBlur={releaseInput}
        />
        {status !== "ready" && (
          <div className="vnc-overlay">
            {needPassword ? (
              <div className="rdp-password">
                <Icon name="lock" size={24} />
                <div className="vnc-overlay-text">{message}</div>
                <input
                  type="password"
                  autoFocus
                  value={passwordInput}
                  placeholder="RDP 密码（可留空）"
                  onChange={(event) => setPasswordInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") connectWithPassword(passwordInput);
                  }}
                />
                <div className="rdp-password-actions">
                  <button className="btn-primary sm" onClick={() => connectWithPassword(passwordInput)}>
                    连接
                  </button>
                  <button className="btn-ghost sm" onClick={() => connectWithPassword("")}>
                    使用空密码
                  </button>
                </div>
                <span className="rdp-password-hint">密码只用于本次连接，不会写入磁盘</span>
              </div>
            ) : (
              <>
                <Icon name={status === "error" ? "x" : "link"} size={26} />
                <div className={`vnc-overlay-text${status === "error" ? " is-error" : ""}`}>{message}</div>
                {(status === "error" || status === "closed") && (
                  <div className="rdp-password-actions">
                    <button className="btn-primary sm" onClick={() => setAttempt((value) => value + 1)}>
                      重试
                    </button>
                    {passwordRef.current !== null && (
                      <button
                        className="btn-ghost sm"
                        onClick={() => {
                          setPasswordInput("");
                          setNeedPassword(true);
                        }}
                      >
                        重新输入密码
                      </button>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>

      <div className="vnc-foot">
        <span>{size ? `${size.width} × ${size.height}` : "尺寸未知"}</span>
        <span className="spacer" />
        <span>缩放视口</span>
        <span className="rdp-foot-hint">当前版本不含剪贴板/多显示器/音频</span>
      </div>
    </div>
  );
}
