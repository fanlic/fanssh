import { useEffect, useRef, useState } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import {
  errorText,
  profileUpsert,
  readTextFile,
  sshTestConnection,
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
  TelnetPrefs,
  TunnelKind,
  TunnelPrefs,
  TunnelRoute,
  VncPrefs,
} from "../types";
import { Icon, type IconName } from "./Icon";
import { useAppStore } from "../store";

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
  telnet: TelnetPrefs;
  vnc: VncPrefs;
  tunnel: TunnelPrefs;
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

const DEFAULT_TUNNEL: TunnelPrefs = {
  server_id: null,
  auto_reconnect: true,
  routes: [],
};

const DEFAULT_TELNET: TelnetPrefs = {
  enable_mapping: false,
  mapping_preset: "standard",
};

const DEFAULT_VNC: VncPrefs = {
  auth_method: "vnc",
  read_only: false,
  shared: true,
  scale_viewport: true,
  crop_viewport: false,
  quality: 6,
  compression: 2,
};

const DEFAULT_PORT_BY_PROTOCOL: Record<Protocol, string> = {
  ssh: "22",
  rdp: "3389",
  serial: "",
  telnet: "23",
  tunnel: "",
  vnc: "5900",
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
  telnet: { ...DEFAULT_TELNET },
  vnc: { ...DEFAULT_VNC },
  tunnel: { ...DEFAULT_TUNNEL, routes: [] },
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
      telnet: { ...DEFAULT_TELNET },
      vnc: { ...DEFAULT_VNC },
      tunnel: { ...DEFAULT_TUNNEL, routes: [] },
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
  const tunnel: TunnelPrefs = {
    ...DEFAULT_TUNNEL,
    ...(profile.options.tunnel ?? {}),
    routes: (profile.options.tunnel?.routes ?? []).map((route) => ({
      ...route,
      local_host: route.local_host || "127.0.0.1",
    })),
  };
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
    telnet: { ...DEFAULT_TELNET, ...(profile.options.telnet ?? {}) },
    vnc: { ...DEFAULT_VNC, ...(profile.options.vnc ?? {}) },
    tunnel,
  };
}

