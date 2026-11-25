import { useCallback, useEffect, useRef, useState } from "react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  errorText,
  sftpChmod,
  sftpClose,
  sftpDownload,
  sftpList,
  sftpLocalExists,
  sftpMkdir,
  sftpOpen,
  sftpReadText,
  sftpRemove,
  sftpRename,
  sftpUpload,
  sftpWriteText,
} from "../api";
import type { RemoteEntry, SftpConflict, TransferEvent } from "../types";
import { Icon } from "./Icon";

interface Props {
  profileId: string;
  profileName: string;
  sessionId?: string;
  onClose: () => void;
}

interface TransferRow {
  id: string;
  name: string;
  direction: string;
  done: number;
  total: number;
  speed: number;
  status: "running" | "done" | "error" | "skipped";
  message?: string;
  resumed: number;
  remotePath: string;
  localPath: string | null;
  conflict: SftpConflict;
}

interface EditorState {
  path: string;
  name: string;
  content: string;
  saved: string;
  mtime: number | null;
  mode: number | null;
  size: number;
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

function joinRemote(dir: string, name: string): string {
  if (dir === "" || dir === "/") return `/${name}`;
  return `${dir.replace(/\/+$/, "")}/${name}`;
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** 返回带点的扩展名（".md"），无扩展名时返回空串。 */
function extOf(name: string): string {
  const index = name.lastIndexOf(".");
  return index > 0 ? name.slice(index) : "";
}

export function SftpPanel({ profileId, profileName, sessionId, onClose }: Props) {
  const [sftpId, setSftpId] = useState<string | null>(null);
  const [cwd, setCwd] = useState("");
  const [homeDir, setHomeDir] = useState("");
  const [entries, setEntries] = useState<RemoteEntry[]>([]);
  const [showHidden, setShowHidden] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<RemoteEntry | null>(null);
  const [checked, setChecked] = useState<string[]>([]);
  const [modeInput, setModeInput] = useState("644");
  const [transfers, setTransfers] = useState<TransferRow[]>([]);
  const sftpRef = useRef<string | null>(null);

  const [conflictAsk, setConflictAsk] = useState<{ name: string; remaining: number } | null>(null);
  const [rememberChoice, setRememberChoice] = useState(false);
  const conflictResolver = useRef<
    ((answer: { choice: SftpConflict; remember: boolean } | null) => void) | null
  >(null);

  const [dialog, setDialog] = useState<{
    title: string;
    value: string;
    confirmLabel: string;
  } | null>(null);
  const dialogResolver = useRef<((value: string | null) => void) | null>(null);

  const [renameOpen, setRenameOpen] = useState(false);
  const [renamePrefix, setRenamePrefix] = useState("");
  const [renameStart, setRenameStart] = useState("1");

  const [editor, setEditor] = useState<EditorState | null>(null);
  const [editorBusy, setEditorBusy] = useState(false);
  const [editorConflict, setEditorConflict] = useState(false);

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
              resumed: 0,
              remotePath: "",
              localPath: null,
              conflict: "overwrite",
            };
      let next: TransferRow = base;
      switch (event.type) {
        case "start":
          next = {
            ...base,
            name: event.name,
            total: event.total,
            direction: event.direction,
            status: "running",
            resumed: event.resumed,
            done: event.resumed,
            speed: 0,
            remotePath: event.remote_path,
            localPath: event.local_path,
            conflict: event.conflict as SftpConflict,
          };
          break;
        case "skipped":
          next = { ...base, name: event.name, status: "skipped", speed: 0 };
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
      setChecked([]);
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
        const resp = await sftpOpen(profileId, sessionId);
        if (disposed) {
          sftpClose(resp.sftp_id).catch(() => undefined);
          return;
        }
        sftpRef.current = resp.sftp_id;
        setSftpId(resp.sftp_id);
        setHomeDir(resp.home);
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
  }, [profileId, sessionId, loadDir]);

  const askConflict = (name: string, remaining: number) =>
    new Promise<{ choice: SftpConflict; remember: boolean } | null>((resolve) => {
      conflictResolver.current = resolve;
      setRememberChoice(false);
      setConflictAsk({ name, remaining });
    });

  const answerConflict = (choice: SftpConflict | null) => {
    const resolve = conflictResolver.current;
    conflictResolver.current = null;
    const remember = rememberChoice;
    setConflictAsk(null);
    setRememberChoice(false);
    resolve?.(choice ? { choice, remember } : null);
  };

