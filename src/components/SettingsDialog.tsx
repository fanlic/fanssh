import { useEffect, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { relaunch } from "@tauri-apps/plugin-process";
import { errorText, updaterCheck, updaterInstall, updaterStatus } from "../api";
import {
  APPEARANCE_PRESETS,
  BACKGROUND_COLORS,
  THEME_COLORS,
  findPreset,
} from "../lib/appearance";
import { useUiSettingsStore } from "../uiSettings";
import type { ShortcutSettings, UpdateInfo, UpdaterStatus } from "../types";

interface Props {
  open: boolean;
  /** 当前构建平台（windows / linux / macos），Linux 下关闭应用内自动更新。 */
  platform: string;
  onClose: () => void;
  onNotice: (message: string, kind?: "info" | "error") => void;
}

type Phase = "idle" | "checking" | "uptodate" | "available" | "confirm" | "installing" | "installed";
type Page = "appearance" | "terminal" | "shortcuts" | "update" | "about";

const FONT_CANDIDATES = ["Ubuntu", "Menlo", "Monaco", "Consolas", "Courier New", "MesloLGS NF"];

const SHORTCUT_ROWS: Array<{ key: keyof ShortcutSettings; label: string; desc?: string }> = [
  { key: "open_settings", label: "打开设置" },
  { key: "global_search", label: "打开全局搜索" },
  { key: "next_tab", label: "切换到下一个标签" },
  { key: "prev_tab", label: "切换到上一个标签" },
  { key: "close_tab", label: "关闭当前标签" },
  { key: "zoom_in", label: "增大终端字体" },
  { key: "zoom_out", label: "减小终端字体" },
  { key: "toggle_sidebar", label: "显示 / 隐藏会话列表" },
];

/** 把键盘事件转成 "Ctrl+Shift+F" 形式的绑定字符串。 */
function eventToCombo(event: ReactKeyboardEvent): string | null {
  if (["Control", "Alt", "Shift", "Meta"].includes(event.key)) return null;
  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) parts.push("Ctrl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  let key = event.key;
  if (key === " ") key = "Space";
  else if (key.length === 1) key = key.toUpperCase();
  parts.push(key);
  return parts.join("+");
}

function ShortcutRecorder({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const [recording, setRecording] = useState(false);
  return (
    <div className={`sc-recorder${recording ? " is-recording" : ""}`}>
      <button
        type="button"
        className="sc-input"
        onClick={() => setRecording(true)}
        onBlur={() => setRecording(false)}
        onKeyDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (event.key === "Backspace" || event.key === "Delete") {
            onChange("");
            return;
          }
          if (event.key === "Escape") {
            setRecording(false);
            (event.currentTarget as HTMLButtonElement).blur();
            return;
          }
          const combo = eventToCombo(event);
          if (combo) onChange(combo);
        }}
      >
        {recording ? "请按下快捷键…" : value || "未绑定"}
      </button>
      {value && (
        <button
          type="button"
          className="sc-clear"
          title="清空绑定"
          onClick={() => onChange("")}
        >
          ×
        </button>
      )}
    </div>
  );
}

function SetRow({
  title,
  desc,
  children,
}: {
  title: string;
  desc?: string;
  children: ReactNode;
}) {
  return (
    <div className="set-row">
      <div className="set-row-label">
        <span>{title}</span>
        {desc && <small>{desc}</small>}
      </div>
      <div className="set-row-ctl">{children}</div>
    </div>
  );
}

function Switch({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className={`set-switch${on ? " is-on" : ""}`}
      role="switch"
      aria-checked={on}
      onClick={onToggle}
    >
      <span className="set-switch-knob" />
    </button>
  );
}

