// 与 Rust 侧 serde 模型保持一致的类型定义。

export type Protocol = "ssh" | "rdp" | "serial";
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
  domain?: string | null;
}

export type SerialParity = "none" | "odd" | "even";
export type SerialFlowControl = "none" | "hardware" | "software";
export type SerialNewline = "raw" | "cr_to_crlf" | "lf_to_crlf";

/** 串口参数。与凭据无关，随 profile 持久化。 */
export interface SerialPrefs {
  port: string;
  baud_rate: number;
  data_bits: number;
  stop_bits: number;
  parity: SerialParity;
  flow_control: SerialFlowControl;
  /** DTR 默认拉高：部分交换机 console 需要 DTR 有效才有输出 */
  dtr: boolean;
  /** RTS 默认拉高；硬件流控时由驱动接管 */
  rts: boolean;
  /** 本地回显默认关闭，避免设备已回显时重复显示 */
  local_echo: boolean;
  newline: SerialNewline;
}

export interface ProfileOptions {
  rdp?: RdpPrefs | null;
  serial?: SerialPrefs | null;
}

/** 系统串口枚举结果；description 含厂商/产品/序列号，便于区分同型号设备。 */
export interface SerialPortInfo {
  port_name: string;
  description: string;
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

export interface UpdaterStatus {
  currentVersion: string;
  endpoint: string;
  channelUrl: string;
  portable: boolean;
}

export interface UpdateInfo {
  version: string;
  currentVersion: string;
  notes: string | null;
  date: string | null;
  url: string | null;
}

export type UpdateEvent =
  | { type: "downloading" }
  | { type: "progress"; downloaded: number; total: number | null }
  | { type: "installed" };

/** 后端统一错误结构 */
export interface AppErrorShape {
  code: string;
  message: string;
  detail?: string | null;
  retryable?: boolean;
}
