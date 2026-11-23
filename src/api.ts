import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  AiSettingsInput,
  AiSettingsView,
  ChatMessage,
  DockerContainer,
  DockerLogs,
  MonitorEvent,
  KnownHostEntry,
  Nl2CmdResult,
  Profile,
  RemoteEntry,
  SerialPortInfo,
  SftpConflict,
  SftpOpResult,
  SftpOpenResp,
  SftpTextFile,
  TermEvent,
  TransferEvent,
  UpdateEvent,
  UpdateInfo,
  UpdaterStatus,
  UiSettings,
} from "./types";

// ---------------------------------------------------------------------------
// 终端
// ---------------------------------------------------------------------------

export async function termOpen(
  profileId: string,
  onEvent: (event: TermEvent) => void,
): Promise<string> {
  const channel = new Channel<TermEvent>();
  channel.onmessage = onEvent;
  return invoke<string>("term_open", { profileId, onEvent: channel });
}

// ---------------------------------------------------------------------------
// Docker（复用当前 SSH 会话，经 docker.sock 转发）
// ---------------------------------------------------------------------------

export async function dockerContainers(session: string): Promise<DockerContainer[]> {
  return invoke<DockerContainer[]>("docker_containers", { session });
}

export async function dockerLogs(
  session: string,
  container: string,
  tail = 500,
): Promise<DockerLogs> {
  return invoke<DockerLogs>("docker_logs", { session, container, tail });
}

export function termInput(session: string, data: Uint8Array): Promise<void> {
  // Tauri 会把 Vec<u8> 反序列化为数字数组，这里显式转换。
  return invoke("term_input", { session, bytes: Array.from(data) });
}

export function termResize(session: string, cols: number, rows: number): Promise<void> {
  return invoke("term_resize", { session, cols, rows });
}

export function termClose(session: string): Promise<void> {
  return invoke("term_close", { session });
}

/** 键盘交互认证：responses 为 null 表示取消。 */
export function termAuthRespond(
  promptId: string,
  responses: string[] | null,
): Promise<void> {
  return invoke("term_auth_respond", { promptId, responses });
}

/** 读取用户选择的本地文件（私钥）。 */
export function readTextFile(path: string): Promise<string> {
  return invoke("read_text_file", { path });
}

// ---------------------------------------------------------------------------
// 服务器监控（复用当前 SSH 会话，只读采样）
// ---------------------------------------------------------------------------

export async function monitorStart(
  session: string,
  onEvent: (event: MonitorEvent) => void,
): Promise<void> {
  const channel = new Channel<MonitorEvent>();
  channel.onmessage = onEvent;
  return invoke("monitor_start", { session, onEvent: channel });
}

export function monitorStop(session: string): Promise<void> {
  return invoke("monitor_stop", { session });
}

// ---------------------------------------------------------------------------
// 串口
// ---------------------------------------------------------------------------

export function serialListPorts(): Promise<SerialPortInfo[]> {
  return invoke("serial_list_ports");
}

export async function serialOpen(
  profileId: string,
  onEvent: (event: TermEvent) => void,
): Promise<string> {
  const channel = new Channel<TermEvent>();
  channel.onmessage = onEvent;
  return invoke<string>("serial_open", { profileId, onEvent: channel });
}

export function serialInput(session: string, data: Uint8Array): Promise<void> {
  return invoke("serial_input", { session, bytes: Array.from(data) });
}

export function serialSetLines(session: string, dtr: boolean, rts: boolean): Promise<void> {
  return invoke("serial_set_lines", { session, dtr, rts });
}

export function serialClose(session: string): Promise<void> {
  return invoke("serial_close", { session });
}

// ---------------------------------------------------------------------------
// 服务器配置
// ---------------------------------------------------------------------------

export function profileList(): Promise<Profile[]> {
  return invoke("profile_list");
}

export function profileUpsert(profile: Profile): Promise<Profile> {
  return invoke("profile_upsert", { profile });
}

export function profileDelete(id: string): Promise<void> {
  return invoke("profile_delete", { id });
}

export function sshTestConnection(
  profile: Profile,
  secrets: { password?: string | null; key_text?: string | null; passphrase?: string | null },
): Promise<string> {
  return invoke("ssh_test_connection", { profile, secrets });
}

export function profileExport(path: string, passphrase: string): Promise<number> {
  return invoke("profile_export", { path, passphrase });
}

export function profileImport(path: string, passphrase?: string): Promise<number> {
  return invoke("profile_import", { path, passphrase: passphrase ?? null });
}

