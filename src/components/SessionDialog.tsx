import { useEffect, useState } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import {
  errorText,
  profileUpsert,
  readTextFile,
  serialListPorts,
  vaultPut,
} from "../api";
import type {
  AuthRef,
  Profile,
  Protocol,
  RdpPrefs,
  SerialFlowControl,
  SerialNewline,
  SerialParity,
  SerialPortInfo,
  SerialPrefs,
  SshPrefs,
} from "../types";
import { Icon, type IconName } from "./Icon";

interface Props {
  open: boolean;
  initial: Profile | null;
  /** 当前构建平台（windows / linux / macos），用于隐藏或提示平台不支持的能力。 */
  platform: string;
  /** 新建时默认选中的协议，跟随顶部协议 tab。 */
  defaultProtocol?: Protocol;
  onClose: () => void;
  onSaved: (profile: Profile) => void;
  onError: (message: string) => void;
}

type AuthMode = "password" | "key" | "keyboard_interactive" | "none";

interface JumpForm {
  host: string;
  port: string;
  user: string;
  authMode: AuthMode;
  password: string;
  keyText: string;
}

interface FormState {
  name: string;
  group: string;
  tags: string;
  remark: string;
  protocol: Protocol;
  host: string;
  port: string;
  user: string;
  authMode: AuthMode;
  password: string;
  keyText: string;
  passphrase: string;
  jumps: JumpForm[];
  ssh: SshPrefs;
  rdp: RdpPrefs;
  serial: SerialPrefs;
}

/** 串口参数预设：只回填波特率/数据位/停止位/校验/流控，不覆盖端口。 */
const SERIAL_PRESETS: Array<{
  id: string;
  label: string;
  params: Pick<
    SerialPrefs,
    "baud_rate" | "data_bits" | "stop_bits" | "parity" | "flow_control"
  >;
}> = [
  {
    id: "console",
    label: "网络设备 console（9600 8N1，无流控）",
    params: { baud_rate: 9600, data_bits: 8, stop_bits: 1, parity: "none", flow_control: "none" },
  },
  {
    id: "debug",
    label: "通用调试 / 开发板（115200 8N1，无流控）",
    params: {
      baud_rate: 115200,
      data_bits: 8,
      stop_bits: 1,
      parity: "none",
      flow_control: "none",
    },
  },
  {
    id: "industrial",
    label: "工业设备（19200 8E1，无流控）",
    params: { baud_rate: 19200, data_bits: 8, stop_bits: 1, parity: "even", flow_control: "none" },
  },
];

function matchSerialPreset(serial: SerialPrefs): string {
  const preset = SERIAL_PRESETS.find((item) =>
    Object.entries(item.params).every(
      ([key, value]) => serial[key as keyof typeof item.params] === value,
    ),
  );
  return preset?.id ?? "custom";
}

const DEFAULT_SERIAL: SerialPrefs = {
  port: "",
  baud_rate: 115200,
  data_bits: 8,
  stop_bits: 1,
  parity: "none",
  flow_control: "none",
  dtr: true,
  rts: true,
  local_echo: false,
  newline: "raw",
};

const DEFAULT_SSH: SshPrefs = {
  timeout_ms: 20000,
  keepalive_ms: 5000,
  encoding: "utf-8",
  terminal_type: "",
  proxy: "",
  proxy_disabled: false,
  init_command: "",
  default_path: "",
  keepalive_command: "",
  keepalive_command_ms: 60000,
  env: [],
  monitor_disabled: false,
  disable_pwd_jump: false,
  x11: false,
  x11_cookie: "",
  host_key_algorithms: "",
  ciphers: "",
  kex_algorithms: "",
};

const EMPTY: FormState = {
  name: "",
  group: "",
  tags: "",
  remark: "",
  protocol: "ssh",
  host: "",
  port: "22",
  user: "",
  authMode: "password",
  password: "",
  keyText: "",
  passphrase: "",
  jumps: [],
  ssh: { ...DEFAULT_SSH },
  rdp: {
    fullscreen: true,
    width: 1920,
    height: 1080,
    multimon: false,
    clipboard: true,
    drive_redirect: false,
    admin_session: false,
    gateway: "",
    domain: "",
  },
  serial: { ...DEFAULT_SERIAL },
};

function normalizeSshPrefs(prefs: SshPrefs): SshPrefs {
  const text = (value?: string | null) => {
    const trimmed = (value ?? "").trim();
    return trimmed ? trimmed : null;
  };
  return {
    ...prefs,
    timeout_ms: Math.max(1000, Number(prefs.timeout_ms) || 20000),
    keepalive_ms: Math.max(0, Number(prefs.keepalive_ms) || 0),
    keepalive_command_ms: Math.max(1000, Number(prefs.keepalive_command_ms) || 60000),
    encoding: text(prefs.encoding) ?? "utf-8",
    terminal_type: text(prefs.terminal_type),
    proxy: text(prefs.proxy),
    init_command: text(prefs.init_command),
    default_path: text(prefs.default_path),
    keepalive_command: text(prefs.keepalive_command),
    x11_cookie: text(prefs.x11_cookie),
    host_key_algorithms: text(prefs.host_key_algorithms),
    ciphers: text(prefs.ciphers),
    kex_algorithms: text(prefs.kex_algorithms),
    env: prefs.env
      .map((item) => ({ key: item.key.trim(), value: item.value }))
      .filter((item) => item.key),
  };
}

