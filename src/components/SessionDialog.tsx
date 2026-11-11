import { useEffect, useState } from "react";
import { errorText, profileUpsert, vaultPut } from "../api";
import type { AuthRef, Profile, Protocol, RdpPrefs } from "../types";

interface Props {
  open: boolean;
  initial: Profile | null;
  onClose: () => void;
  onSaved: (profile: Profile) => void;
  onError: (message: string) => void;
}

type AuthMode = "password" | "key" | "none";

interface FormState {
  name: string;
  group: string;
  tags: string;
  protocol: Protocol;
  host: string;
  port: string;
  user: string;
  authMode: AuthMode;
  password: string;
  keyText: string;
  passphrase: string;
  useJump: boolean;
  jumpHost: string;
  jumpPort: string;
  jumpUser: string;
  jumpAuthMode: AuthMode;
  jumpPassword: string;
  jumpKeyText: string;
  rdp: RdpPrefs;
}

const EMPTY: FormState = {
  name: "",
  group: "",
  tags: "",
  protocol: "ssh",
  host: "",
  port: "22",
  user: "",
  authMode: "password",
  password: "",
  keyText: "",
  passphrase: "",
  useJump: false,
  jumpHost: "",
  jumpPort: "22",
  jumpUser: "",
  jumpAuthMode: "password",
  jumpPassword: "",
  jumpKeyText: "",
  rdp: {
    fullscreen: true,
    width: 1920,
    height: 1080,
    multimon: false,
    clipboard: true,
    drive_redirect: false,
    admin_session: false,
    gateway: "",
  },
};

