import { useCallback, useEffect, useRef, useState } from "react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  errorText,
  sftpChmod,
  sftpClose,
  sftpDownload,
  sftpList,
  sftpOpen,
  sftpUpload,
} from "../api";
import type { RemoteEntry, TransferEvent } from "../types";

interface Props {
  profileId: string;
  profileName: string;
  onClose: () => void;
}

interface TransferRow {
  id: string;
  name: string;
  direction: string;
  done: number;
  total: number;
  speed: number;
  status: "running" | "done" | "error";
  message?: string;
}

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = size / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[index]}`;
}

function formatMode(mode: number | null): string {
  if (mode == null) return "-";
  return (mode & 0o7777).toString(8).padStart(4, "0");
}

function parentOf(path: string): string {
  if (path === "/" || path === "") return "/";
  const trimmed = path.replace(/\/+$/, "");
  const index = trimmed.lastIndexOf("/");
  return index <= 0 ? "/" : trimmed.slice(0, index);
}

export function SftpPanel({ profileId, profileName, onClose }: Props) {
  const [sftpId, setSftpId] = useState<string | null>(null);
  const [cwd, setCwd] = useState("");
  const [entries, setEntries] = useState<RemoteEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<RemoteEntry | null>(null);
  const [modeInput, setModeInput] = useState("644");
  const [transfers, setTransfers] = useState<TransferRow[]>([]);
  const sftpRef = useRef<string | null>(null);

  const applyTransferEvent = useCallback((event: TransferEvent) => {
    setTransfers((prev) => {
      const index = prev.findIndex((row) => row.id === event.id);
      const base: TransferRow =
        index >= 0
          ? prev[index]
          : {
              id: event.id,
              name: "name" in event ? event.name : "",
              direction: event.direction,
              done: 0,
              total: 0,
              speed: 0,
              status: "running",
            };
      let next: TransferRow = base;
      switch (event.type) {
        case "start":
          next = { ...base, name: event.name, total: event.total, direction: event.direction, status: "running" };
          break;
        case "progress":
          next = {
            ...base,
            done: event.done,
            total: event.total || base.total,
            speed: event.speed_bps,
            status: "running",
          };
          break;
        case "done":
          next = { ...base, done: base.total, status: "done", speed: 0 };
          break;
        case "error":
          next = { ...base, status: "error", message: event.message, speed: 0 };
          break;
      }
      if (index >= 0) {
        const copy = prev.slice();
        copy[index] = next;
        return copy;
      }
      return [next, ...prev];
    });
  }, []);

  const loadDir = useCallback(async (id: string, path: string) => {
    setLoading(true);
    setError(null);
    try {
      const list = await sftpList(id, path);
      setEntries(list);
      setCwd(path);
      setSelected(null);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    (async () => {
      try {
        const resp = await sftpOpen(profileId);
        if (disposed) {
          sftpClose(resp.sftp_id).catch(() => undefined);
          return;
        }
        sftpRef.current = resp.sftp_id;
        setSftpId(resp.sftp_id);
        await loadDir(resp.sftp_id, resp.home);
      } catch (err) {
        if (!disposed) setError(errorText(err));
      }
    })();
    return () => {
      disposed = true;
      const id = sftpRef.current;
      sftpRef.current = null;
      if (id) sftpClose(id).catch(() => undefined);
    };
  }, [profileId, loadDir]);

  const handleUpload = async () => {
    if (!sftpId) return;
    const picked = await openDialog({ multiple: true, title: "选择要上传的文件" });
    if (!picked) return;
    const paths = Array.isArray(picked) ? picked : [picked];
    if (paths.length === 0) return;
    try {
      await sftpUpload(sftpId, paths, cwd, applyTransferEvent);
      await loadDir(sftpId, cwd);
    } catch (err) {
      setError(errorText(err));
    }
  };

  const handleDownload = async (entry: RemoteEntry) => {
    if (!sftpId || entry.is_dir) return;
    const target = await saveDialog({ defaultPath: entry.name, title: "保存到本地" });
    if (!target) return;
    try {
      await sftpDownload(sftpId, entry.path, target, applyTransferEvent);
    } catch (err) {
      setError(errorText(err));
    }
  };

  const handleChmod = async () => {
    if (!sftpId || !selected) return;
    const mode = Number.parseInt(modeInput, 8);
    if (Number.isNaN(mode)) {
      setError("权限需要是八进制，例如 644 / 755");
      return;
    }
    try {
      await sftpChmod(sftpId, selected.path, mode);
      await loadDir(sftpId, cwd);
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <div className="drawer-mask" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="drawer">
        <div className="drawer-head">
          <div>
            <h2>SFTP · {profileName}</h2>
            <div className="path-bar">
              <button className="ghost small" onClick={() => sftpId && loadDir(sftpId, parentOf(cwd))}>
                ↑ 上级
              </button>
              <input
                value={cwd}
                onChange={(event) => setCwd(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && sftpId) loadDir(sftpId, cwd);
                }}
              />
              <button className="ghost small" onClick={() => sftpId && loadDir(sftpId, cwd)}>
                刷新
              </button>
            </div>
          </div>
          <button className="icon" onClick={onClose}>
            ×
          </button>
        </div>

        {error && <div className="banner error">{error}</div>}

        <div className="sftp-toolbar">
          <button className="primary small" onClick={handleUpload} disabled={!sftpId}>
            上传文件
          </button>
          <button
            className="ghost small"
            disabled={!selected || selected.is_dir}
            onClick={() => selected && handleDownload(selected)}
          >
            下载选中
          </button>
          <div className="spacer" />
          {selected && (
            <div className="chmod-box">
              <span>chmod</span>
              <input value={modeInput} onChange={(event) => setModeInput(event.target.value)} />
              <button className="ghost small" onClick={handleChmod}>
                应用
              </button>
            </div>
          )}
        </div>

        <div className="sftp-list">
          <div className="sftp-row sftp-head">
            <span>名称</span>
            <span>大小</span>
            <span>权限</span>
          </div>
          {loading && <div className="hint">读取目录…</div>}
          {!loading &&
            entries.map((entry) => (
              <div
                key={entry.path}
                className={`sftp-row${selected?.path === entry.path ? " is-selected" : ""}`}
                onClick={() => {
                  setSelected(entry);
                  if (entry.mode != null) setModeInput((entry.mode & 0o777).toString(8).padStart(3, "0"));
                }}
                onDoubleClick={() => entry.is_dir && sftpId && loadDir(sftpId, entry.path)}
              >
                <span className="sftp-name">
                  <span className="file-icon">{entry.is_dir ? "📁" : "📄"}</span>
                  {entry.name}
                  {entry.is_symlink && <span className="tag">link</span>}
                </span>
                <span>{entry.is_dir ? "-" : formatSize(entry.size)}</span>
                <span>{formatMode(entry.mode)}</span>
              </div>
            ))}
          {!loading && entries.length === 0 && <div className="hint">目录为空</div>}
        </div>

        <div className="transfer-queue">
          <div className="section-title">传输队列</div>
          {transfers.length === 0 && <div className="hint">暂无传输任务</div>}
          {transfers.map((row) => {
            const percent = row.total > 0 ? Math.round((row.done / row.total) * 100) : 0;
            return (
              <div className="transfer-row" key={`${row.id}-${row.direction}`}>
                <span className="transfer-name">
                  {row.direction === "upload" ? "↑" : "↓"} {row.name}
                </span>
                <div className="progress">
                  <div className="progress-inner" style={{ width: `${percent}%` }} />
                </div>
                <span className="transfer-meta">
                  {row.status === "error"
                    ? row.message
                    : row.status === "done"
                      ? "完成"
                      : `${percent}% · ${formatSize(row.speed)}/s`}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