function toForm(profile: Profile | null, defaultProtocol: Protocol = "ssh"): FormState {
  if (!profile) {
    return {
      ...EMPTY,
      protocol: defaultProtocol,
      rdp: { ...EMPTY.rdp },
      serial: { ...DEFAULT_SERIAL },
    };
  }
  const mode = (auth: AuthRef | undefined): AuthMode =>
    auth?.kind === "password"
      ? "password"
      : auth?.kind === "key"
        ? "key"
        : auth?.kind === "keyboard_interactive"
          ? "keyboard_interactive"
          : "none";
  const jump = profile.jump.map((hop) => ({
    host: hop.target.host,
    port: String(hop.target.port),
    user: hop.target.user,
    authMode: mode(hop.auth),
    password: "",
    keyText: "",
  }));
  const serial = { ...DEFAULT_SERIAL, ...(profile.options.serial ?? {}) };
  if (!serial.port && profile.protocol === "serial") serial.port = profile.target.host;
  return {
    name: profile.name,
    group: profile.group ?? "",
    tags: profile.tags.join(", "),
    remark: profile.remark ?? "",
    protocol: profile.protocol,
    host: profile.target.host,
    port: String(profile.target.port),
    user: profile.target.user,
    authMode: mode(profile.auth),
    password: "",
    keyText: "",
    passphrase: "",
    jumps: jump,
    ssh: { ...DEFAULT_SSH, ...(profile.options.ssh ?? {}) },
    rdp: { ...EMPTY.rdp, ...(profile.options.rdp ?? {}) },
    serial,
  };
}

function existingPasswordSecret(profile: Profile | null): string | null {
  return profile?.auth.kind === "password" ? profile.auth.secret : null;
}

function existingKeySecrets(profile: Profile | null): { key: string | null; pass: string | null } {
  if (profile?.auth.kind === "key") {
    return { key: profile.auth.key, pass: profile.auth.passphrase ?? null };
  }
  return { key: null, pass: null };
}

/**
 * RDP 密码是可选的：留空不写凭据，启动 mstsc 后由系统弹窗输入。
 * 填了则只写进 vault，profile 里只保留 secret id。
 */
async function buildRdpAuth(
  initial: Profile | null,
  label: string,
  password: string,
): Promise<AuthRef> {
  if (password.trim()) {
    const existing = existingPasswordSecret(initial);
    const id = await vaultPut(existing, "password", `${label} RDP 密码`, password);
    return { kind: "password", secret: id };
  }
  return initial?.auth.kind === "password" ? initial.auth : { kind: "none" };
}