export function SettingsDialog({ open, platform, onClose, onNotice }: Props) {
  const [status, setStatus] = useState<UpdaterStatus | null>(null);
  const [tab, setTab] = useState<Page>("appearance");
  const [phase, setPhase] = useState<Phase>("idle");
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number | null }>({
    done: 0,
    total: null,
  });

  const appearance = useUiSettingsStore((s) => s.settings.appearance);
  const terminal = useUiSettingsStore((s) => s.settings.terminal);
  const shortcuts = useUiSettingsStore((s) => s.settings.shortcuts);
  const saveError = useUiSettingsStore((s) => s.error);
  const setAppearance = useUiSettingsStore((s) => s.setAppearance);
  const setTerminal = useUiSettingsStore((s) => s.setTerminal);
  const setShortcuts = useUiSettingsStore((s) => s.setShortcuts);
  const resetAppearance = useUiSettingsStore((s) => s.resetAppearance);
  const resetTerminal = useUiSettingsStore((s) => s.resetTerminal);
  const resetShortcuts = useUiSettingsStore((s) => s.resetShortcuts);

  useEffect(() => {
    if (!open) return;
    void useUiSettingsStore.getState().load();
    setTab("appearance");
    setPhase("idle");
    setUpdate(null);
    setError(null);
    setProgress({ done: 0, total: null });
    updaterStatus()
      .then(setStatus)
      .catch((err) => setError(errorText(err)));
  }, [open]);

  if (!open) return null;

  const handleCheck = async () => {
    setPhase("checking");
    setError(null);
    try {
      const result = await updaterCheck();
      if (result) {
        setUpdate(result);
        setPhase("available");
      } else {
        setPhase("uptodate");
      }
    } catch (err) {
      setError(errorText(err));
      setPhase("idle");
    }
  };

  const handleInstall = async () => {
    setPhase("installing");
    setProgress({ done: 0, total: null });
    try {
      await updaterInstall((event) => {
        if (event.type === "progress") {
          setProgress({ done: event.downloaded, total: event.total });
        }
      });
      setPhase("installed");
    } catch (err) {
      setError(errorText(err));
      setPhase("available");
    }
  };

  const percent =
    progress.total && progress.total > 0
      ? Math.min(100, Math.round((progress.done / progress.total) * 100))
      : null;

  const sizeText = (bytes: number) =>
    bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;

  // Linux 版暂不接入应用内自动更新，避免留下一个永远失败的按钮。
  const updaterSupported = platform === "windows";

  const numberValue = (value: string, fallback: number) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  const toggleFont = (name: string) => {
    const parts = terminal.font_family
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    const bare = (item: string) => item.replace(/["']/g, "");
    const has = parts.some((item) => bare(item) === name);
    const rest = parts.filter((item) => bare(item) !== name && bare(item) !== "monospace");
    const next = has ? rest : [`"${name}"`, ...rest];
    setTerminal({ font_family: [...next, "monospace"].join(", ") });
  };

  return (
    <div className="dlg-mask" onClick={onClose}>
      <div className="dlg dlg-settings" onClick={(event) => event.stopPropagation()}>
        <div className="dlg-head">
          <h3>系统配置</h3>
          <button className="icon-btn sm" onClick={onClose} title="关闭">
            ×
          </button>
        </div>
        <div className="dlg-body dlg-split">
          <nav className="set-nav">
            {(
              [
                ["appearance", "主题界面"],
                ["terminal", "通用终端"],
                ["shortcuts", "按键配置"],
                ["update", "软件更新"],
                ["about", "关于与平台"],
              ] as Array<[Page, string]>
            ).map(([id, label]) => (
              <button
                key={id}
                className={`set-nav-item${tab === id ? " is-active" : ""}`}
                onClick={() => setTab(id)}
              >
                {label}
              </button>
            ))}
          </nav>
          <div className="set-main">
            {tab === "appearance" && (
              <>
                <div className="set-head">
                  <span className="set-head-note">外观修改会立即应用到当前窗口。</span>
                  <button className="btn-ghost sm" onClick={resetAppearance}>
                    恢复默认外观
                  </button>
                </div>

                <div className="set-card">
                  <p className="set-card-title">背景</p>
                  <p className="set-card-desc">
                    预设包含主题色、背景色与导航栏颜色；所有预设均可使用，Pro 仅为视觉角标。
                  </p>
                  <div className="theme-grid">
                    {APPEARANCE_PRESETS.map((preset) => (
                      <button
                        key={preset.id}
                        className={`theme-card${appearance.preset === preset.id ? " is-active" : ""}${
                          preset.dark ? "" : " is-light"
                        }`}
                        style={{ background: preset.background }}
                        onClick={() =>
                          setAppearance({
                            preset: preset.id,
                            theme_color: preset.theme,
                            background_color: preset.background,
                            nav_color: preset.nav,
                          })
                        }
                        title={preset.name}
                      >
                        <span className="theme-swatch" style={{ background: preset.theme }} />
                        <span className="theme-name">{preset.name}</span>
                        {preset.pro && <span className="theme-pro">Pro</span>}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="set-card">
                  <p className="set-card-title">导航栏颜色</p>
                  <p className="set-card-desc">仅影响顶部导航栏配色。</p>
                  <div className="color-row">
                    {BACKGROUND_COLORS.map((color) => (
                      <button
                        key={color}
                        className={`color-dot${appearance.nav_color === color ? " is-active" : ""}`}
                        style={{ background: color }}
                        title={color}
                        onClick={() => setAppearance({ nav_color: color })}
                      />
                    ))}
                    <button
                      className="link-btn"
                      onClick={() => setAppearance({ nav_color: findPreset(appearance.preset).nav })}
                    >
                      恢复默认
                    </button>
                  </div>
                </div>

                <div className="set-card">
                  <p className="set-card-title">主题色</p>
                  <p className="set-card-desc">软件主题色，主要操作按钮、选中态与终端光标颜色。</p>
                  <div className="color-row">
                    {THEME_COLORS.map((color) => (
                      <button
                        key={color}
                        className={`color-dot${appearance.theme_color === color ? " is-active" : ""}`}
                        style={{ background: color }}
                        title={color}
                        onClick={() => setAppearance({ theme_color: color })}
                      />
                    ))}
                    <button
                      className="link-btn"
                      onClick={() =>
                        setAppearance({ theme_color: findPreset(appearance.preset).theme })
                      }
                    >
                      恢复默认
                    </button>
                  </div>
                </div>

                <div className="set-card">
                  <p className="set-card-title">背景色</p>
                  <p className="set-card-desc">
                    建议选择与主题色接近且更深的背景色，以提升对比度。
                  </p>
                  <div className="color-row">
                    {BACKGROUND_COLORS.map((color) => (
                      <button
                        key={color}
                        className={`color-dot${appearance.background_color === color ? " is-active" : ""}`}
                        style={{ background: color }}
                        title={color}
                        onClick={() => setAppearance({ background_color: color })}
                      />
                    ))}
                    <button
                      className="link-btn"
                      onClick={() =>
                        setAppearance({ background_color: findPreset(appearance.preset).background })
                      }
                    >
                      恢复默认
                    </button>
                  </div>
                </div>

                <div className="set-card">
                  <SetRow title="跟随系统主题" desc="关闭时固定使用上方选择的预设。">
                    <Switch
                      on={appearance.follow_system}
                      onToggle={() => setAppearance({ follow_system: !appearance.follow_system })}
                    />
                  </SetRow>
                  <SetRow title="系统字体" desc="界面文字使用的系统字体；default 表示跟随平台。">
                    <select
                      className="set-input"
                      value={appearance.system_font}
                      onChange={(event) => setAppearance({ system_font: event.target.value })}
                    >
                      <option value="default">default</option>
                      <option value="system-ui">system-ui</option>
                      <option value='-apple-system, "Segoe UI", "PingFang SC", sans-serif'>
                        系统默认无衬线
                      </option>
                    </select>
                  </SetRow>
                </div>
              </>
            )}

            {tab === "terminal" && (
              <>
                <div className="set-head">
                  <span className="set-head-note">
                    字体、字号、行高与光标样式会实时作用到已打开的会话。
                  </span>
                  <button className="btn-ghost sm" onClick={resetTerminal}>
                    恢复默认
                  </button>
                </div>

                <div className="set-card">
                  <p className="set-card-title">基础配置</p>
                  <p className="set-card-desc">
                    等宽字体按顺序回退；未安装的字体自动使用下一个候选。
                  </p>

                  <SetRow title="字体" desc="点击标签快速启用 / 停用，也可以直接编辑字体列表。">
                    <div className="set-fill">
                      <div className="font-chips">
                        {FONT_CANDIDATES.map((font) => (
                          <button
                            key={font}
                            type="button"
                            className={`font-chip${terminal.font_family
                              .toLowerCase()
                              .includes(font.toLowerCase()) ? " is-on" : ""}`}
                            onClick={() => toggleFont(font)}
                          >
                            {font}
                          </button>
                        ))}
                      </div>
                      <input
                        className="set-input wide"
                        value={terminal.font_family}
                        spellCheck={false}
                        onChange={(event) => setTerminal({ font_family: event.target.value })}
                      />
                    </div>
                  </SetRow>

                  <SetRow title="非粗体文本的字体粗细">
                    <select
                      className="set-input"
                      value={terminal.normal_weight}
                      onChange={(event) => setTerminal({ normal_weight: event.target.value })}
                    >
                      <option value="normal">normal</option>
                      <option value="300">300</option>
                      <option value="400">400</option>
                      <option value="500">500</option>
                      <option value="600">600</option>
                    </select>
                  </SetRow>

                  <SetRow title="粗体文本的字体粗细">
                    <select
                      className="set-input"
                      value={terminal.bold_weight}
                      onChange={(event) => setTerminal({ bold_weight: event.target.value })}
                    >
                      <option value="bold">bold</option>
                      <option value="600">600</option>
                      <option value="700">700</option>
                      <option value="800">800</option>
                    </select>
                  </SetRow>

                  <SetRow title="保存行数" desc="终端回滚缓冲区行数，范围 100 ~ 100000。">
                    <input
                      className="set-input"
                      type="number"
                      min={100}
                      max={100000}
                      step={100}
                      value={terminal.scrollback}
                      onChange={(event) =>
                        setTerminal({
                          scrollback: numberValue(event.target.value, terminal.scrollback),
                        })
                      }
                    />
                  </SetRow>

                  <SetRow title="字号">
                    <input
                      className="set-input"
                      type="number"
                      min={10}
                      max={32}
                      value={terminal.font_size}
                      onChange={(event) =>
                        setTerminal({
                          font_size: numberValue(event.target.value, terminal.font_size),
                        })
                      }
                    />
                  </SetRow>

                  <SetRow title="行高" desc="1.0 为紧凑行距，常用范围 1.0 ~ 1.6。">
                    <input
                      className="set-input"
                      type="number"
                      min={0.8}
                      max={2}
                      step={0.1}
                      value={terminal.line_height}
                      onChange={(event) =>
                        setTerminal({
                          line_height: numberValue(event.target.value, terminal.line_height),
                        })
                      }
                    />
                  </SetRow>

                  <SetRow title="终端快捷输入模式" desc="悬浮模式不占高度，隐藏模式仍可热键唤起。">
                    <select
                      className="set-input"
                      value={terminal.quick_input}
                      onChange={(event) => setTerminal({ quick_input: event.target.value })}
                    >
                      <option value="floating">右下角悬浮</option>
                      <option value="hidden">隐藏</option>
                      <option value="fixed">固定底栏</option>
                    </select>
                  </SetRow>

                  <SetRow title="字间距" desc="单位像素，负数收紧。">
                    <input
                      className="set-input"
                      type="number"
                      min={-2}
                      max={6}
                      step={0.5}
                      value={terminal.letter_spacing}
                      onChange={(event) =>
                        setTerminal({
                          letter_spacing: numberValue(event.target.value, terminal.letter_spacing),
                        })
                      }
                    />
                  </SetRow>
                </div>

                <div className="set-card">
                  <p className="set-card-title">光标</p>
                  <SetRow title="光标闪动">
                    <Switch
                      on={terminal.cursor_blink}
                      onToggle={() => setTerminal({ cursor_blink: !terminal.cursor_blink })}
                    />
                  </SetRow>
                  <SetRow title="活动态形状">
                    <select
                      className="set-input"
                      value={terminal.cursor_style}
                      onChange={(event) => setTerminal({ cursor_style: event.target.value })}
                    >
                      <option value="bar">竖线</option>
                      <option value="block">方块</option>
                      <option value="underline">下划线</option>
                    </select>
                  </SetRow>
                  <SetRow title="非活动态形状">
                    <select
                      className="set-input"
                      value={terminal.inactive_cursor_style}
                      onChange={(event) =>
                        setTerminal({ inactive_cursor_style: event.target.value })
                      }
                    >
                      <option value="none">无</option>
                      <option value="outline">空心</option>
                      <option value="block">方块</option>
                      <option value="bar">竖线</option>
                      <option value="underline">下划线</option>
                    </select>
                  </SetRow>
                </div>
              </>
            )}

            {tab === "shortcuts" && (
              <>
                <div className="set-head">
                  <span className="set-head-note">
                    点击输入框后按下组合键录制；Backspace / Delete 或 × 清空绑定。
                  </span>
                  <button className="btn-ghost sm" onClick={resetShortcuts}>
                    恢复默认快捷键
                  </button>
                </div>

                <div className="set-card">
                  <p className="set-card-title">快捷键</p>
                  <p className="set-card-desc">
                    仅作用于应用级操作。终端内的 Ctrl+C / Ctrl+V / Ctrl+F / Ctrl+L
                    始终交给终端与系统，不在此处接管。
                  </p>
                  {SHORTCUT_ROWS.map((row) => (
                    <SetRow key={row.key} title={row.label} desc={row.desc}>
                      <ShortcutRecorder
                        value={shortcuts[row.key]}
                        onChange={(value) => setShortcuts({ [row.key]: value })}
                      />
                    </SetRow>
                  ))}
                </div>

                <div className="set-card">
                  <p className="set-card-title">终端行为</p>
                  <SetRow title="滚轮控制终端字体大小" desc="按住 Ctrl 滚动滚轮缩放当前面板字号。">
                    <Switch
                      on={terminal.wheel_zoom}
                      onToggle={() => setTerminal({ wheel_zoom: !terminal.wheel_zoom })}
                    />
                  </SetRow>
                  <SetRow title="终端选中复制" desc="关闭时仍可用 Ctrl+C 复制选区。">
                    <Switch
                      on={terminal.copy_on_select}
                      onToggle={() => setTerminal({ copy_on_select: !terminal.copy_on_select })}
                    />
                  </SetRow>
                  <SetRow title="右键行为">
                    <select
                      className="set-input"
                      value={terminal.right_click}
                      onChange={(event) => setTerminal({ right_click: event.target.value })}
                    >
                      <option value="menu">右键菜单</option>
                      <option value="paste">粘贴剪贴板</option>
                    </select>
                  </SetRow>
                </div>
              </>
            )}

            {tab === "about" && (
              <div className="set-card">
                <p className="set-card-title">版本信息</p>
                <p className="set-card-desc">当前安装的 FanSSH 版本与更新通道。</p>
                <div className="update-row">
                  <span>当前版本</span>
                  <strong>{status?.currentVersion ?? "读取中…"}</strong>
                </div>
                <div className="update-row">
                  <span>更新源</span>
                  <code className="update-endpoint">{status?.endpoint || "未配置"}</code>
                </div>
                <div className="update-row">
                  <span>运行平台</span>
                  <strong>{platform}</strong>
                </div>
              </div>
            )}

            {tab === "update" && (
              <>
                {status?.portable && (
                  <p className="update-hint">
                    便携版不参与自动更新。检测到新版本时请下载新版便携包并解压覆盖（配置与凭据在
                    `data/` 目录，迁移时一并带走）：
                    <br />
                    <code className="update-endpoint">{status.channelUrl}</code>
                  </p>
                )}

                <div className="set-card">
                  <p className="set-card-title">检查更新</p>
                  <p className="set-card-desc">
                    {updaterSupported
                      ? "安装版可直接在应用内下载并安装更新，便携版请手动替换。"
                      : `当前平台（${platform}）暂不支持应用内自动更新，请到发布页下载新的 AppImage 或 deb 手动替换。`}
                  </p>

                  {phase === "checking" && <p className="muted">正在检查更新…</p>}
                  {phase === "uptodate" && <p className="update-ok">已是最新版本。</p>}

                  {(phase === "available" || phase === "confirm") && update && (
                    <div className="update-box">
                      <div className="update-row">
                        <span>新版本</span>
                        <strong>
                          {update.version}
                          <span className="muted">（当前 {update.currentVersion}）</span>
                        </strong>
                      </div>
                      {update.date && (
                        <div className="update-row">
                          <span>发布时间</span>
                          <span>{new Date(update.date).toLocaleString()}</span>
                        </div>
                      )}
                      <div className="section-title">更新日志</div>
                      <pre className="update-notes">
                        {update.notes?.trim() || "该版本未提供更新说明。"}
                      </pre>
                    </div>
                  )}

                  {phase === "confirm" && (
                    <p className="update-hint">
                      确认后将下载安装包并安装，安装完成后需要重启 FanSSH 才能生效。是否继续？
                    </p>
                  )}

                  {phase === "installing" && (
                    <div className="update-progress">
                      <div className="update-progress-track">
                        <div
                          className="update-progress-bar"
                          style={{ width: percent === null ? "100%" : `${percent}%` }}
                        />
                      </div>
                      <span className="muted">
                        {percent === null
                          ? `已下载 ${sizeText(progress.done)}`
                          : `${percent}% · ${sizeText(progress.done)}${progress.total ? ` / ${sizeText(progress.total)}` : ""}`}
                      </span>
                    </div>
                  )}

                  {phase === "installed" && (
                    <p className="update-ok">
                      安装包已就绪。点击「重启并完成安装」后应用会退出并重新启动。
                    </p>
                  )}

                  {error && <p className="update-error">{error}</p>}
                </div>
              </>
            )}

            {saveError && tab !== "update" && <p className="update-error">{saveError}</p>}
          </div>
        </div>
        <div className="dlg-foot">
          {tab === "update" ? (
            phase === "confirm" ? (
              <>
                <button className="btn-ghost" onClick={() => setPhase("available")}>
                  取消
                </button>
                <button className="btn-primary" onClick={handleInstall}>
                  确认更新
                </button>
              </>
            ) : phase === "available" ? (
              <>
                <button className="btn-ghost" onClick={onClose}>
                  稍后
                </button>
                <button className="btn-primary" onClick={() => setPhase("confirm")}>
                  下载并安装
                </button>
              </>
            ) : phase === "installed" ? (
              <button
                className="btn-primary"
                onClick={() => {
                  relaunch().catch((err) => onNotice(errorText(err), "error"));
                }}
              >
                重启并完成安装
              </button>
            ) : (
              <>
                <button className="btn-ghost" onClick={onClose}>
                  关闭
                </button>
                <button
                  className="btn-primary"
                  onClick={handleCheck}
                  disabled={
                    !updaterSupported ||
                    phase === "checking" ||
                    phase === "installing" ||
                    status?.portable === true
                  }
                  title={
                    !updaterSupported
                      ? "当前平台暂不支持应用内自动更新"
                      : status?.portable
                        ? "便携版请下载新版 zip"
                        : undefined
                  }
                >
                  检查更新
                </button>
              </>
            )
          ) : (
            <>
              <span className="muted">修改会自动保存到 settings.json</span>
              <button className="btn-ghost" onClick={onClose}>
                关闭
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
