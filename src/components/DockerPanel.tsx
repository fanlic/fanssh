import { useCallback, useEffect, useState } from "react";
import { dockerContainers, dockerLogs, errorText } from "../api";
import type { DockerContainer, DockerLogChunk, DockerLogs, Profile } from "../types";
import { Icon } from "./Icon";

interface Props {
  profile: Profile | null;
  sessionId: string | null;
  paneReady: boolean;
  onClose: () => void;
  onOpenShell: (container: DockerContainer) => void;
}

const LOG_TAIL = 500;

/** 只保留最近 max 行，避免跟随轮询无限堆内存。 */
function capLogs(logs: DockerLogs, max = LOG_TAIL): DockerLogs {
  let remaining = max;
  const chunks: DockerLogChunk[] = [];
  for (let index = logs.chunks.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const chunk = logs.chunks[index];
    const lines = chunk.text.split("\n");
    if (lines.length <= remaining) {
      chunks.unshift(chunk);
      remaining -= lines.length;
    } else {
      chunks.unshift({ ...chunk, text: lines.slice(-remaining).join("\n") });
      remaining = 0;
    }
  }
  return { ...logs, chunks };
}

function errorCode(error: unknown): string {
  return String((error as { code?: string } | null)?.code ?? "");
}

function errorHint(code: string): string | null {
  switch (code) {
    case "docker.socket_missing":
      return "确认远端已安装 Docker；如果 socket 不在 /var/run/docker.sock，本版暂不支持自定义路径。";
    case "docker.permission":
      return "把登录用户加入 docker 组后重新登录（newgrp docker 或重新 SSH），或改用有权限的账号。";
    case "docker.daemon":
    case "docker.socket_failed":
      return "确认 dockerd / docker.service 正在运行，且 socket 路径为默认的 /var/run/docker.sock。";
    case "docker.not_found":
      return "容器可能已被删除，点刷新重新加载列表。";
    default:
      return null;
  }
}