function toForm(profile: Profile | null): FormState {
  if (!profile) return { ...EMPTY, rdp: { ...EMPTY.rdp } };
  const jump = profile.jump[0];
  const mode = (auth: AuthRef | undefined): AuthMode =>
    auth?.kind === "password" ? "password" : auth?.kind === "key" ? "key" : "none";
  return {
    name: profile.name,
    group: profile.group ?? "",
    tags: profile.tags.join(", "),
    protocol: profile.protocol,
    host: profile.target.host,
    port: String(profile.target.port),
    user: profile.target.user,
    authMode: mode(profile.auth),
    password: "",
    keyText: "",
    passphrase: "",
    useJump: Boolean(jump),
    jumpHost: jump?.target.host ?? "",
    jumpPort: String(jump?.target.port ?? 22),
    jumpUser: jump?.target.user ?? "",
    jumpAuthMode: mode(jump?.auth),
    jumpPassword: "",
    jumpKeyText: "",
    rdp: { ...EMPTY.rdp, ...(profile.options.rdp ?? {}) },
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

function existingJumpPassword(profile: Profile | null): string | null {
  const auth = profile?.jump[0]?.auth;
  return auth?.kind === "password" ? auth.secret : null;
}

function existingJumpKey(profile: Profile | null): { key: string | null; pass: string | null } {
  const auth = profile?.jump[0]?.auth;
  if (auth?.kind === "key") return { key: auth.key, pass: auth.passphrase ?? null };
  return { key: null, pass: null };
}

export function SessionDialog({ open, initial, onClose, onSaved, onError }: Props) {
  const [form, setForm] = useState<FormState>(() => toForm(initial));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) setForm(toForm(initial));
  }, [open, initial]);

  if (!open) return null;

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const buildAuth = async (
    mode: AuthMode,
    password: string,
    keyText: string,
    passphrase: string,
    existing: AuthRef | undefined,
    label: string,
  ): Promise<AuthRef> => {
    if (mode === "none") return { kind: "none" };
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
      if (!form.host.trim()) throw new Error("请填写主机地址");
      const port = Number(form.port);
      if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error("端口不合法");
      if (form.protocol === "ssh" && !form.user.trim()) throw new Error("SSH 需要用户名");

      const auth = await buildAuth(
        form.authMode,
        form.password,
        form.keyText,
        form.passphrase,
        initial?.auth,
        form.name.trim(),
      );

      const jump = [];
      if (form.useJump && form.protocol === "ssh") {
        if (!form.jumpHost.trim() || !form.jumpUser.trim()) {
          throw new Error("跳板机的主机和用户名不能为空");
        }
        const jumpPort = Number(form.jumpPort) || 22;
        const jumpAuth = await buildAuth(
          form.jumpAuthMode,
          form.jumpPassword,
          form.jumpKeyText,
          "",
          initial?.jump[0]?.auth,
          `${form.name.trim()} 跳板机`,
        );
        jump.push({
          target: { host: form.jumpHost.trim(), port: jumpPort, user: form.jumpUser.trim() },
          auth: jumpAuth,
        });
      }

      const profile: Profile = {
        id: initial?.id ?? crypto.randomUUID(),
        name: form.name.trim(),
        group: form.group.trim() || null,
        protocol: form.protocol,
        target: {
          host: form.host.trim(),
          port,
          user: form.protocol === "rdp" ? form.user.trim() : form.user.trim(),
        },
        auth: form.protocol === "rdp" ? { kind: "none" } : auth,
        jump,
        tags: form.tags
          .split(/[,，]/)
          .map((tag) => tag.trim())
          .filter(Boolean),
        options: form.protocol === "rdp" ? { rdp: form.rdp } : {},
      };
      const saved = await profileUpsert(profile);
      onSaved(saved);
      onClose();
    } catch (error) {
      onError(errorText(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-mask" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-head">
          <h2>{initial ? "编辑连接" : "新建连接"}</h2>
          <button className="icon" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="modal-body">
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
              协议
              <select
                value={form.protocol}
                onChange={(e) => {
                  const protocol = e.target.value as Protocol;
                  update("protocol", protocol);
                  if (protocol === "rdp" && form.port === "22") update("port", "3389");
                  if (protocol === "ssh" && form.port === "3389") update("port", "22");
                }}
              >
                <option value="ssh">SSH</option>
                <option value="rdp">RDP（调用 mstsc.exe）</option>
              </select>
            </label>
            <label>
              标签
              <input value={form.tags} onChange={(e) => update("tags", e.target.value)} placeholder="web, prod" />
            </label>
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
              <input value={form.user} onChange={(e) => update("user", e.target.value)} placeholder="root" />
            </label>
          </div>

          {form.protocol === "ssh" && (
            <>
              <div className="section-title">认证</div>
              <div className="form-grid">
                <label>
                  方式
                  <select value={form.authMode} onChange={(e) => update("authMode", e.target.value as AuthMode)}>
                    <option value="password">密码</option>
                    <option value="key">私钥</option>
                    <option value="none">无（仅跳板机可能用到）</option>
                  </select>
                </label>
                {form.authMode === "password" && (
                  <label>
                    密码 {existingPasswordSecret(initial) && <span className="muted">（留空则沿用已保存密码）</span>}
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
                      私钥内容（OpenSSH / PEM）
                      <textarea
                        rows={5}
                        value={form.keyText}
                        onChange={(e) => update("keyText", e.target.value)}
                        placeholder={existingKeySecrets(initial).key ? "已保存私钥，留空则不修改" : "-----BEGIN OPENSSH PRIVATE KEY-----"}
                      />
                    </label>
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
              </div>

              <div className="section-title">
                <label className="inline">
                  <input
                    type="checkbox"
                    checked={form.useJump}
                    onChange={(e) => update("useJump", e.target.checked)}
                  />
                  通过跳板机（ProxyJump，当前版本支持一层）
                </label>
              </div>
              {form.useJump && (
                <div className="form-grid">
                  <label className="span-2">
                    跳板机主机 *
                    <input value={form.jumpHost} onChange={(e) => update("jumpHost", e.target.value)} />
                  </label>
                  <label>
                    端口
                    <input value={form.jumpPort} onChange={(e) => update("jumpPort", e.target.value)} />
                  </label>
                  <label>
                    用户名 *
                    <input value={form.jumpUser} onChange={(e) => update("jumpUser", e.target.value)} />
                  </label>
                  <label>
                    认证
                    <select
                      value={form.jumpAuthMode}
                      onChange={(e) => update("jumpAuthMode", e.target.value as AuthMode)}
                    >
                      <option value="password">密码</option>
                      <option value="key">私钥</option>
                      <option value="none">无</option>
                    </select>
                  </label>
                  {form.jumpAuthMode === "password" && (
                    <label>
                      密码 {existingJumpPassword(initial) && <span className="muted">（留空沿用）</span>}
                      <input
                        type="password"
                        value={form.jumpPassword}
                        onChange={(e) => update("jumpPassword", e.target.value)}
                      />
                    </label>
                  )}
                  {form.jumpAuthMode === "key" && (
                    <label className="span-2">
                      跳板机私钥
                      <textarea
                        rows={4}
                        value={form.jumpKeyText}
                        onChange={(e) => update("jumpKeyText", e.target.value)}
                        placeholder={existingJumpKey(initial).key ? "已保存，留空不修改" : ""}
                      />
                    </label>
                  )}
                </div>
              )}
            </>
          )}

          {form.protocol === "rdp" && (
            <>
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
            </>
          )}
        </div>

        <div className="modal-foot">
          <span className="muted">密码/私钥加密保存在本地凭据库，不会写入配置文件。</span>
          <div className="spacer" />
          <button className="ghost" onClick={onClose}>
            取消
          </button>
          <button className="primary" onClick={handleSave} disabled={saving}>
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}