export function SessionDialog({
  open,
  initial,
  platform,
  defaultProtocol,
  onClose,
  onSaved,
  onError,
}: Props) {
  const [form, setForm] = useState<FormState>(() => toForm(initial, defaultProtocol));
  const [saving, setSaving] = useState(false);
  const [ports, setPorts] = useState<SerialPortInfo[]>([]);
  const [portsLoading, setPortsLoading] = useState(false);
  const [portsError, setPortsError] = useState<string | null>(null);
  const [navId, setNavId] = useState("sec-basic");

  useEffect(() => {
    if (open) setForm(toForm(initial, defaultProtocol));
    if (open) setNavId("sec-basic");
  }, [open, initial, defaultProtocol]);

  const refreshPorts = async () => {
    setPortsLoading(true);
    setPortsError(null);
    try {
      setPorts(await serialListPorts());
    } catch (error) {
      setPorts([]);
      setPortsError(errorText(error));
    } finally {
      setPortsLoading(false);
    }
  };

  useEffect(() => {
    if (open && form.protocol === "serial") void refreshPorts();
    // 仅在弹窗打开或切到串口时枚举一次，避免每次输入都重扫
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, form.protocol]);

  if (!open) return null;

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const updateSerial = (patch: Partial<SerialPrefs>) =>
    setForm((prev) => ({ ...prev, serial: { ...prev.serial, ...patch } }));

  const updateSsh = (patch: Partial<SshPrefs>) =>
    setForm((prev) => ({ ...prev, ssh: { ...prev.ssh, ...patch } }));

  const updateJump = (index: number, patch: Partial<JumpForm>) =>
    setForm((prev) => ({
      ...prev,
      jumps: prev.jumps.map((hop, i) => (i === index ? { ...hop, ...patch } : hop)),
    }));

  const addJump = () =>
    setForm((prev) => ({
      ...prev,
      jumps: [
        ...prev.jumps,
        { host: "", port: "22", user: "", authMode: "password", password: "", keyText: "" },
      ],
    }));

  const removeJump = (index: number) =>
    setForm((prev) => ({ ...prev, jumps: prev.jumps.filter((_, i) => i !== index) }));

  const loadKeyFile = async (index: number | null) => {
    try {
      const selected = await openFileDialog({ multiple: false, directory: false });
      if (!selected || Array.isArray(selected)) return;
      const text = await readTextFile(selected);
      if (index == null) update("keyText", text);
      else updateJump(index, { keyText: text });
    } catch (error) {
      onError(errorText(error));
    }
  };

  const applyPreset = (id: string) => {
    const preset = SERIAL_PRESETS.find((item) => item.id === id);
    if (!preset) return; // 自定义：保留当前值
    updateSerial({ ...preset.params });
  };

  const buildAuth = async (
    mode: AuthMode,
    password: string,
    keyText: string,
    passphrase: string,
    existing: AuthRef | undefined,
    label: string,
  ): Promise<AuthRef> => {
    if (mode === "none") return { kind: "none" };
    if (mode === "keyboard_interactive") return { kind: "keyboard_interactive" };
    if (mode === "password") {
      if (password.trim()) {
        const id = await vaultPut(
          existing?.kind === "password" ? existing.secret : null,
          "password",
          `${label} 密码`,
          password,
        );
        return { kind: "password", secret: id };
      }
      if (existing?.kind === "password") return existing;
      throw new Error(`${label}：请填写密码`);
    }
    // key
    let keyId = existing?.kind === "key" ? existing.key : null;
    if (keyText.trim()) {
      keyId = await vaultPut(keyId, "private_key", `${label} 私钥`, keyText);
    }
    if (!keyId) throw new Error(`${label}：请粘贴私钥内容`);
    let passId = existing?.kind === "key" ? (existing.passphrase ?? null) : null;
    if (passphrase.trim()) {
      passId = await vaultPut(passId, "passphrase", `${label} 私钥口令`, passphrase);
    }
    return { kind: "key", key: keyId, passphrase: passId };
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      if (!form.name.trim()) throw new Error("请填写名称");

      const tags = form.tags
        .split(/[,，]/)
        .map((tag) => tag.trim())
        .filter(Boolean);

      let profile: Profile;
      if (form.protocol === "serial") {
        // 串口配置与凭据无关，不触碰 vault。
        const serial: SerialPrefs = {
          ...form.serial,
          port: form.serial.port.trim(),
          baud_rate: Number(form.serial.baud_rate),
        };
        if (!serial.port) throw new Error("请选择或填写串口端口");
        if (!Number.isFinite(serial.baud_rate) || serial.baud_rate <= 0) {
          throw new Error("波特率必须大于 0");
        }
        profile = {
          id: initial?.id ?? crypto.randomUUID(),
          name: form.name.trim(),
          group: form.group.trim() || null,
          protocol: "serial",
          target: { host: serial.port, port: 0, user: "" },
          auth: { kind: "none" },
          jump: [],
          tags,
          options: { serial },
        };
      } else {
        if (!form.host.trim()) throw new Error("请填写主机地址");
        const port = Number(form.port);
        if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error("端口不合法");
        if (form.protocol === "ssh" && !form.user.trim()) throw new Error("SSH 需要用户名");

        const auth: AuthRef =
          form.protocol === "rdp"
            ? await buildRdpAuth(initial, form.name.trim(), form.password)
            : await buildAuth(
                form.authMode,
                form.password,
                form.keyText,
                form.passphrase,
                initial?.auth,
                form.name.trim(),
              );

        const jump = [];
        if (form.protocol === "ssh") {
          for (const [index, hop] of form.jumps.entries()) {
            if (!hop.host.trim() || !hop.user.trim()) {
              throw new Error(`第 ${index + 1} 层跳板机的主机和用户名不能为空`);
            }
            const hopPort = Number(hop.port) || 22;
            const hopAuth = await buildAuth(
              hop.authMode,
              hop.password,
              hop.keyText,
              "",
              initial?.jump[index]?.auth,
              `${form.name.trim()} 跳板机 ${index + 1}`,
            );
            jump.push({
              target: { host: hop.host.trim(), port: hopPort, user: hop.user.trim() },
              auth: hopAuth,
            });
          }
        }

        profile = {
          id: initial?.id ?? crypto.randomUUID(),
          name: form.name.trim(),
          group: form.group.trim() || null,
          remark: form.remark.trim() || null,
          protocol: form.protocol,
          target: {
            host: form.host.trim(),
            port,
            user: form.user.trim(),
          },
          auth,
          jump,
          tags,
          options:
            form.protocol === "rdp"
              ? { rdp: { ...form.rdp, domain: (form.rdp.domain ?? "").trim() || null } }
              : form.protocol === "ssh"
                ? { ssh: normalizeSshPrefs(form.ssh) }
                : {},
        };
      }
      const saved = await profileUpsert(profile);
      onSaved(saved);
      onClose();
    } catch (error) {
      onError(errorText(error));
    } finally {
      setSaving(false);
    }
  };

  const presetId = matchSerialPreset(form.serial);
  // RDP 依赖 Windows 的 mstsc.exe：非 Windows 不提供新建入口，编辑已有 RDP 配置时保留入口并提示。
  const isWindows = platform === "windows";
  const showRdpTab = isWindows || form.protocol === "rdp" || initial?.protocol === "rdp";
  const knownPort = ports.some((port) => port.port_name === form.serial.port);
  const portHint = portsLoading
    ? "正在枚举系统串口…"
    : portsError
      ? `枚举失败：${portsError}。可直接手动填写端口名。`
      : ports.length === 0
        ? "未检测到串口设备。请连接设备后点击刷新，或手动填写端口名。"
        : "同时插入多个 USB 转串口时，可按厂商 / 产品 / 序列号区分。";
  const serialGroupHint =
    platform === "linux"
      ? "Linux 下普通用户默认无权打开串口设备，需要先执行 sudo usermod -aG dialout $USER 并重新登录。"
      : null;
  const navItems: Array<{ id: string; label: string; icon: IconName }> =
    form.protocol === "serial"
      ? [
          { id: "sec-basic", label: "基本信息", icon: "info" },
          { id: "sec-serial", label: "串口参数", icon: "plug" },
        ]
      : form.protocol === "rdp"
        ? [
            { id: "sec-basic", label: "基本信息", icon: "info" },
            { id: "sec-rdp-auth", label: "登录凭据", icon: "lock" },
            { id: "sec-rdp", label: "RDP 参数", icon: "link" },
          ]
        : [
            { id: "sec-basic", label: "基本信息", icon: "info" },
            { id: "sec-conn", label: "连接设置", icon: "term" },
            { id: "sec-jump", label: "跳板机", icon: "link" },
            { id: "sec-proxy", label: "代理设置", icon: "lock" },
            { id: "sec-other", label: "其他设置", icon: "gear" },
            { id: "sec-init", label: "初始化", icon: "clock" },
          ];
  const jumpTo = (id: string) => {
    setNavId(id);
    document.getElementById(id)?.scrollIntoView({ block: "nearest" });
  };

  return (
    <div className="dlg-mask" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="dlg dlg-session">
        <div className="dlg-head">
          <h2>{initial ? "编辑连接" : "新建连接"}</h2>
          <div className="spacer" />
          <button className="icon-btn sm" title="关闭" onClick={onClose}>
            <Icon name="x" size={14} />
          </button>
        </div>

        <div className="dlg-body dlg-split">
          <nav className="dlg-nav">
            {navItems.map((item) => (
              <button
                key={item.id}
                className={`dlg-nav-item${navId === item.id ? " is-active" : ""}`}
                onClick={() => jumpTo(item.id)}
              >
                <Icon name={item.icon} size={14} />
                {item.label}
              </button>
            ))}
          </nav>
          <div className="dlg-form">
            <div id="sec-basic">
          <div className="dlg-seg" role="tablist">
            <button
              role="tab"
              aria-selected={form.protocol === "ssh"}
              className={form.protocol === "ssh" ? "is-active" : ""}
              onClick={() => {
                update("protocol", "ssh");
                if (form.port === "3389") update("port", "22");
              }}
            >
              SSH 终端
            </button>
            <button
              role="tab"
              aria-selected={form.protocol === "serial"}
              className={form.protocol === "serial" ? "is-active" : ""}
              onClick={() => update("protocol", "serial")}
            >
              串口
            </button>
            {showRdpTab && (
              <button
                role="tab"
                aria-selected={form.protocol === "rdp"}
                className={form.protocol === "rdp" ? "is-active" : ""}
                onClick={() => {
                  update("protocol", "rdp");
                  if (form.port === "22") update("port", "3389");
                }}
              >
                RDP 远程桌面
              </button>
            )}
          </div>

          {!isWindows && form.protocol === "rdp" && (
            <p className="update-hint">
              当前平台（{platform}）不支持 RDP 远程桌面：RDP 依赖 Windows 的 mstsc.exe。该配置可以保留，
              在 Linux 上打开时会提示平台不支持，请到 Windows 客户端使用。
            </p>
          )}
          <div className="form-grid">
            <label>
              名称 *
              <input value={form.name} onChange={(e) => update("name", e.target.value)} placeholder="生产 Web-01" />
            </label>
            <label>
              分组
              <input value={form.group} onChange={(e) => update("group", e.target.value)} placeholder="生产环境" />
            </label>
            <label>
              标签
              <input value={form.tags} onChange={(e) => update("tags", e.target.value)} placeholder="web, prod" />
            </label>
          </div>

          {form.protocol !== "serial" && (
            <div className="form-grid">
              <label className="span-2">
                主机 *
                <input value={form.host} onChange={(e) => update("host", e.target.value)} placeholder="10.0.0.10 或 example.com" />
              </label>
              <label>
                端口 *
                <input value={form.port} onChange={(e) => update("port", e.target.value)} />
              </label>
              <label>
                用户名
                <input
                  value={form.user}
                  onChange={(e) => update("user", e.target.value)}
                  placeholder={form.protocol === "rdp" ? "Administrator" : "root"}
                />
              </label>
            </div>
          )}

          {form.protocol === "ssh" && (
            <>
              <div className="form-grid">
                <label className="span-2">
                  主机备注
                  <textarea
                    rows={3}
                    value={form.remark}
                    onChange={(e) => update("remark", e.target.value)}
                    placeholder="用途、负责人、机房位置等"
                  />
                </label>
                <label>
                  超时时间（毫秒）
                  <input
                    value={form.ssh.timeout_ms}
                    onChange={(e) => updateSsh({ timeout_ms: Number(e.target.value) || 0 })}
                    placeholder="20000"
                  />
                </label>
                <label>
                  心跳时间（毫秒）
                  <input
                    value={form.ssh.keepalive_ms}
                    onChange={(e) => updateSsh({ keepalive_ms: Number(e.target.value) || 0 })}
                    placeholder="5000，0 表示关闭"
                  />
                </label>
              </div>

              <div className="section-title">认证</div>
              <div className="form-grid">
                <label>
                  验证方式
                  <select
                    value={form.authMode}
                    onChange={(e) => update("authMode", e.target.value as AuthMode)}
                  >
                    <option value="password">密码</option>
                    <option value="key">秘钥</option>
                    <option value="keyboard_interactive">交互认证（OTP / 安全问题）</option>
                  </select>
                </label>
                {form.authMode === "password" && (
                  <label>
                    密码 {existingPasswordSecret(initial) && <span className="muted">（留空沿用已保存密码）</span>}
                    <input
                      type="password"
                      value={form.password}
                      onChange={(e) => update("password", e.target.value)}
                      placeholder={existingPasswordSecret(initial) ? "••••••••" : ""}
                    />
                  </label>
                )}
                {form.authMode === "key" && (
                  <>
                    <label className="span-2">
                      登录秘钥
                      <textarea
                        rows={5}
                        value={form.keyText}
                        onChange={(e) => update("keyText", e.target.value)}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={(e) => {
                          e.preventDefault();
                          const file = e.dataTransfer.files[0];
                          if (file) void file.text().then((text) => update("keyText", text));
                        }}
                        placeholder={
                          existingKeySecrets(initial).key
                            ? "已保存私钥，留空则不修改"
                            : "-----BEGIN OPENSSH PRIVATE KEY-----（也可拖拽文件到此处）"
                        }
                      />
                    </label>
                    <div className="span-2 key-actions">
                      <button type="button" className="btn-ghost sm" onClick={() => void loadKeyFile(null)}>
                        加载本地秘钥
                      </button>
                      <span className="muted">或把私钥文件拖拽到上方输入框</span>
                    </div>
                    <label>
                      私钥口令（可选）
                      <input
                        type="password"
                        value={form.passphrase}
                        onChange={(e) => update("passphrase", e.target.value)}
                        placeholder={existingKeySecrets(initial).pass ? "已保存口令" : ""}
                      />
                    </label>
                  </>
                )}
                {form.authMode === "keyboard_interactive" && (
                  <p className="update-hint span-2">
                    连接时服务端会逐轮返回提示，弹窗输入 OTP / 安全问题等内容；输入不会保存到本地。
                  </p>
                )}
              </div>
            </>
          )}
            </div>

          {form.protocol === "serial" && (
            <div id="sec-serial">
              <div className="section-title">串口参数</div>
              <div className="form-grid">
                <label className="span-2">
                  参数预设
                  <select value={presetId} onChange={(e) => applyPreset(e.target.value)}>
                    {SERIAL_PRESETS.map((preset) => (
                      <option key={preset.id} value={preset.id}>
                        {preset.label}
                      </option>
                    ))}
                    <option value="custom">自定义</option>
                  </select>
                  <span className="muted">
                    预设只回填波特率 / 数据位 / 停止位 / 校验 / 流控，不改变端口；单独修改任一参数后自动显示为自定义。
                  </span>
                </label>

                <div className="form-field span-2">
                  <span className="field-label">串口端口 *</span>
                  <div className="field-row">
                    {ports.length > 0 ? (
                      <select
                        value={form.serial.port}
                        onChange={(e) => updateSerial({ port: e.target.value })}
                      >
                        {!form.serial.port && <option value="">请选择端口</option>}
                        {form.serial.port && !knownPort && (
                          <option value={form.serial.port}>
                            {form.serial.port}（当前配置，未检测到）
                          </option>
                        )}
                        {ports.map((port) => (
                          <option key={port.port_name} value={port.port_name}>
                            {port.description
                              ? `${port.description} (${port.port_name})`
                              : port.port_name}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        value={form.serial.port}
                        onChange={(e) => updateSerial({ port: e.target.value })}
                        placeholder="COM3 或 /dev/ttyUSB0"
                      />
                    )}
                    <button
                      type="button"
                      className="btn-ghost sm"
                      onClick={() => void refreshPorts()}
                      disabled={portsLoading}
                    >
                      {portsLoading ? "刷新中…" : "刷新"}
                    </button>
                  </div>
                  <span className="muted">{portHint}</span>
                </div>

                <label>
                  波特率 *
                  <input
                    list="baud-presets"
                    value={form.serial.baud_rate}
                    onChange={(e) => updateSerial({ baud_rate: Number(e.target.value) || 0 })}
                    placeholder="115200"
                  />
                  <datalist id="baud-presets">
                    {[9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600].map((value) => (
                      <option key={value} value={value} />
                    ))}
                  </datalist>
                </label>
                <label>
                  数据位
                  <select
                    value={form.serial.data_bits}
                    onChange={(e) => updateSerial({ data_bits: Number(e.target.value) })}
                  >
                    {[5, 6, 7, 8].map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  停止位
                  <select
                    value={form.serial.stop_bits}
                    onChange={(e) => updateSerial({ stop_bits: Number(e.target.value) })}
                  >
                    <option value={1}>1</option>
                    <option value={2}>2</option>
                  </select>
                </label>
                <label>
                  校验
                  <select
                    value={form.serial.parity}
                    onChange={(e) => updateSerial({ parity: e.target.value as SerialParity })}
                  >
                    <option value="none">无（N）</option>
                    <option value="odd">奇（O）</option>
                    <option value="even">偶（E）</option>
                  </select>
                </label>
                <label>
                  流控
                  <select
                    value={form.serial.flow_control}
                    onChange={(e) =>
                      updateSerial({ flow_control: e.target.value as SerialFlowControl })
                    }
                  >
                    <option value="none">无</option>
                    <option value="hardware">硬件（RTS/CTS）</option>
                    <option value="software">软件（XON/XOFF）</option>
                  </select>
                </label>
                <label className="inline">
                  <input
                    type="checkbox"
                    checked={form.serial.dtr}
                    onChange={(e) => updateSerial({ dtr: e.target.checked })}
                  />
                  DTR 拉高（默认开启）
                </label>
                <label className="inline">
                  <input
                    type="checkbox"
                    checked={form.serial.rts}
                    onChange={(e) => updateSerial({ rts: e.target.checked })}
                  />
                  RTS 拉高（默认开启）
                </label>
                <label className="inline">
                  <input
                    type="checkbox"
                    checked={form.serial.local_echo}
                    onChange={(e) => updateSerial({ local_echo: e.target.checked })}
                  />
                  本地回显（默认关闭）
                </label>
                <label>
                  换行处理
                  <select
                    value={form.serial.newline}
                    onChange={(e) => updateSerial({ newline: e.target.value as SerialNewline })}
                  >
                    <option value="raw">原样（默认）</option>
                    <option value="cr_to_crlf">CR → CRLF</option>
                    <option value="lf_to_crlf">LF → CRLF</option>
                  </select>
                </label>
                <p className="serial-hint span-2">
                  DTR/RTS 默认拉高：部分交换机 console 需要 DTR 有效才会输出，连接后可在终端面板顶部实时切换，立即生效；
                  启用硬件流控时 RTS 由驱动接管。本地回显默认关闭，设备自身已回显时不会重复显示；开启后会把你输入的字符显示在本地。
                  换行默认原样透传，遇到设备显示错行再改为 CR→CRLF 或 LF→CRLF。
                </p>
                {serialGroupHint && (
                  <p className="serial-hint span-2">{serialGroupHint}</p>
                )}
              </div>
            </div>
          )}

          {form.protocol === "rdp" && (
            <div id="sec-rdp-auth">
              <div className="section-title">登录凭据（写入 Windows 凭据管理器，不落配置文件）</div>
              <div className="form-grid">
                <label>
                  域 / 工作组（可选）
                  <input
                    value={form.rdp.domain ?? ""}
                    onChange={(e) => update("rdp", { ...form.rdp, domain: e.target.value })}
                    placeholder="CORP 或 .（本机账户）"
                  />
                </label>
                <label>
                  密码
                  <span className="muted">（留空则启动后由 mstsc 弹窗输入）</span>
                  <input
                    type="password"
                    value={form.password}
                    onChange={(e) => update("password", e.target.value)}
                    placeholder={existingPasswordSecret(initial) ? "••••••••（留空沿用已保存密码）" : ""}
                  />
                </label>
              </div>
            </div>
          )}

          {form.protocol === "ssh" && (
            <div id="sec-conn">
              <div className="section-title">连接设置</div>
              <div className="form-grid">
                <label>
                  编码
                  <select
                    value={form.ssh.encoding ?? "utf-8"}
                    onChange={(e) => updateSsh({ encoding: e.target.value })}
                  >
                    <option value="utf-8">UTF-8</option>
                    <option value="gbk">GBK</option>
                    <option value="gb18030">GB18030</option>
                    <option value="big5">BIG5</option>
                  </select>
                  <span className="muted">远端输出按该编码解码，本地输入按该编码回写。</span>
                </label>
                <label>
                  终端类型
                  <input
                    value={form.ssh.terminal_type ?? ""}
                    onChange={(e) => updateSsh({ terminal_type: e.target.value })}
                    placeholder="xterm-256color"
                  />
                  <span className="muted">留空使用 xterm-256color。</span>
                </label>
              </div>
            </div>
          )}

          {form.protocol === "ssh" && (
            <div id="sec-jump">
              <div className="section-title">跳板机链路（按顺序连接，第一项最先连接）</div>
              <div className="jump-list">
                {form.jumps.map((hop, index) => (
                  <div className="jump-card" key={index}>
                    <div className="jump-head">
                      <span>第 {index + 1} 层</span>
                      <button type="button" className="btn-ghost sm" onClick={() => removeJump(index)}>
                        移除
                      </button>
                    </div>
                    <div className="form-grid">
                      <label className="span-2">
                        主机 *
                        <input
                          value={hop.host}
                          onChange={(e) => updateJump(index, { host: e.target.value })}
                          placeholder="跳板机地址"
                        />
                      </label>
                      <label>
                        端口
                        <input
                          value={hop.port}
                          onChange={(e) => updateJump(index, { port: e.target.value })}
                        />
                      </label>
                      <label>
                        用户名 *
                        <input
                          value={hop.user}
                          onChange={(e) => updateJump(index, { user: e.target.value })}
                        />
                      </label>
                      <label>
                        认证
                        <select
                          value={hop.authMode}
                          onChange={(e) =>
                            updateJump(index, { authMode: e.target.value as AuthMode })
                          }
                        >
                          <option value="password">密码</option>
                          <option value="key">秘钥</option>
                          <option value="keyboard_interactive">交互认证</option>
                          <option value="none">无</option>
                        </select>
                      </label>
                      {hop.authMode === "password" && (
                        <label>
                          密码
                          <input
                            type="password"
                            value={hop.password}
                            onChange={(e) => updateJump(index, { password: e.target.value })}
                            placeholder={
                              initial?.jump[index]?.auth.kind === "password" ? "留空沿用" : ""
                            }
                          />
                        </label>
                      )}
                      {hop.authMode === "key" && (
                        <label className="span-2">
                          私钥
                          <textarea
                            rows={4}
                            value={hop.keyText}
                            onChange={(e) => updateJump(index, { keyText: e.target.value })}
                            onDragOver={(e) => e.preventDefault()}
                            onDrop={(e) => {
                              e.preventDefault();
                              const file = e.dataTransfer.files[0];
                              if (file) void file.text().then((text) => updateJump(index, { keyText: text }));
                            }}
                            placeholder={
                              initial?.jump[index]?.auth.kind === "key"
                                ? "已保存私钥，留空不修改"
                                : "粘贴私钥，或拖拽文件到此处"
                            }
                          />
                          <button
                            type="button"
                            className="btn-ghost sm key-load"
                            onClick={() => void loadKeyFile(index)}
                          >
                            加载本地秘钥
                          </button>
                        </label>
                      )}
                    </div>
                  </div>
                ))}
              </div>
              <button type="button" className="btn-ghost sm" onClick={addJump}>
                + 添加跳板机
              </button>
            </div>
          )}

          {form.protocol === "ssh" && (
            <div id="sec-proxy">
              <div className="section-title">代理设置</div>
              <div className="form-grid">
                <label className="inline span-2">
                  <input
                    type="checkbox"
                    checked={form.ssh.proxy_disabled}
                    onChange={(e) => updateSsh({ proxy_disabled: e.target.checked })}
                  />
                  禁用代理
                </label>
                <label className="span-2">
                  代理地址
                  <input
                    value={form.ssh.proxy ?? ""}
                    onChange={(e) => updateSsh({ proxy: e.target.value })}
                    placeholder="socks5://127.0.0.1:1080 或 http://user:pass@127.0.0.1:8080"
                    disabled={form.ssh.proxy_disabled}
                  />
                  <span className="muted">
                    支持 socks5://、socks5h://、http://；用户名密码可直接写在地址中。
                  </span>
                </label>
                <p className="update-hint span-2">
                  代理在建立 SSH 连接前完成握手；仅代理首层连接，跳板机之间的通道仍走 SSH。
                </p>
              </div>
            </div>
          )}

          {form.protocol === "ssh" && (
            <div id="sec-other">
              <div className="section-title">其他设置</div>
              <div className="form-grid">
                <label className="inline span-2">
                  <input
                    type="checkbox"
                    checked={form.ssh.monitor_disabled}
                    onChange={(e) => updateSsh({ monitor_disabled: e.target.checked })}
                  />
                  禁止列表监控
                  <span className="pending-tag">暂未生效</span>
                </label>
                <label className="inline span-2">
                  <input
                    type="checkbox"
                    checked={form.ssh.disable_pwd_jump}
                    onChange={(e) => updateSsh({ disable_pwd_jump: e.target.checked })}
                  />
                  禁用 pwd 自动跳转
                  <span className="pending-tag">暂未生效</span>
                </label>
                <label className="inline span-2">
                  <input
                    type="checkbox"
                    checked={form.ssh.x11}
                    onChange={(e) => updateSsh({ x11: e.target.checked })}
                  />
                  启用 X11 转发
                  <span className="pending-tag">暂未生效</span>
                </label>
                <label className="span-2">
                  X11 Cookie
                  <input
                    value={form.ssh.x11_cookie ?? ""}
                    onChange={(e) => updateSsh({ x11_cookie: e.target.value })}
                    disabled={!form.ssh.x11}
                    placeholder="MIT-MAGIC-COOKIE-1"
                  />
                </label>
                <label>
                  主机密钥算法
                  <input
                    value={form.ssh.host_key_algorithms ?? ""}
                    onChange={(e) => updateSsh({ host_key_algorithms: e.target.value })}
                    placeholder="ssh-ed25519,rsa-sha2-512"
                  />
                  <span className="pending-tag">暂未生效</span>
                </label>
                <label>
                  Cipher 算法
                  <input
                    value={form.ssh.ciphers ?? ""}
                    onChange={(e) => updateSsh({ ciphers: e.target.value })}
                    placeholder="aes256-gcm@openssh.com"
                  />
                  <span className="pending-tag">暂未生效</span>
                </label>
                <label className="span-2">
                  密钥交换算法
                  <input
                    value={form.ssh.kex_algorithms ?? ""}
                    onChange={(e) => updateSsh({ kex_algorithms: e.target.value })}
                    placeholder="curve25519-sha256"
                  />
                  <span className="pending-tag">暂未生效</span>
                </label>
              </div>
            </div>
          )}

          {form.protocol === "ssh" && (
            <div id="sec-init">
              <div className="section-title">初始化</div>
              <div className="form-grid">
                <label className="span-2">
                  默认路径
                  <input
                    value={form.ssh.default_path ?? ""}
                    onChange={(e) => updateSsh({ default_path: e.target.value })}
                    placeholder="/var/www"
                  />
                  <span className="muted">登录后自动执行 cd（路径会做 shell 转义）。</span>
                </label>
                <label className="span-2">
                  初始执行命令
                  <textarea
                    rows={3}
                    value={form.ssh.init_command ?? ""}
                    onChange={(e) => updateSsh({ init_command: e.target.value })}
                    placeholder="例如：export LANG=en_US.UTF-8"
                  />
                </label>
                <label className="span-2">
                  保活命令
                  <input
                    value={form.ssh.keepalive_command ?? ""}
                    onChange={(e) => updateSsh({ keepalive_command: e.target.value })}
                    placeholder="例如：echo keepalive"
                  />
                </label>
                <label>
                  保活周期（毫秒）
                  <input
                    value={form.ssh.keepalive_command_ms}
                    onChange={(e) =>
                      updateSsh({ keepalive_command_ms: Number(e.target.value) || 0 })
                    }
                    placeholder="60000"
                  />
                </label>
                <div className="span-2">
                  <div className="section-subtitle">
                    环境变量
                    <button
                      type="button"
                      className="btn-ghost sm"
                      onClick={() =>
                        updateSsh({ env: [...form.ssh.env, { key: "", value: "" }] })
                      }
                    >
                      + 添加
                    </button>
                  </div>
                  {form.ssh.env.map((item, index) => (
                    <div className="env-row" key={index}>
                      <input
                        value={item.key}
                        onChange={(e) =>
                          updateSsh({
                            env: form.ssh.env.map((entry, i) =>
                              i === index ? { ...entry, key: e.target.value } : entry,
                            ),
                          })
                        }
                        placeholder="变量名"
                      />
                      <input
                        value={item.value}
                        onChange={(e) =>
                          updateSsh({
                            env: form.ssh.env.map((entry, i) =>
                              i === index ? { ...entry, value: e.target.value } : entry,
                            ),
                          })
                        }
                        placeholder="变量值"
                      />
                      <button
                        type="button"
                        className="btn-ghost sm"
                        onClick={() =>
                          updateSsh({ env: form.ssh.env.filter((_, i) => i !== index) })
                        }
                      >
                        删除
                      </button>
                    </div>
                  ))}
                  {form.ssh.env.length === 0 && (
                    <p className="muted">登录后通过 SSH SetEnv 下发；服务端拒绝时不阻断登录。</p>
                  )}
                </div>
              </div>
            </div>
          )}

          {form.protocol === "rdp" && (
            <div id="sec-rdp">
              <div className="section-title">RDP 参数（写入 .rdp 后调用 mstsc.exe）</div>
              <div className="form-grid">
                <label className="inline">
                  <input
                    type="checkbox"
                    checked={form.rdp.fullscreen}
                    onChange={(e) => update("rdp", { ...form.rdp, fullscreen: e.target.checked })}
                  />
                  全屏
                </label>
                <label className="inline">
                  <input
                    type="checkbox"
                    checked={form.rdp.clipboard}
                    onChange={(e) => update("rdp", { ...form.rdp, clipboard: e.target.checked })}
                  />
                  剪贴板
                </label>
                <label>
                  宽度
                  <input
                    value={form.rdp.width}
                    onChange={(e) => update("rdp", { ...form.rdp, width: Number(e.target.value) || 0 })}
                  />
                </label>
                <label>
                  高度
                  <input
                    value={form.rdp.height}
                    onChange={(e) => update("rdp", { ...form.rdp, height: Number(e.target.value) || 0 })}
                  />
                </label>
                <label className="inline">
                  <input
                    type="checkbox"
                    checked={form.rdp.multimon}
                    onChange={(e) => update("rdp", { ...form.rdp, multimon: e.target.checked })}
                  />
                  多显示器
                </label>
                <label className="inline">
                  <input
                    type="checkbox"
                    checked={form.rdp.drive_redirect}
                    onChange={(e) => update("rdp", { ...form.rdp, drive_redirect: e.target.checked })}
                  />
                  映射本地磁盘
                </label>
                <label className="inline">
                  <input
                    type="checkbox"
                    checked={form.rdp.admin_session}
                    onChange={(e) => update("rdp", { ...form.rdp, admin_session: e.target.checked })}
                  />
                  管理员会话
                </label>
                <label>
                  RD 网关（可选）
                  <input
                    value={form.rdp.gateway ?? ""}
                    onChange={(e) => update("rdp", { ...form.rdp, gateway: e.target.value })}
                  />
                </label>
              </div>
            </div>
          )}
          </div>
        </div>

        <div className="dlg-foot">
          <span className="muted">密码/私钥加密保存在本地凭据库，不会写入配置文件。</span>
          <div className="spacer" />
          <button className="btn-ghost" onClick={onClose}>
            取消
          </button>
          <button className="btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}
