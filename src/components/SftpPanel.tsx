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
import { Icon } from "./Icon";

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

function formatTime(mtime: number | null): string {
  if (!mtime) return "-";
  const date = new Date(mtime * 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
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
      <div className="drawer sftp-drawer">
        <div className="drawer-head">
          <div className="dh-main">
            <div className="dh-title">
              <Icon name="transfer" size={14} />
              SFTP · {profileName}
            </div>
            <div className="dh-sub">
              {sftpId ? "已连接" : "连接中…"}
              {selected ? ` · 已选 ${selected.name}` : ""}
            </div>
          </div>
          <button className="icon-btn sm" title="关闭" onClick={onClose}>
            <Icon name="x" size={14} />
          </button>
        </div>

        <div className="path-row">
          <button
            className="btn-ghost sm icon-only"
            title="上级目录"
            onClick={() => sftpId && loadDir(sftpId, parentOf(cwd))}
          >
            <Icon name="up" size={12} />
          </button>
          <input
            className="path-input"
            value={cwd}
            onChange={(event) => setCwd(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && sftpId) loadDir(sftpId, cwd);
            }}
          />
          <button
            className="btn-ghost sm icon-only"
            title="刷新"
            onClick={() => sftpId && loadDir(sftpId, cwd)}
          >
            <Icon name="refresh" size={12} />
          </button>
        </div>

        {error && (
          <div className="banner err" onClick={() => setError(null)}>
            {error}
          </div>
        )}

        <div className="sftp-tools">
          <button className="btn-primary sm" onClick={handleUpload} disabled={!sftpId}>
            <Icon name="up" size={12} />
            上传文件
          </button>
          <button
            className="btn-ghost sm"
            disabled={!selected || selected.is_dir}
            onClick={() => selected && handleDownload(selected)}
          >
            <Icon name="down" size={12} />
            下载选中
          </button>
          <div className="spacer" />
          {selected && (
            <div className="chmod-box">
              <span>权限</span>
              <input value={modeInput} onChange={(event) => setModeInput(event.target.value)} />
              <button className="btn-ghost sm" onClick={handleChmod}>
                应用
              </button>
            </div>
          )}
        </div>

        <div className="sftp-table">
          <div className="sftp-row sftp-head">
            <span className="col-name">名称</span>
            <span className="col-size">大小</span>
            <span className="col-mode">权限</span>
            <span className="col-time">修改时间</span>
          </div>
          <div className="sftp-body">
            {loading && <div className="sftp-hint">读取目录…</div>}
            {!loading &&
              entries.map((entry) => (
                <div
                  key={entry.path}
                  className={`sftp-row${selected?.path === entry.path ? " is-selected" : ""}${entry.is_dir ? " is-dir" : ""}`}
                  onClick={() => {
                    setSelected(entry);
                    if (entry.mode != null) setModeInput((entry.mode & 0o777).toString(8).padStart(3, "0"));
                  }}
                  onDoubleClick={() => entry.is_dir && sftpId && loadDir(sftpId, entry.path)}
                >
                  <span className="sftp-name col-name">
                    <Icon name={entry.is_dir ? "folder" : "file"} size={13} />
                    <span className="fname">{entry.name}</span>
                    {entry.is_symlink && <span className="tag">link</span>}
                  </span>
                  <span className="col-size mono">{entry.is_dir ? "-" : formatSize(entry.size)}</span>
                  <span className="col-mode mono">{formatMode(entry.mode)}</span>
                  <span className="col-time mono">{formatTime(entry.mtime)}</span>
                </div>
              ))}
            {!loading && entries.length === 0 && <div className="sftp-hint">目录为空</div>}
          </div>
        </div>

        <div className="drawer-queue">
          <div className="dq-head">
            <Icon name="transfer" size={12} />
            <span>传输队列</span>
            <span className="dq-count">{transfers.filter((row) => row.status === "running").length}</span>
          </div>
          {transfers.length === 0 && <div className="sftp-hint">暂无传输任务</div>}
          {transfers.map((row) => {
            const percent = row.total > 0 ? Math.round((row.done / row.total) * 100) : 0;
            return (
              <div className="queue-row" key={`${row.id}-${row.direction}`}>
                <span className={`q-dir ${row.status}`}>
                  <Icon name={row.direction === "upload" ? "up" : "down"} size={11} />
                </span>
                <div className="q-body">
                  <div className="q-top">
                    <span className="q-name">{row.name}</span>
                    <span className="q-pct mono">{row.status === "done" ? "完成" : `${percent}%`}</span>
                  </div>
                  <div className="q-bar">
                    <div
                      className={`q-fill ${row.status}`}
                      style={{ width: `${row.status === "done" ? 100 : percent}%` }}
                    />
                  </div>
                  <div className="q-meta">
                    {row.status === "error"
                      ? row.message
                      : row.status === "done"
                        ? formatSize(row.total)
                        : `${formatSize(row.done)} / ${formatSize(row.total)} · ${formatSize(row.speed)}/s`}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