// ---------------------------------------------------------------------------
// 凭据库
// ---------------------------------------------------------------------------

export function vaultPut(
  id: string | null,
  kind: string,
  label: string,
  plaintext: string,
): Promise<string> {
  return invoke("vault_put", { id, kind, label, plaintext });
}

export function vaultList() {
  return invoke<import("./types").SecretRef[]>("vault_list");
}

export function vaultDelete(id: string): Promise<void> {
  return invoke("vault_delete", { id });
}

// ---------------------------------------------------------------------------
// SFTP
// ---------------------------------------------------------------------------

export function sftpOpen(profileId: string): Promise<SftpOpenResp> {
  return invoke("sftp_open", { profileId });
}

export function sftpList(sftpId: string, path: string): Promise<RemoteEntry[]> {
  return invoke("sftp_list", { sftpId, path });
}

export function sftpChmod(sftpId: string, path: string, mode: number): Promise<void> {
  return invoke("sftp_chmod", { sftpId, path, mode });
}

export async function sftpUpload(
  sftpId: string,
  localPaths: string[],
  remoteDir: string,
  conflict: SftpConflict,
  restart: boolean,
  onEvent: (event: TransferEvent) => void,
): Promise<void> {
  const channel = new Channel<TransferEvent>();
  channel.onmessage = onEvent;
  return invoke("sftp_upload", {
    sftpId,
    localPaths,
    remoteDir,
    conflict,
    restart,
    onEvent: channel,
  });
}

export async function sftpDownload(
  sftpId: string,
  remotePath: string,
  localPath: string,
  conflict: SftpConflict,
  restart: boolean,
  onEvent: (event: TransferEvent) => void,
): Promise<void> {
  const channel = new Channel<TransferEvent>();
  channel.onmessage = onEvent;
  return invoke("sftp_download", {
    sftpId,
    remotePath,
    localPath,
    conflict,
    restart,
    onEvent: channel,
  });
}

export function sftpRename(
  sftpId: string,
  from: string,
  to: string,
): Promise<void> {
  return invoke("sftp_rename", { sftpId, from, to });
}

export function sftpMkdir(sftpId: string, path: string): Promise<void> {
  return invoke("sftp_mkdir", { sftpId, path });
}

export function sftpRemove(
  sftpId: string,
  paths: string[],
): Promise<SftpOpResult[]> {
  return invoke("sftp_remove", { sftpId, paths });
}

export function sftpReadText(
  sftpId: string,
  path: string,
): Promise<SftpTextFile> {
  return invoke("sftp_read_text", { sftpId, path });
}

export function sftpWriteText(
  sftpId: string,
  path: string,
  content: string,
  expectedMtime: number | null,
): Promise<SftpTextFile> {
  return invoke("sftp_write_text", {
    sftpId,
    path,
    content,
    expectedMtime,
  });
}

export function sftpLocalExists(path: string): Promise<boolean> {
  return invoke("sftp_local_exists", { path });
}

export function sftpClose(sftpId: string): Promise<void> {
  return invoke("sftp_close", { sftpId });
}

// ---------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------

export function aiSettingsGet(): Promise<AiSettingsView> {
  return invoke("ai_settings_get");
}

export function aiSettingsSave(settings: AiSettingsInput): Promise<AiSettingsView> {
  return invoke("ai_settings_save", { settings });
}

export function aiChat(
  messages: ChatMessage[],
  kind: "chat" | "explain",
  context: string | null,
): Promise<string> {
  return invoke("ai_chat", { request: { messages, kind, context } });
}

export function aiNl2Cmd(prompt: string, context: string | null): Promise<Nl2CmdResult> {
  return invoke("ai_nl2cmd", { prompt, context });
}

// ---------------------------------------------------------------------------
// Telnet
// ---------------------------------------------------------------------------

export async function telnetOpen(
  profileId: string,
  onEvent: (event: TermEvent) => void,
): Promise<string> {
  const channel = new Channel<TermEvent>();
  channel.onmessage = onEvent;
  return invoke("telnet_open", { profileId, onEvent: channel });
}

export function telnetInput(session: string, bytes: Uint8Array): Promise<void> {
  return invoke("telnet_input", { session, bytes: Array.from(bytes) });
}

export function telnetClose(session: string): Promise<void> {
  return invoke("telnet_close", { session });
}

// ---------------------------------------------------------------------------
// VNC
// ---------------------------------------------------------------------------

