import { useEffect, useState } from "react";
import { relaunch } from "@tauri-apps/plugin-process";
import { errorText, updaterCheck, updaterInstall, updaterStatus } from "../api";
import type { UpdateInfo, UpdaterStatus } from "../types";

interface Props {
  open: boolean;
  onClose: () => void;
  onNotice: (message: string, kind?: "info" | "error") => void;
}

type Phase = "idle" | "checking" | "uptodate" | "available" | "confirm" | "installing" | "installed";

export function SettingsDialog({ open, onClose, onNotice }: Props) {
  const [status, setStatus] = useState<UpdaterStatus | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number | null }>({
    done: 0,
    total: null,
  });

  useEffect(() => {
    if (!open) return;
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

  return (
    <div className="dlg-mask" onClick={onClose}>
      <div className="dlg dlg-settings" onClick={(event) => event.stopPropagation()}>
        <div className="dlg-head">
          <h3>设置 · 关于</h3>
          <button className="icon-btn sm" onClick={onClose} title="关闭">
            ×
          </button>
        </div>
        <div className="dlg-body">
          <div className="section-title">版本信息</div>
          <div className="update-row">
            <span>当前版本</span>
            <strong>{status?.currentVersion ?? "读取中…"}</strong>
          </div>
          <div className="update-row">
            <span>更新源</span>
            <code className="update-endpoint">{status?.endpoint || "未配置"}</code>
          </div>

          {status?.portable && (
            <p className="update-hint">
              便携版不参与自动更新。检测到新版本时请下载新版便携包并解压覆盖（配置与凭据在
              `data/` 目录，迁移时一并带走）：
              <br />
              <code className="update-endpoint">{status.channelUrl}</code>
            </p>
          )}

          <div className="section-title">检查更新</div>

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
              <pre className="update-notes">{update.notes?.trim() || "该版本未提供更新说明。"}</pre>
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
            <p className="update-ok">安装包已就绪。点击「重启并完成安装」后应用会退出并重新启动。</p>
          )}

          {error && <p className="update-error">{error}</p>}
        </div>
        <div className="dlg-foot">
          {phase === "confirm" ? (
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
                disabled={phase === "checking" || phase === "installing" || status?.portable === true}
                title={status?.portable ? "便携版请下载新版 zip" : undefined}
              >
                检查更新
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