  const askText = (title: string, value: string, confirmLabel = "确定") =>
    new Promise<string | null>((resolve) => {
      dialogResolver.current = resolve;
      setDialog({ title, value, confirmLabel });
    });

  const closeTextDialog = (value: string | null) => {
    const resolve = dialogResolver.current;
    dialogResolver.current = null;
    setDialog(null);
    resolve?.(value);
  };

  const toggleChecked = (path: string) => {
    setChecked((prev) =>
      prev.includes(path) ? prev.filter((item) => item !== path) : [...prev, path],
    );
  };

  const visibleEntries = showHidden
    ? entries
    : entries.filter((entry) => !entry.name.startsWith("."));

  const checkedEntries = checked
    .map((path) => entries.find((entry) => entry.path === path))
    .filter((entry): entry is RemoteEntry => Boolean(entry));

  const previewName = (entry: RemoteEntry, index: number) => {
    const start = Number.parseInt(renameStart, 10);
    const base = Number.isNaN(start) ? index : start + index;
    return `${renamePrefix}${base}${extOf(entry.name)}`;
  };

  const handleUpload = async () => {
    if (!sftpId) return;
    const picked = await openDialog({ multiple: true, title: "选择要上传的文件" });
    if (!picked) return;
    const paths = Array.isArray(picked) ? picked : [picked];
    if (paths.length === 0) return;
    try {
      const latest = await sftpList(sftpId, cwd);
      const existing = new Set(latest.map((entry) => entry.name));
      const conflicts = paths.filter((path) => existing.has(baseName(path)));
      const jobs: Array<{ path: string; conflict: SftpConflict }> = [];
      let remembered: SftpConflict | null = null;
      let asked = 0;
      for (const path of paths) {
        let policy: SftpConflict = "overwrite";
        if (existing.has(baseName(path))) {
          if (remembered) {
            policy = remembered;
          } else {
            const answer = await askConflict(baseName(path), conflicts.length - asked);
            asked += 1;
            if (!answer) return;
            policy = answer.choice;
            if (answer.remember) remembered = answer.choice;
          }
        }
        jobs.push({ path, conflict: policy });
      }
      for (const job of jobs) {
        await sftpUpload(sftpId, [job.path], cwd, job.conflict, false, applyTransferEvent);
      }
      await loadDir(sftpId, cwd);
    } catch (err) {
      setError(errorText(err));
    }
  };

  const handleDownload = async (entry: RemoteEntry | null) => {
    if (!sftpId || !entry || entry.is_dir) return;
    const target = await saveDialog({ defaultPath: entry.name, title: "保存到本地" });
    if (!target) return;
    try {
      let policy: SftpConflict = "overwrite";
      if (await sftpLocalExists(target)) {
        const answer = await askConflict(entry.name, 1);
        if (!answer) return;
        policy = answer.choice;
      }
      await sftpDownload(sftpId, entry.path, target, policy, false, applyTransferEvent);
    } catch (err) {
      setError(errorText(err));
    }
  };

