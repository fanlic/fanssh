import { useEffect, useRef, useState } from "react";
import { errorText, monitorStart, monitorStop } from "../api";
import type { HostMetrics, Profile } from "../types";
import { Icon } from "./Icon";

interface Props {
  profile: Profile | null;
  sessionId: string | null;
  paneReady: boolean;
  onClose: () => void;
}

const HISTORY_POINTS = 40;
const MAX_CORES = 24;
const MAX_DISKS = 8;

type Level = "ok" | "warn" | "danger";

function levelOf(ratio: number): Level {
  if (ratio >= 0.9) return "danger";
  if (ratio >= 0.75) return "warn";
  return "ok";
}

function fmtBytes(bytes: number, digits = 1): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(digits)} ${units[unit]}`;
}

function fmtRate(bps: number): string {
  return `${fmtBytes(bps)}/s`;
}

function fmtPercent(ratio: number): string {
  return `${(Math.max(0, Math.min(1, ratio)) * 100).toFixed(1)}%`;
}

function fmtUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  return `${minutes} 分`;
}

function fmtClock(ts: number): string {
  return new Date(ts).toLocaleTimeString("zh-CN", { hour12: false });
}

function hintFor(code: string): string | null {
  switch (code) {
    case "monitor.unsupported":
      return "监控依赖 /proc，仅支持 Linux 服务器；BSD/macOS 或受限容器暂不可用。";
    case "monitor.sample_failed":
    case "monitor.parse_failed":
      return "确认登录账号可以读取 /proc，且系统提供 df 命令。";
    case "session.not_found":
      return "SSH 会话已关闭，重新连接后监控会恢复。";
    case "ssh.exec_timeout":
      return "远端响应超时，请检查网络或服务器负载。";
    default:
      return null;
  }
}

function Bar({ ratio, level }: { ratio: number; level: Level }) {
  return (
    <div className="mon-bar">
      <span
        className={`mon-bar-fill is-${level}`}
        style={{ width: `${Math.max(0, Math.min(1, ratio)) * 100}%` }}
      />
    </div>
  );
}

/** 总 CPU 使用率的最近走势，宽度自适应。 */
function CpuSpark({ values }: { values: number[] }) {
  const data = values.length >= 2 ? values : [0, 0];
  const points = data
    .map((value, index) => {
      const x = (index / (data.length - 1)) * 100;
      const y = 26 - Math.max(0, Math.min(1, value)) * 24;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
  return (
    <svg className="mon-spark" viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true">
      <polyline
        points={points}
        fill="none"
        stroke="var(--accent)"
        strokeWidth="1.4"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/** 服务器监控面板：复用当前 SSH 会话只读采样，面板关闭即停止。 */
export function MonitorPanel({ profile, sessionId, paneReady, onClose }: Props) {
  const [metrics, setMetrics] = useState<HostMetrics | null>(null);
  const [history, setHistory] = useState<number[]>([]);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [starting, setStarting] = useState(false);
  const [reload, setReload] = useState(0);
  const generation = useRef(0);

  const ready = profile?.protocol === "ssh" && Boolean(sessionId) && paneReady;

  useEffect(() => {
    if (!ready || !sessionId) return;
    const current = (generation.current += 1);
    setMetrics(null);
    setHistory([]);
    setError(null);
    setStarting(true);
    void monitorStart(sessionId, (event) => {
      if (current !== generation.current) return;
      if (event.type === "metrics") {
        setMetrics(event.metrics);
        setError(null);
        setHistory((prev) => [...prev, event.metrics.cpu.usage].slice(-HISTORY_POINTS));
      } else {
        setError({ code: event.code, message: event.message });
      }
    })
      .catch((err) => {
        if (current === generation.current) {
          setError({ code: "monitor.start_failed", message: errorText(err) });
        }
      })
      .finally(() => {
        if (current === generation.current) setStarting(false);
      });
    return () => {
      generation.current += 1;
      void monitorStop(sessionId).catch(() => undefined);
    };
  }, [ready, sessionId, reload]);

  const usage = metrics?.cpu.usage ?? 0;
  const memRatio = metrics && metrics.mem.total > 0 ? metrics.mem.used / metrics.mem.total : 0;
  const hint = error ? hintFor(error.code) : null;

  return (
    <aside className="side-panel monitor-panel" aria-label="服务器监控">
      <header className="drawer-head">
        <div className="dh-main">
          <div className="dh-title">
            <Icon name="pulse" size={14} />
            监控
            {profile && <span className="dh-sub">· {profile.name}</span>}
          </div>
          <div className="dh-sub">
            {!profile || profile.protocol !== "ssh"
              ? "需要 SSH 会话"
              : !ready
                ? "SSH 会话未就绪"
                : metrics
                  ? `Linux · ${fmtClock(metrics.ts)}`
                  : error
                    ? "采样中断"
                    : "正在采样…"}
          </div>
        </div>
        <button
          className="icon-btn"
          title="重新采样"
          onClick={() => setReload((value) => value + 1)}
          disabled={!ready}
        >
          <Icon name="refresh" size={14} />
        </button>
        <button className="icon-btn" title="关闭" onClick={onClose}>
          <Icon name="x" size={14} />
        </button>
      </header>

      <div className="monitor-body">
        {!profile || profile.protocol !== "ssh" ? (
          <div className="mon-empty">
            <Icon name="pulse" size={22} />
            <div className="mon-empty-title">请先连接一个 Linux SSH 会话</div>
            <div className="mon-empty-desc">
              监控复用当前 SSH 连接读取远端 /proc，只读采样，不在服务器上写任何文件。
            </div>
          </div>
        ) : !ready ? (
          <div className="mon-empty">
            <Icon name="clock" size={22} />
            <div className="mon-empty-title">当前 SSH 会话尚未就绪</div>
            <div className="mon-empty-desc">等终端连接完成后再打开或刷新本面板。</div>
          </div>
        ) : error ? (
          <div className="mon-empty">
            <Icon name="alert" size={22} />
            <div className="mon-empty-title">无法获取服务器指标</div>
            <div className="mon-empty-desc">{error.message}</div>
            {hint && <div className="mon-hint">{hint}</div>}
            <button className="btn-ghost sm" onClick={() => setReload((value) => value + 1)}>
              重新采样
            </button>
          </div>
        ) : !metrics ? (
          <div className="mon-empty">
            <Icon name="pulse" size={22} />
            <div className="mon-empty-title">{starting ? "正在读取服务器指标…" : "等待采样数据"}</div>
            <div className="mon-empty-desc">首次采样会在 3 秒内返回。</div>
          </div>
        ) : (
          <>
            <section className="mon-card">
              <div className="mon-card-head">
                <span className="mon-card-title">CPU</span>
                <span className="mon-card-value">{fmtPercent(usage)}</span>
              </div>
              <CpuSpark values={history} />
              <div className="mon-meta">
                负载 1 / 5 / 15 分钟：{metrics.load1.toFixed(2)} / {metrics.load5.toFixed(2)} /{" "}
                {metrics.load15.toFixed(2)}
              </div>
              {metrics.cpu.cores.length > 0 && (
                <>
                  <div className="mon-cores">
                    {metrics.cpu.cores.slice(0, MAX_CORES).map((core, index) => (
                      <span
                        key={index}
                        className={`mon-core is-${levelOf(core)}`}
                        title={`核心 ${index}：${fmtPercent(core)}`}
                      >
                        <span style={{ height: `${Math.max(4, core * 100)}%` }} />
                      </span>
                    ))}
                  </div>
                  <div className="mon-meta">
                    {metrics.cpu.cores.length} 个核心
                    {metrics.cpu.cores.length > MAX_CORES
                      ? ` · 仅显示前 ${MAX_CORES} 个`
                      : ""}
                  </div>
                </>
              )}
              <Bar ratio={usage} level={levelOf(usage)} />
            </section>

            <section className="mon-card">
              <div className="mon-card-head">
                <span className="mon-card-title">内存</span>
                <span className="mon-card-value">{fmtPercent(memRatio)}</span>
              </div>
              <Bar ratio={memRatio} level={levelOf(memRatio)} />
              <div className="mon-meta">
                已用 {fmtBytes(metrics.mem.used)} / {fmtBytes(metrics.mem.total)}
              </div>
              <div className="mon-meta">
                缓存 {fmtBytes(metrics.mem.cached)} · 空闲 {fmtBytes(metrics.mem.free)}
              </div>
            </section>

            <section className="mon-card">
              <div className="mon-card-head">
                <span className="mon-card-title">网络</span>
              </div>
              <div className="mon-net">
                <div>
                  <span className="mon-net-label">↓ 接收</span>
                  <span className="mon-net-value">{fmtRate(metrics.net.rx_bps)}</span>
                </div>
                <div>
                  <span className="mon-net-label">↑ 发送</span>
                  <span className="mon-net-value">{fmtRate(metrics.net.tx_bps)}</span>
                </div>
              </div>
            </section>

            <section className="mon-card">
              <div className="mon-card-head">
                <span className="mon-card-title">磁盘</span>
                <span className="mon-meta">{metrics.disks.length} 个挂载点</span>
              </div>
              {metrics.disks.length === 0 ? (
                <div className="mon-meta">没有可展示的磁盘挂载点</div>
              ) : (
                <div className="mon-disks">
                  {metrics.disks.slice(0, MAX_DISKS).map((disk) => {
                    const ratio = disk.total > 0 ? disk.used / disk.total : 0;
                    return (
                      <div className="mon-disk" key={disk.mount}>
                        <div className="mon-disk-head">
                          <span className="mon-disk-mount" title={disk.mount}>
                            {disk.mount}
                          </span>
                          <span className="mon-meta">{fmtPercent(ratio)}</span>
                        </div>
                        <Bar ratio={ratio} level={levelOf(ratio)} />
                        <div className="mon-meta">
                          {fmtBytes(disk.used)} / {fmtBytes(disk.total)}
                        </div>
                      </div>
                    );
                  })}
                  {metrics.disks.length > MAX_DISKS && (
                    <div className="mon-meta">另有 {metrics.disks.length - MAX_DISKS} 个挂载点未显示</div>
                  )}
                </div>
              )}
            </section>

            <section className="mon-card">
              <div className="mon-card-head">
                <span className="mon-card-title">运行时间</span>
              </div>
              <div className="mon-card-value mon-uptime">{fmtUptime(metrics.uptime)}</div>
              <div className="mon-meta">Linux · 每 3 秒采样一次</div>
            </section>

            <div className="mon-foot">
              <span>只读采样 /proc + df，不写远端文件</span>
              <span>{fmtClock(metrics.ts)}</span>
            </div>
          </>
        )}
      </div>
    </aside>
  );
}
