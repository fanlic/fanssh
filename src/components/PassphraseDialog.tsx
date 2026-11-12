import { useEffect, useState } from "react";
import { Icon } from "./Icon";

interface Props {
  open: boolean;
  mode: "export" | "import";
  busy?: boolean;
  error?: string | null;
  onSubmit: (passphrase: string) => void;
  onClose: () => void;
}

/** 导出口令输入 / 加密文件解锁。 */
export function PassphraseDialog({ open, mode, busy = false, error, onSubmit, onClose }: Props) {
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const isExport = mode === "export";

  useEffect(() => {
    if (!open) return;
    setPassphrase("");
    setConfirm("");
    setLocalError(null);
  }, [open, mode]);

  if (!open) return null;

  const submit = () => {
    if (busy) return;
    if (isExport && passphrase.length < 8) {
      setLocalError("口令至少 8 位");
      return;
    }
    if (!passphrase) {
      setLocalError("请输入口令");
      return;
    }
    if (isExport && passphrase !== confirm) {
      setLocalError("两次输入的口令不一致");
      return;
    }
    setLocalError(null);
    onSubmit(passphrase);
  };

  return (
    <div
      className="dlg-mask"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div className="dlg dlg-pass" role="dialog" aria-modal="true">
        <div className="dlg-head">
          <div className="dh-title">
            <Icon name="lock" size={14} />
            {isExport ? "导出加密配置" : "输入导出口令"}
          </div>
        </div>
        <div className="dlg-body">
          <p className="dlg-text">
            {isExport
              ? "配置与密码会用该口令一起加密（Argon2id + AES-256-GCM），文件保存为 .fansshx。口令不会写入磁盘，忘记后无法恢复。"
              : "该文件已加密，请输入导出时设置的口令。"}
          </p>
          <div className="form-grid">
            <label className="span-2">
              口令
              <input
                type="password"
                autoFocus
                value={passphrase}
                onChange={(event) => setPassphrase(event.target.value)}
                onKeyDown={(event) => event.key === "Enter" && submit()}
              />
            </label>
            {isExport && (
              <label className="span-2">
                确认口令
                <input
                  type="password"
                  value={confirm}
                  onChange={(event) => setConfirm(event.target.value)}
                  onKeyDown={(event) => event.key === "Enter" && submit()}
                />
              </label>
            )}
          </div>
          {(localError || error) && (
            <div className="banner err">{localError ?? error}</div>
          )}
        </div>
        <div className="dlg-foot">
          <button className="btn-ghost" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button className="btn-primary" onClick={submit} disabled={busy}>
            {busy ? "处理中…" : isExport ? "导出" : "导入"}
          </button>
        </div>
      </div>
    </div>
  );
}