  const handleRestart = async (row: TransferRow) => {
    if (!sftpId || !row.remotePath || !row.localPath) return;
    try {
      if (row.direction === "upload") {
        await sftpUpload(
          sftpId,
          [row.localPath],
          parentOf(row.remotePath),
          row.conflict,
          true,
          applyTransferEvent,
        );
        await loadDir(sftpId, cwd);
      } else {
        await sftpDownload(
          sftpId,
          row.remotePath,
          row.localPath,
          row.conflict,
          true,
          applyTransferEvent,
        );
      }
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

  const handleMkdir = async () => {
    if (!sftpId) return;
    const name = await askText("新建目录", "");
    if (!name) return;
    try {
      await sftpMkdir(sftpId, joinRemote(cwd, name));
      await loadDir(sftpId, cwd);
    } catch (err) {
      setError(errorText(err));
    }
  };

  const handleRename = async () => {
    if (!sftpId || checkedEntries.length === 0) return;
    if (checkedEntries.length === 1) {
      const entry = checkedEntries[0];
      const name = await askText("重命名", entry.name);
      if (!name || name === entry.name) return;
      try {
        await sftpRename(sftpId, entry.path, joinRemote(cwd, name));
        await loadDir(sftpId, cwd);
      } catch (err) {
        setError(errorText(err));
      }
      return;
    }
    setRenamePrefix("");
    setRenameStart("1");
    setRenameOpen(true);
  };

  const applyBatchRename = async () => {
    if (!sftpId) return;
    const prefix = renamePrefix.trim();
    const start = Number.parseInt(renameStart, 10);
    if (!prefix) {
      setError("请填写新名称前缀");
      return;
    }
    if (Number.isNaN(start) || start < 0) {
      setError("起始序号需要是大于等于 0 的整数");
      return;
    }
    const failures: string[] = [];
    for (const [index, entry] of checkedEntries.entries()) {
      const next = `${prefix}${start + index}${extOf(entry.name)}`;
      try {
        await sftpRename(sftpId, entry.path, joinRemote(cwd, next));
      } catch (err) {
        failures.push(`${entry.name} → ${next}（${errorText(err)}）`);
      }
    }
    setRenameOpen(false);
    await loadDir(sftpId, cwd);
    if (failures.length > 0) {
      setError(`重命名完成，${failures.length} 项失败：${failures.join("；")}`);
    }
  };

  const handleDelete = async () => {
    if (!sftpId || checkedEntries.length === 0) return;
    if (
      !window.confirm(
        `确定删除 ${checkedEntries.length} 项？目录需为空才能删除，此操作不可撤销。`,
      )
    ) {
      return;
    }
    try {
      const results = await sftpRemove(
        sftpId,
        checkedEntries.map((entry) => entry.path),
      );
      const failed = results.filter((item) => !item.ok);
      await loadDir(sftpId, cwd);
      if (failed.length > 0) {
        setError(
          `删除完成，${failed.length} 项失败：${failed
            .map((item) => `${item.path}（${item.error ?? "未知错误"}）`)
            .join("；")}`,
        );
      }
    } catch (err) {
      setError(errorText(err));
    }
  };

  const openEditor = async (entry: RemoteEntry) => {
    if (!sftpId || entry.is_dir) return;
    try {
      const file = await sftpReadText(sftpId, entry.path);
      setEditorConflict(false);
      setEditor({
        path: entry.path,
        name: entry.name,
        content: file.content,
        saved: file.content,
        mtime: file.mtime,
        mode: file.mode,
        size: file.size,
      });
    } catch (err) {
      setError(errorText(err));
    }
  };

  const saveEditor = async (force = false) => {
    if (!sftpId || !editor) return;
    setEditorBusy(true);
    try {
      const file = await sftpWriteText(
        sftpId,
        editor.path,
        editor.content,
        force ? null : editor.mtime,
      );
      setEditor({
        ...editor,
        saved: editor.content,
        mtime: file.mtime,
        mode: file.mode,
        size: file.size,
      });
      setEditorConflict(false);
      await loadDir(sftpId, cwd);
    } catch (err) {
      const message = errorText(err);
      if (message.includes("已被修改")) {
        setEditorConflict(true);
      } else {
        setError(message);
      }
    } finally {
      setEditorBusy(false);
    }
  };

  const reloadEditor = async () => {
    if (!sftpId || !editor) return;
    try {
      const file = await sftpReadText(sftpId, editor.path);
      setEditor({
        ...editor,
        content: file.content,
        saved: file.content,
        mtime: file.mtime,
        mode: file.mode,
        size: file.size,
      });
      setEditorConflict(false);
    } catch (err) {
      setError(errorText(err));
    }
  };

  const closeEditor = () => {
    if (editor && editor.content !== editor.saved) {
      if (!window.confirm("放弃未保存的修改？")) return;
    }
    setEditor(null);
    setEditorConflict(false);
  };

  const visibleChecked = checked.filter((path) => visibleEntries.some((entry) => entry.path === path));
  const allChecked = visibleEntries.length > 0 && visibleChecked.length === visibleEntries.length;

  return (
    <aside className="side-panel sftp-panel" aria-label="文件工作区">
        <div className="drawer-head">
          <div className="dh-main">
            <div className="dh-title">
              <Icon name="transfer" size={14} />
              文件工作区
            </div>
            <div className="dh-sub">
              {profileName} · {sftpId ? "已连接" : "连接中…"}
              {checked.length > 0
                ? ` · 已选 ${checked.length} 项`
                : selected
                  ? ` · 已选 ${selected.name}`
                  : ""}
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
            title="Home"
            onClick={() => sftpId && homeDir && loadDir(sftpId, homeDir)}
          >
            <Icon name="folder" size={12} />
          </button>
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
            onClick={() => handleDownload(selected)}
          >
            <Icon name="down" size={12} />
            下载
          </button>
          <button className="btn-ghost sm" onClick={handleMkdir} disabled={!sftpId}>
            <Icon name="plus" size={12} />
            新建目录
          </button>
          <button
            className={`btn-ghost sm${showHidden ? " is-on" : ""}`}
            onClick={() => {
              setShowHidden((value) => !value);
              setChecked([]);
            }}
            disabled={!sftpId}
            title="显示或隐藏以 . 开头的文件"
          >
            <Icon name="filter" size={12} />
            隐藏文件
          </button>
          <button
            className="btn-ghost sm"
            onClick={handleRename}
            disabled={checkedEntries.length === 0}
          >
            <Icon name="edit" size={12} />
            重命名{checkedEntries.length > 1 ? ` (${checkedEntries.length})` : ""}
          </button>
          <button
            className="btn-ghost sm"
            onClick={handleDelete}
            disabled={checkedEntries.length === 0}
          >
            <Icon name="trash" size={12} />
            删除{checkedEntries.length > 1 ? ` (${checkedEntries.length})` : ""}
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
            <span className="col-check">
              <input
                type="checkbox"
                checked={allChecked}
                onChange={() =>
                  setChecked(allChecked ? [] : visibleEntries.map((entry) => entry.path))
                }
                aria-label="全选"
              />
            </span>
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
                  onDoubleClick={() => {
                    if (entry.is_dir) {
                      if (sftpId) loadDir(sftpId, entry.path);
                    } else {
                      openEditor(entry);
                    }
                  }}
                >
                  <span className="col-check" onClick={(event) => event.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={checked.includes(entry.path)}
                      onChange={() => toggleChecked(entry.path)}
                      aria-label={`选择 ${entry.name}`}
                    />
                  </span>
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
            {!loading && visibleEntries.length === 0 && <div className="sftp-hint">目录为空</div>}
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
                    <span className="q-pct mono">
                      {row.status === "done"
                        ? "完成"
                        : row.status === "skipped"
                          ? "已跳过"
                          : `${percent}%`}
                    </span>
                  </div>
                  <div className="q-bar">
                    <div
                      className={`q-fill ${row.status}`}
                      style={{ width: `${row.status === "done" ? 100 : percent}%` }}
                    />
                  </div>
                  <div className="q-meta">
                    {row.status === "error" ? (
                      <>
                        {row.message}
                        {row.remotePath && row.localPath && (
                          <button className="btn-ghost sm q-act" onClick={() => handleRestart(row)}>
                            重新开始
                          </button>
                        )}
                      </>
                    ) : row.status === "skipped" ? (
                      "目标已存在，本次未传输"
                    ) : row.status === "done" ? (
                      <>
                        {formatSize(row.total)}
                        {row.resumed > 0 ? ` · 续传 ${formatSize(row.resumed)}` : ""}
                      </>
                    ) : (
                      <>
                        {formatSize(row.done)} / {formatSize(row.total)} · {formatSize(row.speed)}/s
                        {row.resumed > 0 ? ` · 续传 ${formatSize(row.resumed)}` : ""}
                      </>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {conflictAsk && (
          <div className="dlg-mask">
            <div className="dlg sftp-dlg">
              <div className="dlg-head">
                <h2>同名文件已存在</h2>
              </div>
              <div className="dlg-body">
                <p className="conflict-name mono">{conflictAsk.name}</p>
                <p className="dlg-text">
                  本次操作还有 {conflictAsk.remaining} 个同名文件需要处理。
                </p>
                <label className="inline">
                  <input
                    type="checkbox"
                    checked={rememberChoice}
                    onChange={(event) => setRememberChoice(event.target.checked)}
                  />
                  此次操作不再询问
                </label>
              </div>
              <div className="dlg-foot">
                <button className="btn-ghost sm" onClick={() => answerConflict(null)}>
                  取消
                </button>
                <div className="spacer" />
                <button className="btn-ghost sm" onClick={() => answerConflict("skip")}>
                  跳过
                </button>
                <button className="btn-ghost sm" onClick={() => answerConflict("rename")}>
                  重命名
                </button>
                <button className="btn-primary sm" onClick={() => answerConflict("overwrite")}>
                  覆盖
                </button>
              </div>
            </div>
          </div>
        )}

        {renameOpen && checkedEntries.length > 0 && (
          <div
            className="dlg-mask"
            onMouseDown={(event) => event.target === event.currentTarget && setRenameOpen(false)}
          >
            <div className="dlg sftp-dlg">
              <div className="dlg-head">
                <h2>批量重命名 · {checkedEntries.length} 项</h2>
                <div className="spacer" />
                <button className="icon-btn sm" title="关闭" onClick={() => setRenameOpen(false)}>
                  <Icon name="x" size={14} />
                </button>
              </div>
              <div className="dlg-body">
                <div className="field-row">
                  <label>
                    前缀
                    <input
                      value={renamePrefix}
                      onChange={(event) => setRenamePrefix(event.target.value)}
                      placeholder="例如 photo-"
                    />
                  </label>
                  <label>
                    起始序号
                    <input
                      value={renameStart}
                      onChange={(event) => setRenameStart(event.target.value)}
                      inputMode="numeric"
                    />
                  </label>
                </div>
                <div className="rename-preview">
                  <div className="rename-preview-head">预览（共 {checkedEntries.length} 项，保留原扩展名）</div>
                  {checkedEntries.slice(0, 6).map((entry, index) => (
                    <div className="rename-row" key={entry.path}>
                      <span className="old">{entry.name}</span>
                      <span>→</span>
                      <span className="new">{previewName(entry, index)}</span>
                    </div>
                  ))}
                  {checkedEntries.length > 6 && (
                    <div className="sftp-hint">… 还有 {checkedEntries.length - 6} 项</div>
                  )}
                </div>
              </div>
              <div className="dlg-foot">
                <span className="muted">执行前请确认预览</span>
                <div className="spacer" />
                <button className="btn-ghost sm" onClick={() => setRenameOpen(false)}>
                  取消
                </button>
                <button
                  className="btn-primary sm"
                  onClick={applyBatchRename}
                  disabled={!renamePrefix.trim()}
                >
                  重命名 {checkedEntries.length} 项
                </button>
              </div>
            </div>
          </div>
        )}

        {dialog && (
          <div className="dlg-mask">
            <div className="dlg sftp-dlg">
              <div className="dlg-head">
                <h2>{dialog.title}</h2>
              </div>
              <div className="dlg-body">
                <input
                  className="path-input"
                  autoFocus
                  value={dialog.value}
                  onChange={(event) => setDialog({ ...dialog, value: event.target.value })}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") closeTextDialog(dialog.value.trim() || null);
                    if (event.key === "Escape") closeTextDialog(null);
                  }}
                />
              </div>
              <div className="dlg-foot">
                <div className="spacer" />
                <button className="btn-ghost sm" onClick={() => closeTextDialog(null)}>
                  取消
                </button>
                <button
                  className="btn-primary sm"
                  onClick={() => closeTextDialog(dialog.value.trim() || null)}
                >
                  {dialog.confirmLabel}
                </button>
              </div>
            </div>
          </div>
        )}

        {editor && (
          <div
            className="dlg-mask"
            onMouseDown={(event) => event.target === event.currentTarget && closeEditor()}
          >
            <div className="dlg editor-dlg">
              <div className="dlg-head">
                <h2>{editor.name}</h2>
                <span className="tag">
                  UTF-8 · {formatSize(editor.size)} · {formatMode(editor.mode)}
                </span>
                <div className="spacer" />
                <button className="icon-btn sm" title="关闭" onClick={closeEditor}>
                  <Icon name="x" size={14} />
                </button>
              </div>
              <div className="dlg-body editor-body">
                <textarea
                  className="editor-area"
                  spellCheck={false}
                  value={editor.content}
                  onChange={(event) => setEditor({ ...editor, content: event.target.value })}
                />
                {editorConflict && (
                  <div className="editor-conflict">
                    <Icon name="alert" size={14} />
                    <span>远端文件已被修改，直接保存会覆盖他人的改动。</span>
                    <div className="spacer" />
                    <button className="btn-ghost sm" onClick={reloadEditor}>
                      重新加载
                    </button>
                    <button className="btn-primary sm" onClick={() => saveEditor(true)}>
                      强制覆盖
                    </button>
                  </div>
                )}
              </div>
              <div className="dlg-foot">
                <span className="muted">
                  {editor.content === editor.saved ? "没有未保存修改" : "有未保存修改"}
                </span>
                <div className="spacer" />
                <button className="btn-ghost sm" onClick={closeEditor}>
                  关闭
                </button>
                <button
                  className="btn-primary sm"
                  onClick={() => saveEditor(false)}
                  disabled={editorBusy || editor.content === editor.saved}
                >
                  {editorBusy ? "保存中…" : "保存"}
                </button>
              </div>
            </div>
          </div>
        )}
    </aside>
  );
}