/** 不同转发类型下字段的实际含义不同，标签随之切换。 */
function routeLabels(kind: TunnelKind): { listen: string; target: string; hint: string } {
  switch (kind) {
    case "remote":
      return {
        listen: "服务器监听地址",
        target: "本机目标地址",
        hint: "远程转发：服务器监听该端口，收到的连接通过 SSH 回连本机目标。",
      };
    case "dynamic":
      return {
        listen: "本机监听地址（SOCKS5）",
        target: "",
        hint: "动态代理：本机提供 SOCKS5 服务，目标地址由客户端在连接时指定。",
      };
    default:
      return {
        listen: "本机监听地址",
        target: "远端目标地址",
        hint: "本地转发：从本机访问远端。示例：本机 127.0.0.1:3000 -> server:80。",
      };
  }
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
 * RDP 密码是可选的：留空不写凭据，连接时由前端一次性弹窗输入（支持空密码）。
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
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ kind: "ok" | "error"; message: string } | null>(null);
  const protocolPorts = useRef<Record<Protocol, string>>({ ...DEFAULT_PORT_BY_PROTOCOL });
  const [ports, setPorts] = useState<SerialPortInfo[]>([]);
  const [portsLoading, setPortsLoading] = useState(false);
  const [portsError, setPortsError] = useState<string | null>(null);
  const [navId, setNavId] = useState("sec-basic");
  const profiles = useAppStore((state) => state.profiles);
  const sshServers = profiles.filter((profile) => profile.protocol === "ssh");

  useEffect(() => {
    if (open) {
      const nextForm = toForm(initial, defaultProtocol);
      protocolPorts.current = { ...DEFAULT_PORT_BY_PROTOCOL, [nextForm.protocol]: nextForm.port };
      setForm(nextForm);
      setNavId("sec-basic");
    }
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

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setTestResult(null);
    setForm((prev) => {
      if (key === "port") protocolPorts.current[prev.protocol] = String(value);
      return { ...prev, [key]: value };
    });
  };

  const switchProtocol = (protocol: Protocol) => {
    setTestResult(null);
    setForm((prev) => {
      protocolPorts.current[prev.protocol] = prev.port;
      return {
        ...prev,
        protocol,
        port: protocolPorts.current[protocol] ?? DEFAULT_PORT_BY_PROTOCOL[protocol],
      };
    });
  };

  const buildSshTestProfile = (): Profile => {
    if (!form.host.trim()) throw new Error("请填写主机地址");
    if (!form.user.trim()) throw new Error("SSH 需要用户名");
    const port = Number(form.port);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error("端口需要是 1 ~ 65535");
    let auth: AuthRef;
    if (form.authMode === "password") {
      const existing = initial?.auth.kind === "password" ? initial.auth.secret : null;
      if (!form.password.trim() && !existing) throw new Error("请填写密码");
      auth = { kind: "password", secret: existing ?? crypto.randomUUID() };
    } else if (form.authMode === "key") {
      const existing = initial?.auth.kind === "key" ? initial.auth : null;
      if (!form.keyText.trim() && !existing?.key) throw new Error("请粘贴或加载私钥内容");
      auth = {
        kind: "key",
        key: existing?.key ?? crypto.randomUUID(),
        passphrase: existing?.passphrase ?? null,
      };
    } else if (form.authMode === "keyboard_interactive") {
      auth = { kind: "keyboard_interactive" };
    } else {
      auth = { kind: "none" };
    }
    return {
      id: initial?.id ?? crypto.randomUUID(),
      name: form.name.trim() || `${form.user.trim()}@${form.host.trim()}`,
      group: form.group.trim() || null,
      remark: form.remark.trim() || null,
      protocol: "ssh",
      target: { host: form.host.trim(), port, user: form.user.trim() },
      auth,
      jump: [],
      tags: form.tags
        .split(/[,，]/)
        .map((tag) => tag.trim())
        .filter(Boolean),
      options: { ssh: normalizeSshPrefs(form.ssh) },
    };
  };

  const handleTestConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const message = await sshTestConnection(buildSshTestProfile(), {
        password: form.password || null,
        key_text: form.keyText || null,
        passphrase: form.passphrase || null,
      });
      setTestResult({ kind: "ok", message });
    } catch (error) {
      setTestResult({ kind: "error", message: errorText(error) });
    } finally {
      setTesting(false);
    }
  };

  const updateSerial = (patch: Partial<SerialPrefs>) =>
    setForm((prev) => ({ ...prev, serial: { ...prev.serial, ...patch } }));

  const updateSsh = (patch: Partial<SshPrefs>) =>
    setForm((prev) => ({ ...prev, ssh: { ...prev.ssh, ...patch } }));

  const updateTunnel = (patch: Partial<TunnelPrefs>) =>
    setForm((prev) => ({ ...prev, tunnel: { ...prev.tunnel, ...patch } }));

  const updateRoute = (index: number, patch: Partial<TunnelRoute>) =>
    setForm((prev) => ({
      ...prev,
      tunnel: {
        ...prev.tunnel,
        routes: prev.tunnel.routes.map((route, i) =>
          i === index ? { ...route, ...patch } : route,
        ),
      },
    }));

  const addRoute = (preset: Partial<TunnelRoute> = {}) =>
    setForm((prev) => ({
      ...prev,
      tunnel: {
        ...prev.tunnel,
        routes: [
          ...prev.tunnel.routes,
          {
            id: crypto.randomUUID(),
            kind: "local",
            local_host: "127.0.0.1",
            local_port: 8080,
            remote_host: "127.0.0.1",
            remote_port: 80,
            ...preset,
          },
        ],
      },
    }));

  const removeRoute = (index: number) =>
    setForm((prev) => ({
      ...prev,
      tunnel: {
        ...prev.tunnel,
        routes: prev.tunnel.routes.filter((_, i) => i !== index),
      },
    }));

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
      if (form.protocol === "tunnel") {
        const server = sshServers.find((item) => item.id === form.tunnel.server_id);
        if (!server) throw new Error("请选择隧道使用的 SSH 服务器");
        if (form.tunnel.routes.length === 0) throw new Error("请至少添加一条转发路由");
        const routes: TunnelRoute[] = form.tunnel.routes.map((route, index) => {
          const localPort = Number(route.local_port);
          if (!Number.isInteger(localPort) || localPort <= 0 || localPort > 65535) {
            throw new Error(`第 ${index + 1} 条路由的监听端口不合法`);
          }
          if (route.kind === "dynamic") {
            return {
              id: route.id,
              kind: route.kind,
              local_host: route.local_host.trim() || "127.0.0.1",
              local_port: localPort,
              remote_host: "",
              remote_port: 0,
            };
          }
          const remotePort = Number(route.remote_port);
          if (!route.remote_host.trim()) {
            throw new Error(`第 ${index + 1} 条路由的目标地址不能为空`);
          }
          if (!Number.isInteger(remotePort) || remotePort <= 0 || remotePort > 65535) {
            throw new Error(`第 ${index + 1} 条路由的目标端口不合法`);
          }
          return {
            id: route.id,
            kind: route.kind,
            local_host: route.local_host.trim() || "127.0.0.1",
            local_port: localPort,
            remote_host: route.remote_host.trim(),
            remote_port: remotePort,
          };
        });
        profile = {
          id: initial?.id ?? crypto.randomUUID(),
          name: form.name.trim(),
          group: form.group.trim() || null,
          protocol: "tunnel",
          // target 跟随服务器，便于侧栏显示与搜索；实际连接只使用 server_id。
          target: { ...server.target },
          auth: { kind: "none" },
          jump: [],
          tags,
          options: {
            tunnel: {
              server_id: server.id,
              auto_reconnect: form.tunnel.auto_reconnect,
              routes,
            },
          },
        };
      } else if (form.protocol === "telnet") {
        if (!form.host.trim()) throw new Error("请填写 Telnet 地址");
        const port = Number(form.port);
        if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error("端口不合法");
        let auth: AuthRef = { kind: "none" };
        if (form.password.trim()) {
          const existing = initial?.auth.kind === "password" ? initial.auth.secret : null;
          const id = await vaultPut(
            existing,
            "password",
            `${form.name.trim()} Telnet 密码`,
            form.password,
          );
          auth = { kind: "password", secret: id };
        } else if (initial?.auth.kind === "password") {
          auth = initial.auth;
        }
        profile = {
          id: initial?.id ?? crypto.randomUUID(),
          name: form.name.trim(),
          group: form.group.trim() || null,
          remark: form.remark.trim() || null,
          protocol: "telnet",
          target: {
            host: form.host.trim(),
            port,
            user: form.user.trim(),
          },
          auth,
          jump: [],
          tags,
          options: { telnet: { ...form.telnet } },
        };
      } else if (form.protocol === "vnc") {
        if (!form.host.trim()) throw new Error("请填写 VNC 地址");
        const port = Number(form.port);
        if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error("端口不合法");
        let auth: AuthRef = { kind: "none" };
        if (form.vnc.auth_method === "vnc") {
          const existing = initial?.auth.kind === "password" ? initial.auth.secret : null;
          if (form.password.trim()) {
            const id = await vaultPut(
              existing,
              "password",
              `${form.name.trim()} VNC 密码`,
              form.password,
            );
            auth = { kind: "password", secret: id };
          } else if (existing) {
            auth = { kind: "password", secret: existing };
          } else {
            throw new Error("VNC 密码认证需要填写密码");
          }
        }
        profile = {
          id: initial?.id ?? crypto.randomUUID(),
          name: form.name.trim(),
          group: form.group.trim() || null,
          remark: form.remark.trim() || null,
          protocol: "vnc",
          target: {
            host: form.host.trim(),
            port,
            user: "",
          },
          auth,
          jump: [],
          tags,
          options: { vnc: { ...form.vnc } },
        };
      } else if (form.protocol === "serial") {
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
    form.protocol === "tunnel"
      ? [
          { id: "sec-basic", label: "基本信息", icon: "info" },
          { id: "sec-tunnel", label: "路由", icon: "transfer" },
        ]
      : form.protocol === "serial"
      ? [
          { id: "sec-basic", label: "基本信息", icon: "info" },
          { id: "sec-serial", label: "串口参数", icon: "plug" },
        ]
      : form.protocol === "telnet"
        ? [
            { id: "sec-basic", label: "基本信息", icon: "info" },
            { id: "sec-telnet-mapping", label: "按键映射", icon: "term" },
          ]
        : form.protocol === "vnc"
        ? [
            { id: "sec-basic", label: "基础", icon: "info" },
            { id: "sec-vnc-display", label: "显示", icon: "link" },
            { id: "sec-vnc-advanced", label: "高级", icon: "gear" },
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
          <label className="dlg-protocol-select">
            协议
            <select value={form.protocol} onChange={(event) => switchProtocol(event.target.value as Protocol)}>
              <option value="ssh">SSH 终端</option>
              <option value="serial">串口</option>
              <option value="rdp">RDP 远程桌面</option>
              <option value="telnet">Telnet</option>
              <option value="tunnel">隧道</option>
              <option value="vnc">VNC</option>
            </select>
          </label>
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
            <div id="sec-basic" className="dlg-card">
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

          {form.protocol !== "serial" && form.protocol !== "tunnel" && (
            <div className="form-grid">
              <label className="span-2">
                主机 *
                <input value={form.host} onChange={(e) => update("host", e.target.value)} placeholder="10.0.0.10 或 example.com" />
              </label>
              <label>
                端口 *
                <input value={form.port} onChange={(e) => update("port", e.target.value)} />
              </label>
              {form.protocol !== "vnc" && (
                <label>
                  用户名
                  <input
                    value={form.user}
                    onChange={(e) => update("user", e.target.value)}
                    placeholder={form.protocol === "rdp" ? "Administrator" : "root"}
                  />
                </label>
              )}
            </div>
          )}

          {form.protocol === "telnet" && (
            <div className="form-grid">
              <label className="span-2">
                密码
                <input
                  type="password"
                  value={form.password}
                  onChange={(e) => update("password", e.target.value)}
                  placeholder={
                    initial?.auth.kind === "password" ? "留空沿用已保存的密码" : "可选，连接后自动填写"
                  }
                />
              </label>
              <p className="update-hint span-2">
                Telnet 是明文协议：用户名、密码和全部会话数据都会以明文在网络上传输，仅在可信网络中使用。
                凭据仍保存在本地加密凭据库中。
              </p>
              <label className="span-2">
                备注
                <textarea
                  rows={2}
                  value={form.remark}
                  onChange={(e) => update("remark", e.target.value)}
                  placeholder="用途、负责人等"
                />
              </label>
            </div>
          )}

          {form.protocol === "vnc" && (
            <div className="form-grid">
              <label>
                认证方式
                <select
                  value={form.vnc.auth_method}
                  onChange={(e) =>
                    setForm((prev) => ({
                      ...prev,
                      vnc: { ...prev.vnc, auth_method: e.target.value as VncPrefs["auth_method"] },
                    }))
                  }
                >
                  <option value="vnc">VNC 密码</option>
                  <option value="none">无认证</option>
                </select>
                <span className="muted">使用 VNC 密码完成认证。</span>
              </label>
              {form.vnc.auth_method === "vnc" && (
                <label>
                  密码
                  <input
                    type="password"
                    value={form.password}
                    onChange={(e) => update("password", e.target.value)}
                    placeholder={
                      initial?.auth.kind === "password" ? "留空沿用已保存的密码" : "VNC 登录密码"
                    }
                  />
                </label>
              )}
              <label className="span-2">
                备注
                <textarea
                  rows={2}
                  value={form.remark}
                  onChange={(e) => update("remark", e.target.value)}
                  placeholder="用途、负责人等"
                />
              </label>
              <label className="inline span-2">
                <input
                  type="checkbox"
                  checked={form.vnc.read_only}
                  onChange={(e) =>
                    setForm((prev) => ({
                      ...prev,
                      vnc: { ...prev.vnc, read_only: e.target.checked },
                    }))
                  }
                />
                只读
                <span className="muted">（只看画面，不发送键盘和鼠标）</span>
              </label>
              <label className="inline span-2">
                <input
                  type="checkbox"
                  checked={form.vnc.shared}
                  onChange={(e) =>
                    setForm((prev) => ({
                      ...prev,
                      vnc: { ...prev.vnc, shared: e.target.checked },
                    }))
                  }
                />
                共享连接
                <span className="muted">（允许其他客户端同时接入）</span>
              </label>
            </div>
          )}

          {form.protocol === "vnc" && (
            <div id="sec-vnc-display" className="dlg-card">
              <div className="section-title">显示</div>
              <div className="form-grid">
                <label className="inline span-2">
                  <input
                    type="checkbox"
                    checked={form.vnc.scale_viewport}
                    onChange={(e) =>
                      setForm((prev) => ({
                        ...prev,
                        vnc: { ...prev.vnc, scale_viewport: e.target.checked },
                      }))
                    }
                  />
                  缩放视口
                  <span className="muted">（关掉后按原始像素显示，可滚动查看）</span>
                </label>
                <label className="inline span-2">
                  <input
                    type="checkbox"
                    checked={form.vnc.crop_viewport}
                    onChange={(e) =>
                      setForm((prev) => ({
                        ...prev,
                        vnc: { ...prev.vnc, crop_viewport: e.target.checked },
                      }))
                    }
                  />
                  裁剪视口
                  <span className="muted">（超出面板的部分裁剪而不是滚动）</span>
                </label>
                <label>
                  画面清晰度（{form.vnc.quality}）
                  <input
                    type="range"
                    min={1}
                    max={9}
                    value={form.vnc.quality}
                    onChange={(e) =>
                      setForm((prev) => ({
                        ...prev,
                        vnc: { ...prev.vnc, quality: Number(e.target.value) },
                      }))
                    }
                  />
                </label>
                <label>
                  压缩强度（{form.vnc.compression}）
                  <input
                    type="range"
                    min={1}
                    max={9}
                    value={form.vnc.compression}
                    onChange={(e) =>
                      setForm((prev) => ({
                        ...prev,
                        vnc: { ...prev.vnc, compression: Number(e.target.value) },
                      }))
                    }
                  />
                </label>
              </div>
            </div>
          )}

          {form.protocol === "vnc" && (
            <div id="sec-vnc-advanced" className="dlg-card">
              <div className="section-title">高级</div>
              <p className="muted">
                当前使用兼容性优先的 Raw / CopyRect 编码，清晰度与压缩强度会随配置保存，
                供后续启用 Tight 编码时使用。
              </p>
            </div>
          )}

          {form.protocol === "tunnel" && (
            <>
              <div className="form-grid">
                <label className="span-2">
                  服务器 *
                  <select
                    value={form.tunnel.server_id ?? ""}
                    onChange={(e) =>
                      updateTunnel({ server_id: e.target.value || null })
                    }
                  >
                    <option value="">请选择 SSH 服务器</option>
                    {sshServers.map((server) => (
                      <option key={server.id} value={server.id}>
                        {server.name}（{server.target.user}@{server.target.host}:{server.target.port}）
                      </option>
                    ))}
                  </select>
                  <span className="muted">
                    隧道复用该 SSH 配置的连接与凭据；服务器需允许 TCP 转发。
                  </span>
                </label>
                {sshServers.length === 0 && (
                  <p className="update-hint span-2">
                    还没有 SSH 服务器配置，请先新建一个 SSH 连接再创建隧道。
                  </p>
                )}
                <label className="inline span-2">
                  <input
                    type="checkbox"
                    checked={form.tunnel.auto_reconnect}
                    onChange={(e) => updateTunnel({ auto_reconnect: e.target.checked })}
                  />
                  自动重连
                  <span className="muted">（隧道意外断开后自动恢复）</span>
                </label>
              </div>
            </>
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

              <div className="dlg-subcard auth-card">
                <div className="dlg-card-head">
                  <div>
                    <div className="section-title">认证</div>
                    <p className="dlg-card-desc">凭据加密保存在本地，测试连接不会保存新输入的密码或私钥。</p>
                  </div>
                  {initial?.auth.kind !== "none" && <span className="saved-secret-pill">已保存凭据</span>}
                </div>
                <div className="auth-methods" role="group" aria-label="SSH 验证方式">
                  {([
                    ["password", "密码"],
                    ["key", "私钥"],
                    ["keyboard_interactive", "交互认证"],
                  ] as Array<[AuthMode, string]>).map(([mode, label]) => (
                    <button
                      key={mode}
                      type="button"
                      className={`auth-method${form.authMode === mode ? " is-active" : ""}`}
                      onClick={() => update("authMode", mode)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div className="form-grid">
                  {form.authMode === "password" && (
                  <label className="span-2">
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
              </div>
            </>
          )}
            </div>

          {form.protocol === "serial" && (
            <div id="sec-serial" className="dlg-card">
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
              <div className="section-title">登录凭据（加密保存在本地凭据库，不落配置文件）</div>
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
                  <span className="muted">（留空则连接时一次性输入，支持空密码）</span>
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
            <div id="sec-conn" className="dlg-card">
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
            <div id="sec-jump" className="dlg-card">
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
            <div id="sec-proxy" className="dlg-card">
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
            <div id="sec-other" className="dlg-card">
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
            <div id="sec-init" className="dlg-card">
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

          {form.protocol === "tunnel" && (
            <div id="sec-tunnel" className="dlg-card">
              <div className="section-title">转发路由（可添加多条，连接后分别启停）</div>
              <div className="jump-list">
                {form.tunnel.routes.map((route, index) => {
                  const labels = routeLabels(route.kind);
                  return (
                    <div className="jump-card" key={route.id}>
                      <div className="jump-head">
                        <span>路由 {index + 1}</span>
                        <button
                          type="button"
                          className="btn-ghost sm"
                          onClick={() => removeRoute(index)}
                        >
                          移除
                        </button>
                      </div>
                      <div className="form-grid">
                        <label>
                          类型
                          <select
                            value={route.kind}
                            onChange={(e) =>
                              updateRoute(index, { kind: e.target.value as TunnelKind })
                            }
                          >
                            <option value="local">本地转发</option>
                            <option value="remote">远程转发</option>
                            <option value="dynamic">动态代理（SOCKS5）</option>
                          </select>
                        </label>
                        <label>
                          {labels.listen}
                          <div className="field-row">
                            <input
                              value={route.local_host}
                              onChange={(e) =>
                                updateRoute(index, { local_host: e.target.value })
                              }
                              placeholder="127.0.0.1"
                            />
                            <input
                              value={route.local_port}
                              onChange={(e) =>
                                updateRoute(index, {
                                  local_port: Number(e.target.value) || 0,
                                })
                              }
                              placeholder="8080"
                            />
                          </div>
                        </label>
                        {route.kind !== "dynamic" && (
                          <label className="span-2">
                            {labels.target}
                            <div className="field-row">
                              <input
                                value={route.remote_host}
                                onChange={(e) =>
                                  updateRoute(index, { remote_host: e.target.value })
                                }
                                placeholder="127.0.0.1"
                              />
                              <input
                                value={route.remote_port}
                                onChange={(e) =>
                                  updateRoute(index, {
                                    remote_port: Number(e.target.value) || 0,
                                  })
                                }
                                placeholder="3306"
                              />
                            </div>
                          </label>
                        )}
                        <p className="muted span-2">{labels.hint}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="tunnel-route-actions">
                <button type="button" className="btn-ghost sm" onClick={() => addRoute()}>
                  + 添加路由
                </button>
                <div className="tunnel-route-presets">
                  <span className="muted">快速填充</span>
                  <button
                    type="button"
                    className="btn-ghost sm"
                    onClick={() =>
                      addRoute({
                        kind: "dynamic",
                        local_port: 1080,
                        remote_host: "",
                        remote_port: 0,
                      })
                    }
                  >
                    动态代理：SOCKS5 1080
                  </button>
                  <button
                    type="button"
                    className="btn-ghost sm"
                    onClick={() =>
                      addRoute({
                        kind: "local",
                        local_port: 3307,
                        remote_host: "127.0.0.1",
                        remote_port: 3306,
                      })
                    }
                  >
                    本地转发：MySQL 本机 3307 → 远端 3306
                  </button>
                  <button
                    type="button"
                    className="btn-ghost sm"
                    onClick={() =>
                      addRoute({
                        kind: "local",
                        local_port: 8080,
                        remote_host: "127.0.0.1",
                        remote_port: 80,
                      })
                    }
                  >
                    本地转发：Web 本机 8080 → 远端 80
                  </button>
                  <button
                    type="button"
                    className="btn-ghost sm"
                    onClick={() =>
                      addRoute({
                        kind: "remote",
                        local_port: 9000,
                        remote_host: "127.0.0.1",
                        remote_port: 3000,
                      })
                    }
                  >
                    远程转发：服务器 9000 → 本机 3000
                  </button>
                </div>
              </div>
              {form.tunnel.routes.length === 0 && (
                <p className="muted">至少添加一条路由并保存后，才能在隧道面板中启动。</p>
              )}
            </div>
          )}

          {form.protocol === "telnet" && (
            <div id="sec-telnet-mapping">
              <div className="section-title">按键映射</div>
              <div className="form-grid">
                <label className="inline span-2">
                  <input
                    type="checkbox"
                    checked={form.telnet.enable_mapping}
                    onChange={(e) =>
                      setForm((prev) => ({
                        ...prev,
                        telnet: { ...prev.telnet, enable_mapping: e.target.checked },
                      }))
                    }
                  />
                  启用映射
                </label>
                <label className="span-2">
                  预设模板
                  <select
                    value={form.telnet.mapping_preset}
                    onChange={(e) =>
                      setForm((prev) => ({
                        ...prev,
                        telnet: { ...prev.telnet, mapping_preset: e.target.value },
                      }))
                    }
                  >
                    <option value="standard">标准模式 - 默认按键映射，不进行任何转换</option>
                  </select>
                  <span className="muted">标准模式按键原样发送；启用映射不会改变当前行为。</span>
                </label>
              </div>
            </div>
          )}

          {form.protocol === "rdp" && (
            <div id="sec-rdp">
              <div className="section-title">RDP 参数（Windows / Linux 共用内嵌会话，不调用 mstsc）</div>
              <div className="form-grid">
                <label className="inline">
                  <input
                    type="checkbox"
                    checked={form.rdp.fullscreen}
                    onChange={(e) => update("rdp", { ...form.rdp, fullscreen: e.target.checked })}
                  />
                  全屏
                </label>
                <label className="inline" title="剪贴板重定向为后续批次，当前版本不生效">
                  <input
                    type="checkbox"
                    disabled
                    checked={form.rdp.clipboard}
                    onChange={(e) => update("rdp", { ...form.rdp, clipboard: e.target.checked })}
                  />
                  剪贴板（后续批次）
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
                <label className="inline" title="多显示器为后续批次，当前版本不生效">
                  <input
                    type="checkbox"
                    disabled
                    checked={form.rdp.multimon}
                    onChange={(e) => update("rdp", { ...form.rdp, multimon: e.target.checked })}
                  />
                  多显示器（后续批次）
                </label>
                <label className="inline" title="磁盘映射为后续批次，当前版本不生效">
                  <input
                    type="checkbox"
                    disabled
                    checked={form.rdp.drive_redirect}
                    onChange={(e) => update("rdp", { ...form.rdp, drive_redirect: e.target.checked })}
                  />
                  映射本地磁盘（后续批次）
                </label>
                <label className="inline">
                  <input
                    type="checkbox"
                    checked={form.rdp.admin_session}
                    onChange={(e) => update("rdp", { ...form.rdp, admin_session: e.target.checked })}
                  />
                  管理员会话
                </label>
                <label title="RD 网关暂不支持（mstsc 支持，内嵌会话为后续批次）">
                  RD 网关（暂不支持）
                  <input
                    value={form.rdp.gateway ?? ""}
                    disabled
                    onChange={(e) => update("rdp", { ...form.rdp, gateway: e.target.value })}
                  />
                </label>
              </div>
              <p className="serial-hint">
                内嵌会话首批支持分辨率、域、NLA/CredSSP 登录与键鼠输入；空密码可手动输入。
                剪贴板、多显示器、磁盘映射、音频、EGFX/H.264 为后续批次。
                智能卡登录与 RD 网关在 mstsc 中可用，但内嵌会话暂不支持，请勿依赖这些配置连接。
              </p>
            </div>
          )}
          </div>
        </div>

        <div className="dlg-foot">
          <span className={`test-conn-result${testResult ? ` is-${testResult.kind}` : ""}`}>
            {form.protocol === "ssh"
              ? testResult
                ? testResult.message
                : "密码/私钥加密保存在本地凭据库，不会写入配置文件。"
              : "密码/私钥加密保存在本地凭据库，不会写入配置文件。"}
          </span>
          <div className="spacer" />
          {form.protocol === "ssh" && (
            <button
              className="btn-ghost"
              onClick={() => void handleTestConnection()}
              disabled={testing || saving}
            >
              {testing ? "正在测试…" : "测试连接"}
            </button>
          )}
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
