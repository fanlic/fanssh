import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  AiSettingsInput,
  AiSettingsView,
  ChatMessage,
  DockerContainer,
  DockerLogs,
  Nl2CmdResult,
  Profile,
  RdpHandleDto,
  RemoteEntry,
  SerialPortInfo,
  SftpOpenResp,
  TermEvent,
  TransferEvent,
  UpdateEvent,
  UpdateInfo,
  UpdaterStatus,
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
  onEvent: (event: TransferEvent) => void,
): Promise<void> {
  const channel = new Channel<TransferEvent>();
  channel.onmessage = onEvent;
  return invoke("sftp_upload", {
    sftpId,
    localPaths,
    remoteDir,
    onEvent: channel,
  });
}

export async function sftpDownload(
  sftpId: string,
  remotePath: string,
  localPath: string,
  onEvent: (event: TransferEvent) => void,
): Promise<void> {
  const channel = new Channel<TransferEvent>();
  channel.onmessage = onEvent;
  return invoke("sftp_download", {
    sftpId,
    remotePath,
    localPath,
    onEvent: channel,
  });
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
// RDP
// ---------------------------------------------------------------------------

export function rdpLaunch(profileId: string): Promise<RdpHandleDto> {
  return invoke("rdp_launch", { profileId });
}

// ---------------------------------------------------------------------------
// 自动更新
// ---------------------------------------------------------------------------

export function updaterStatus(): Promise<UpdaterStatus> {
  return invoke("updater_status");
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