/** Docker 面板：容器列表 + 最近日志，绑定当前活动 SSH 会话。 */
export function DockerPanel({ profile, sessionId, paneReady, onClose, onOpenShell }: Props) {
  const [containers, setContainers] = useState<DockerContainer[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [logs, setLogs] = useState<DockerLogs | null>(null);
  const [logsBusy, setLogsBusy] = useState(false);
  const [logsError, setLogsError] = useState<unknown>(null);
  const [follow, setFollow] = useState(false);

  const ready = profile?.protocol === "ssh" && Boolean(sessionId) && paneReady;
  const selected = containers.find((item) => item.id === selectedId) ?? null;

  const loadContainers = useCallback(async () => {
    if (!sessionId || !ready) return;
    setLoading(true);
    setError(null);
    try {
      const list = await dockerContainers(sessionId);
      setContainers(list);
      setSelectedId((current) =>
        current && list.some((item) => item.id === current) ? current : null,
      );
    } catch (err) {
      setError(err);
      setContainers([]);
    } finally {
      setLoading(false);
    }
  }, [sessionId, ready]);

  useEffect(() => {
    setContainers([]);
    setSelectedId(null);
    setLogs(null);
    setLogsError(null);
    setFollow(false);
    setError(null);
    if (ready) void loadContainers();
  }, [ready, sessionId, loadContainers]);

  const loadLogs = useCallback(async () => {
    if (!sessionId || !selectedId) return;
    setLogsBusy(true);
    try {
      const next = await dockerLogs(sessionId, selectedId, LOG_TAIL);
      setLogs(capLogs(next));
      setLogsError(null);
    } catch (err) {
      setLogsError(err);
      setFollow(false);
    } finally {
      setLogsBusy(false);
    }
  }, [sessionId, selectedId]);

  useEffect(() => {
    setLogs(null);
    setLogsError(null);
    if (ready && selectedId) void loadLogs();
  }, [ready, selectedId, loadLogs]);

  // 跟随：每 2 秒重新拉取最近 500 行并整体替换，内存有上限，随时可停。
  useEffect(() => {
    if (!follow || !ready || !selectedId || !sessionId) return;
    const timer = window.setInterval(() => void loadLogs(), 2000);
    return () => window.clearInterval(timer);
  }, [follow, ready, selectedId, sessionId, loadLogs]);

  const code = errorCode(error);
  const hint = errorHint(code);
  const logsCode = errorCode(logsError);
  const logsHint = errorHint(logsCode);

  return (
    <div
      className="drawer-mask"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside className="drawer docker-drawer" aria-label="Docker 管理">
        <header className="drawer-head">
          <div className="dh-main">
            <div className="dh-title">
              <Icon name="docker" size={14} />
              Docker
              {profile && <span className="dh-sub">· {profile.name}</span>}
            </div>
            <div className="dh-sub">
              {!profile || profile.protocol !== "ssh"
                ? "需要 SSH 会话"
                : !ready
                  ? "SSH 会话未就绪"
                  : selected
                    ? `容器 · ${selected.name}`
                    : `${containers.length} 个容器`}
            </div>
          </div>
          <button
            className="icon-btn"
            title="刷新容器列表"
            onClick={() => void loadContainers()}
            disabled={!ready || loading}
          >
            <Icon name="refresh" size={14} />
          </button>
          <button className="icon-btn" title="关闭" onClick={onClose}>
            <Icon name="x" size={14} />
          </button>
        </header>

        <div className="docker-body">
          {!profile || profile.protocol !== "ssh" ? (
            <div className="docker-empty">
              <Icon name="docker" size={22} />
              <div className="docker-empty-title">请先连接一个 Linux SSH 会话</div>
              <div className="docker-empty-desc">
                Docker 面板复用当前 SSH 会话的通道访问远端 docker.sock，不额外开端口、不需要装 agent。
              </div>
            </div>
          ) : !ready ? (
            <div className="docker-empty">
              <Icon name="clock" size={22} />
              <div className="docker-empty-title">当前 SSH 会话尚未就绪</div>
              <div className="docker-empty-desc">等终端连接完成后再打开或刷新本面板。</div>
            </div>
          ) : error ? (
            <div className="docker-empty">
              <Icon name="alert" size={22} />
              <div className="docker-empty-title">Docker 不可用</div>
              <div className="docker-empty-desc">{errorText(error)}</div>
              {hint && <div className="docker-hint">{hint}</div>}
              <button className="btn-ghost sm" onClick={() => void loadContainers()}>
                重试
              </button>
            </div>
          ) : (
            <>
              <div className={`docker-list${loading && containers.length === 0 ? " is-loading" : ""}`}>
                {loading && containers.length === 0 && <div className="docker-tip">正在读取容器…</div>}
                {!loading && containers.length === 0 && (
                  <div className="docker-tip">Docker 已连接，但没有容器（含已停止）。</div>
                )}
                {containers.map((container) => (
                  <button
                    key={container.id}
                    className={`docker-row${selectedId === container.id ? " is-active" : ""}`}
                    onClick={() => setSelectedId(container.id)}
                    title={container.id}
                  >
                    <span className={`docker-dot st-${container.state}`} />
                    <span className="docker-name">{container.name || container.id.slice(0, 12)}</span>
                    <span className="docker-image">{container.image}</span>
                    <span className={`docker-state st-${container.state}`}>{container.state}</span>
                    <span className="docker-status">{container.status}</span>
                    <span className="docker-ports">{container.ports || "—"}</span>
                  </button>
                ))}
              </div>

              <section className="docker-logsec">
                <div className="docker-loghead">
                  <span className="docker-logtitle">
                    {selected ? selected.name : "选择容器查看日志"}
                  </span>
                  <span className="docker-logmeta">最近 {LOG_TAIL} 行</span>
                  <div className="spacer" />
                  <label className="docker-follow">
                    <input
                      type="checkbox"
                      checked={follow}
                      disabled={!selected || logsBusy}
                      onChange={(event) => setFollow(event.target.checked)}
                    />
                    跟随
                  </label>
                  <button
                    className="btn-ghost sm"
                    onClick={() => void loadLogs()}
                    disabled={!selected || logsBusy}
                  >
                    {logsBusy ? "读取中…" : "刷新日志"}
                  </button>
                  <button
                    className="btn-primary sm"
                    disabled={!selected || selected.state !== "running"}
                    title={
                      selected && selected.state !== "running"
                        ? "容器未运行，无法进入终端"
                        : "在服务器 SSH 终端输入行插入 docker exec 命令（不自动执行）"
                    }
                    onClick={() => selected && onOpenShell(selected)}
                  >
                    进入终端
                  </button>
                </div>

                {logsError ? (
                  <div className="docker-logerr">
                    <div>{errorText(logsError)}</div>
                    {logsHint && <div className="docker-hint">{logsHint}</div>}
                  </div>
                ) : (
                  <pre className="docker-logs">
                    {logs?.chunks.map((chunk, index) => (
                      <span
                        key={index}
                        className={chunk.stream === "stderr" ? "dl-err" : "dl-out"}
                      >
                        {chunk.text}
                      </span>
                    ))}
                    {!logs && !selected && (
                      <span className="dl-empty">选择一个容器查看最近 {LOG_TAIL} 行日志。</span>
                    )}
                    {!logs && selected && logsBusy && (
                      <span className="dl-empty">正在读取日志…</span>
                    )}
                  </pre>
                )}
                {logs?.truncated && (
                  <div className="docker-logmeta">输出较长，仅保留最近 {LOG_TAIL} 行。</div>
                )}
              </section>
            </>
          )}
        </div>
      </aside>
    </div>
  );
}