export async function vncOpen(
  profileId: string,
  onEvent: (event: import("./types").VncEvent) => void,
  onFrame: (frame: ArrayBuffer) => void,
): Promise<string> {
  const eventChannel = new Channel<import("./types").VncEvent>();
  eventChannel.onmessage = onEvent;
  const frameChannel = new Channel<ArrayBuffer>();
  frameChannel.onmessage = (message) => {
    if (message instanceof ArrayBuffer) {
      onFrame(message);
    } else if (ArrayBuffer.isView(message)) {
      const view = message as ArrayBufferView;
      onFrame(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer);
    }
  };
  return invoke("vnc_open", {
    profileId,
    onEvent: eventChannel,
    onFrame: frameChannel,
  });
}

export function vncInput(session: string, input: import("./types").VncInput): Promise<void> {
  return invoke("vnc_input", { session, input });
}

export function vncClose(session: string): Promise<void> {
  return invoke("vnc_close", { session });
}

// ---------------------------------------------------------------------------
// RDP（Windows / Linux 共用内嵌会话）
// ---------------------------------------------------------------------------

/** password 只在内存中传给后端，不落盘；vault 已有密码时传 null 即可。 */
export async function rdpOpen(
  profileId: string,
  password: string | null,
  onEvent: (event: import("./types").RdpEvent) => void,
  onFrame: (frame: ArrayBuffer) => void,
): Promise<string> {
  const eventChannel = new Channel<import("./types").RdpEvent>();
  eventChannel.onmessage = onEvent;
  const frameChannel = new Channel<ArrayBuffer>();
  frameChannel.onmessage = (message) => {
    if (message instanceof ArrayBuffer) {
      onFrame(message);
    } else if (ArrayBuffer.isView(message)) {
      const view = message as ArrayBufferView;
      onFrame(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer);
    }
  };
  return invoke("rdp_open", {
    profileId,
    password,
    onEvent: eventChannel,
    onFrame: frameChannel,
  });
}

export function rdpInput(session: string, input: import("./types").RdpInput): Promise<void> {
  return invoke("rdp_input", { session, input });
}

export function rdpClose(session: string): Promise<void> {
  return invoke("rdp_close", { session });
}

// ---------------------------------------------------------------------------
// 端口转发 / 隧道
// ---------------------------------------------------------------------------

export async function tunnelStart(
  profileId: string,
  routeId: string,
  onEvent: (event: import("./types").TunnelEvent) => void,
): Promise<void> {
  const channel = new Channel<import("./types").TunnelEvent>();
  channel.onmessage = onEvent;
  return invoke("tunnel_start", { profileId, routeId, onEvent: channel });
}

export function tunnelStop(routeId: string): Promise<void> {
  return invoke("tunnel_stop", { routeId });
}

export function tunnelActive(): Promise<string[]> {
  return invoke("tunnel_active");
}

// ---------------------------------------------------------------------------
// SSH 主机密钥
// ---------------------------------------------------------------------------

export function knownHostsList(): Promise<KnownHostEntry[]> {
  return invoke("known_hosts_list");
}

export function knownHostsDelete(host: string, port: number): Promise<boolean> {
  return invoke("known_hosts_delete", { host, port });
}

// ---------------------------------------------------------------------------
// 界面设置（主题 / 终端 / 快捷键）
// ---------------------------------------------------------------------------

export function uiSettingsGet(): Promise<UiSettings> {
  return invoke("ui_settings_get");
}

export function uiSettingsSave(settings: UiSettings): Promise<UiSettings> {
  return invoke("ui_settings_save", { settings });
}

// ---------------------------------------------------------------------------
// 自动更新
// ---------------------------------------------------------------------------

export function updaterStatus(): Promise<UpdaterStatus> {
  return invoke("updater_status");
}

export function appPlatform(): Promise<string> {
  return invoke("app_platform");
}

export function updaterCheck(): Promise<UpdateInfo | null> {
  return invoke("updater_check");
}

export async function updaterInstall(
  onEvent: (event: UpdateEvent) => void,
): Promise<void> {
  const channel = new Channel<UpdateEvent>();
  channel.onmessage = onEvent;
  return invoke("updater_install", { onEvent: channel });
}

/** 用系统默认浏览器打开外链（后端只放行 http/https） */
export function openExternal(url: string): Promise<void> {
  return invoke("open_external", { url });
}

/** 把后端错误对象转成可读文本 */
export function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const shape = error as { message?: string; code?: string; detail?: string };
    const parts = [shape.message ?? JSON.stringify(error)];
    if (shape.code) parts.push(`[${shape.code}]`);
    if (shape.detail) parts.push(shape.detail);
    return parts.join(" ");
  }
  return String(error);
}
