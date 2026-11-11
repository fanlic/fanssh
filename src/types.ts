// 与 Rust 侧 serde 模型保持一致的类型定义。

export type Protocol = "ssh" | "rdp";
export type SecretKind = "password" | "private_key" | "passphrase" | "token";

export interface Target {
  host: string;
  port: number;
  user: string;
}

export type AuthRef =
  | { kind: "password"; secret: string }
  | { kind: "key"; key: string; passphrase?: string | null }
  | { kind: "none" };

export interface JumpHop {
  target: Target;
  auth: AuthRef;
}

export interface RdpPrefs {
  fullscreen: boolean;
  width: number;
  height: number;
  multimon: boolean;
  clipboard: boolean;
  drive_redirect: boolean;
  admin_session: boolean;
  gateway?: string | null;
}

export interface ProfileOptions {
  rdp?: RdpPrefs | null;
}

export interface Profile {
  id: string;
  name: string;
  group?: string | null;
  protocol: Protocol;
  target: Target;
  auth: AuthRef;
  jump: JumpHop[];
  tags: string[];
  options: ProfileOptions;
}

export interface SecretRef {
  id: string;
  kind: SecretKind;
  label: string;
  updated_at: number;
}

export interface SessionState {
  state: "connecting" | "authenticating" | "ready" | "closed";
  reason?: string;
}

export type TermEvent =
  | { type: "state"; state: SessionState }
  | { type: "data"; seq: number; text: string }
  | { type: "title"; title: string }
  | { type: "exit"; code: number | null; reason: string | null }
  | { type: "error"; code: string; message: string };

export interface RemoteEntry {
  name: string;
  path: string;
  is_dir: boolean;
  is_symlink: boolean;
  size: number;
  mode: number | null;
  mtime: number | null;
}

export interface SftpOpenResp {
  sftp_id: string;
  home: string;
}

export type TransferEvent =
  | { type: "start"; id: string; name: string; direction: string; total: number }
  | {
      type: "progress";
      id: string;
      done: number;
      total: number;
      speed_bps: number;
      direction: string;
    }
  | {
      type: "done";
      id: string;
      name: string;
      remote_path: string;
      local_path: string | null;
      direction: string;
    }
  | { type: "error"; id: string; name: string; message: string; direction: string };

export interface AiSettingsView {
  provider: string;
  base_url: string;
  model: string;
  temperature: number;
  secret_id: string | null;
  max_context_kb: number;
  has_key: boolean;
}

export interface AiSettingsInput {
  provider: string;
  base_url: string;
  model: string;
  temperature: number;
  secret_id: string | null;
  max_context_kb: number;
}

export interface Nl2CmdResult {
  command: string;
  shell: string;
  explanation: string;
  risk: "low" | "medium" | "high" | string;
  requires_sudo: boolean;
  assumptions: string[];
  blocked: boolean;
  raw: string | null;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface RdpHandleDto {
  pid: number | null;
  rdp_file: string;
}

/** 后端统一错误结构 */
export interface AppErrorShape {
  code: string;
  message: string;
  detail?: string | null;
  retryable?: boolean;
}
