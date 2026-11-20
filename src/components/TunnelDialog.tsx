import { useEffect, useState } from "react";
import { errorText, tunnelActive, tunnelStart, tunnelStop } from "../api";
import { useAppStore } from "../store";
import type { Profile, TunnelEvent, TunnelRoute, TunnelState } from "../types";
import { Icon } from "./Icon";

interface Props {
  open: boolean;
  profile: Profile | null;
  onClose: () => void;
  onEdit: (profile: Profile) => void;
  onNotice: (message: string, kind?: "info" | "error") => void;
}

interface RouteStatus {
  state: TunnelState;
  port: number | null;
  message: string | null;
}

const STATE_LABEL: Record<TunnelState, string> = {
  starting: "连接中",
  running: "运行中",
  stopped: "已停止",
  error: "失败",
};

function routeSummary(route: TunnelRoute, actualPort: number | null): string {
  const port = actualPort ?? route.local_port;
  switch (route.kind) {
    case "remote":
      return `服务器 ${route.local_host}:${port} → 本机 ${route.remote_host}:${route.remote_port}`;
    case "dynamic":
      return `本机 ${route.local_host}:${port}（SOCKS5）`;
    default:
      return `本机 ${route.local_host}:${port} → ${route.remote_host}:${route.remote_port}`;
  }
}

const KIND_LABEL: Record<TunnelRoute["kind"], string> = {
  local: "本地转发",
  remote: "远程转发",
  dynamic: "动态代理",
};

/** 隧道面板：按路由启停，状态由后端 Channel 实时推送。 */
export function TunnelDialog({ open, profile, onClose, onEdit, onNotice }: Props) {
  const profiles = useAppStore((state) => state.profiles);
  const [statuses, setStatuses] = useState<Record<string, RouteStatus>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!open || !profile) return;
    setStatuses({});
    setBusy({});
    tunnelActive()
      .then((ids) => {
        setStatuses((prev) => {
          const next = { ...prev };
          for (const id of ids) next[id] = { state: "running", port: null, message: null };
          return next;
        });
      })
      .catch(() => undefined);
  }, [open, profile]);

  if (!open || !profile) return null;

  const prefs = profile.options.tunnel;
  const routes = prefs?.routes ?? [];
  const server = profiles.find((item) => item.id === prefs?.server_id) ?? null;

  const applyEvent = (event: TunnelEvent) => {
    if (event.type !== "state") return;
    setStatuses((prev) => ({
      ...prev,
      [event.route_id]: {
        state: event.state,
        port: event.port,
        message: event.message,
      },
    }));
    if (event.state === "stopped") {
      setBusy((prev) => ({ ...prev, [event.route_id]: false }));
    }
  };

  const start = async (route: TunnelRoute) => {
    setBusy((prev) => ({ ...prev, [route.id]: true }));
    setStatuses((prev) => ({
      ...prev,
      [route.id]: { state: "starting", port: null, message: null },
    }));
    try {
      await tunnelStart(profile.id, route.id, applyEvent);
    } catch (error) {
      const message = errorText(error);
      setStatuses((prev) => ({
        ...prev,
        [route.id]: { state: "error", port: null, message },
      }));
      setBusy((prev) => ({ ...prev, [route.id]: false }));
      onNotice(message, "error");
    }
  };

  const stop = async (route: TunnelRoute) => {
    setBusy((prev) => ({ ...prev, [route.id]: true }));
    try {
      await tunnelStop(route.id);
    } catch (error) {
      onNotice(errorText(error), "error");
      setBusy((prev) => ({ ...prev, [route.id]: false }));
    }
  };

  return (
    <div className="dlg-mask" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="dlg tunnel-dlg">
        <div className="dlg-head">
          <h2>隧道 · {profile.name}</h2>
          <div className="spacer" />
          <button className="icon-btn sm" title="关闭" onClick={onClose}>
            <Icon name="x" size={14} />
          </button>
        </div>

        <div className="dlg-body">
          {server ? (
            <p className="tunnel-meta">
              服务器：{server.name}（{server.target.user}@{server.target.host}:{server.target.port}）
              <span className="muted">
                {" "}
                · 自动重连：{prefs?.auto_reconnect ? "开启" : "关闭"}
              </span>
            </p>
          ) : (
            <p className="update-hint">
              隧道绑定的 SSH 服务器不存在或尚未选择，请先编辑配置。
            </p>
          )}

          {routes.length === 0 ? (
            <div className="tunnel-empty">
              <Icon name="transfer" size={18} />
              <div>这个隧道还没有路由</div>
              <button className="btn-ghost sm" onClick={() => onEdit(profile)}>
                编辑路由
              </button>
            </div>
          ) : (
            <div className="tunnel-list">
              {routes.map((route) => {
                const status = statuses[route.id];
                const state = status?.state ?? "stopped";
                const running = state === "running" || state === "starting";
                return (
                  <div className="tunnel-row" key={route.id}>
                    <span className={`tunnel-dot ${state}`} />
                    <div className="tunnel-info">
                      <div className="tunnel-title">
                        <span className="proto-tag tunnel">{KIND_LABEL[route.kind]}</span>
                        <span className="tunnel-route">{routeSummary(route, status?.port ?? null)}</span>
                      </div>
                      <div className="tunnel-state">
                        {STATE_LABEL[state]}
                        {status?.message ? `：${status.message}` : ""}
                      </div>
                    </div>
                    <div className="spacer" />
                    {running ? (
                      <button
                        className="btn-ghost sm"
                        disabled={busy[route.id]}
                        onClick={() => void stop(route)}
                      >
                        停止
                      </button>
                    ) : (
                      <button
                        className="btn-primary sm"
                        disabled={busy[route.id] || !server}
                        onClick={() => void start(route)}
                      >
                        启动
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="dlg-foot">
          <span className="muted">隧道经 SSH 服务器转发，关闭面板不会中断已启动的路由。</span>
          <div className="spacer" />
          <button
            className="btn-ghost"
            onClick={() => {
              onClose();
              onEdit(profile);
            }}
          >
            编辑配置
          </button>
          <button className="btn-primary" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
