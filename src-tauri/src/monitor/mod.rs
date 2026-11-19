//! 服务器监控：复用当前 SSH 连接执行只读命令，解析 `/proc` 与 `df`。
//!
//! 约束：
//! - 只在远端执行固定的只读命令，不写文件、不落采集脚本；
//! - 每个会话最多一个采样任务，停止面板或关闭会话后立即结束；
//! - 失败按原因上报（非 Linux / 权限 / 命令缺失），不静默。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::ipc::Channel as TauriChannel;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

use crate::ipc::error::{AppError, AppResult};
use crate::session::manager::SshManager;
use crate::session::model::SessionId;

/// 采样间隔，与对标产品的最小 3 秒一致。
pub const SAMPLE_INTERVAL: Duration = Duration::from_secs(3);

/// 固定只读采样命令。使用 `##` 分段，便于解析且不依赖远端 shell 类型。
const SAMPLE_COMMAND: &str = r#"if [ ! -r /proc/stat ]; then printf '__FANSSH_NO_PROC__\n'; exit 0; fi
printf '##uptime\n'; cat /proc/uptime 2>/dev/null
printf '##load\n'; cat /proc/loadavg 2>/dev/null
printf '##stat\n'; cat /proc/stat 2>/dev/null
printf '##mem\n'; cat /proc/meminfo 2>/dev/null
printf '##net\n'; cat /proc/net/dev 2>/dev/null
printf '##df\n'; df -Pk 2>/dev/null
"#;

#[derive(Clone, Debug, Serialize)]
pub struct CpuMetrics {
    /// 0.0 ~ 1.0
    pub usage: f64,
    pub cores: Vec<f64>,
}

#[derive(Clone, Debug, Serialize)]
pub struct MemMetrics {
    pub total: u64,
    pub used: u64,
    pub cached: u64,
    pub free: u64,
}

#[derive(Clone, Debug, Serialize)]
pub struct DiskMetrics {
    pub mount: String,
    pub total: u64,
    pub used: u64,
}

#[derive(Clone, Debug, Serialize)]
pub struct NetMetrics {
    pub rx_bps: f64,
    pub tx_bps: f64,
}

#[derive(Clone, Debug, Serialize)]
pub struct HostMetrics {
    /// 毫秒时间戳
    pub ts: u64,
    /// 秒
    pub uptime: u64,
    pub load1: f64,
    pub load5: f64,
    pub load15: f64,
    pub cpu: CpuMetrics,
    pub mem: MemMetrics,
    pub disks: Vec<DiskMetrics>,
    pub net: NetMetrics,
    pub platform: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum MonitorEvent {
    Metrics { metrics: HostMetrics },
    Error { code: String, message: String },
}

#[derive(Default)]
struct SampleState {
    prev_cpu: Option<(u64, u64)>,
    prev_cores: Vec<(u64, u64)>,
    prev_net: Option<(u64, u64, Instant)>,
}

struct MonitorTask {
    id: u64,
    handle: JoinHandle<()>,
}

/// 按会话管理采样任务，保证同一会话不会重复采样。
#[derive(Clone, Default)]
pub struct MonitorManager {
    tasks: Arc<Mutex<HashMap<SessionId, MonitorTask>>>,
    seq: Arc<AtomicU64>,
}

impl MonitorManager {
    pub async fn start(
        &self,
        ssh: SshManager,
        session: SessionId,
        on_event: TauriChannel<MonitorEvent>,
    ) -> AppResult<()> {
        // 会话不存在时立即报错，避免前端开了面板却一直空白。
        ssh.handle(session).await?;
        self.stop(session).await;

        let manager = self.clone();
        let id = self.seq.fetch_add(1, Ordering::Relaxed) + 1;
        let handle = tokio::spawn(async move {
            let mut state = SampleState::default();
            loop {
                match sample(&ssh, session, &mut state).await {
                    Ok(metrics) => {
                        if on_event.send(MonitorEvent::Metrics { metrics }).is_err() {
                            break;
                        }
                    }
                    Err(err) => {
                        let _ = on_event.send(MonitorEvent::Error {
                            code: err.code,
                            message: err.message,
                        });
                        break;
                    }
                }
                tokio::time::sleep(SAMPLE_INTERVAL).await;
            }
            // 只清理自己，避免覆盖重新启动的新任务。
            let mut tasks = manager.tasks.lock().await;
            if tasks.get(&session).map(|task| task.id) == Some(id) {
                tasks.remove(&session);
            }
        });
        self.tasks
            .lock()
            .await
            .insert(session, MonitorTask { id, handle });
        Ok(())
    }

    pub async fn stop(&self, session: SessionId) {
        if let Some(task) = self.tasks.lock().await.remove(&session) {
            task.handle.abort();
        }
    }
}

async fn sample(
    ssh: &SshManager,
    session: SessionId,
    state: &mut SampleState,
) -> AppResult<HostMetrics> {
    let out = ssh.exec_capture(session, SAMPLE_COMMAND).await?;
    if out.stdout.contains("__FANSSH_NO_PROC__") {
        return Err(AppError::new(
            "monitor.unsupported",
            "远端缺少 /proc，当前仅支持 Linux 服务器监控",
        ));
    }
    if out.stdout.trim().is_empty() {
        let detail = out.stderr.trim();
        return Err(AppError::new(
            "monitor.sample_failed",
            if detail.is_empty() {
                "监控采样没有返回数据".to_string()
            } else {
                format!("监控采样失败：{detail}")
            },
        ));
    }

    let sections = split_sections(&out.stdout);
    let stat_lines: &[&str] = sections.get("stat").map(Vec::as_slice).unwrap_or(&[]);
    let cur_cpu = stat_lines
        .iter()
        .find_map(|line| {
            let name = line.split_whitespace().next()?;
            (name == "cpu").then(|| parse_cpu(line)).flatten()
        })
        .ok_or_else(|| AppError::new("monitor.parse_failed", "无法解析 /proc/stat"))?;

    let usage_total = cpu_usage(state.prev_cpu, cur_cpu);
    state.prev_cpu = Some(cur_cpu);

    let cur_cores: Vec<(u64, u64)> = stat_lines
        .iter()
        .filter(|line| {
            let name = line.split_whitespace().next().unwrap_or("");
            name.len() > 3 && name[3..].chars().all(|c| c.is_ascii_digit())
        })
        .filter_map(|line| parse_cpu(line))
        .collect();
    let same_cores = state.prev_cores.len() == cur_cores.len();
    let cores = cur_cores
        .iter()
        .enumerate()
        .map(|(index, current)| {
            let prev = if same_cores {
                state.prev_cores.get(index).copied()
            } else {
                None
            };
            cpu_usage(prev, *current)
        })
        .collect();
    state.prev_cores = cur_cores;

    let (load1, load5, load15) = parse_load(sections.get("load").map(Vec::as_slice).unwrap_or(&[]));
    let uptime = sections
        .get("uptime")
        .and_then(|lines| lines.first())
        .and_then(|line| line.split_whitespace().next())
        .and_then(|value| value.parse::<f64>().ok())
        .unwrap_or(0.0)
        .max(0.0) as u64;

    let mem = parse_mem(sections.get("mem").map(Vec::as_slice).unwrap_or(&[]));
    let disks = parse_disks(sections.get("df").map(Vec::as_slice).unwrap_or(&[]));

    let (rx, tx) = parse_net(sections.get("net").map(Vec::as_slice).unwrap_or(&[]));
    let now = Instant::now();
    let (rx_bps, tx_bps) = match state.prev_net {
        Some((prev_rx, prev_tx, at)) => {
            let secs = now.duration_since(at).as_secs_f64().max(0.001);
            (
                rx.saturating_sub(prev_rx) as f64 / secs,
                tx.saturating_sub(prev_tx) as f64 / secs,
            )
        }
        None => (0.0, 0.0),
    };
    state.prev_net = Some((rx, tx, now));

    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as u64)
        .unwrap_or(0);

    Ok(HostMetrics {
        ts,
        uptime,
        load1,
        load5,
        load15,
        cpu: CpuMetrics {
            usage: usage_total,
            cores,
        },
        mem,
        disks,
        net: NetMetrics { rx_bps, tx_bps },
        platform: "linux".to_string(),
    })
}

/// 按 `##section` 标记切分输出。
fn split_sections(raw: &str) -> HashMap<&str, Vec<&str>> {
    let mut map: HashMap<&str, Vec<&str>> = HashMap::new();
    let mut current: Option<&str> = None;
    for line in raw.lines() {
        if let Some(name) = line.strip_prefix("##") {
            let name = name.trim();
            current = Some(name);
            map.entry(name).or_default();
        } else if let Some(name) = current {
            if !line.trim().is_empty() {
                map.entry(name).or_default().push(line);
            }
        }
    }
    map
}

/// 返回（idle+iowait, total）累计值。
fn parse_cpu(line: &str) -> Option<(u64, u64)> {
    let mut parts = line.split_whitespace();
    let name = parts.next()?;
    if !name.starts_with("cpu") {
        return None;
    }
    let nums: Vec<u64> = parts.filter_map(|part| part.parse().ok()).take(8).collect();
    if nums.len() < 4 {
        return None;
    }
    let idle = nums[3] + nums.get(4).copied().unwrap_or(0);
    Some((idle, nums.iter().sum()))
}

fn cpu_usage(prev: Option<(u64, u64)>, current: (u64, u64)) -> f64 {
    // 首帧按开机以来的平均值给出，后续用两次采样的差值。
    let (prev_idle, prev_total) = prev.unwrap_or((0, 0));
    let idle_delta = current.0.saturating_sub(prev_idle);
    let total_delta = current.1.saturating_sub(prev_total);
    if total_delta == 0 {
        return 0.0;
    }
    1.0 - (idle_delta as f64 / total_delta as f64).clamp(0.0, 1.0)
}

fn parse_load(lines: &[&str]) -> (f64, f64, f64) {
    let Some(line) = lines.first() else {
        return (0.0, 0.0, 0.0);
    };
    let mut values = line
        .split_whitespace()
        .filter_map(|part| part.parse::<f64>().ok());
    (
        values.next().unwrap_or(0.0),
        values.next().unwrap_or(0.0),
        values.next().unwrap_or(0.0),
    )
}

fn parse_mem(lines: &[&str]) -> MemMetrics {
    let mut values: HashMap<&str, u64> = HashMap::new();
    for line in lines {
        if let Some((key, value)) = line.split_once(':') {
            let kb = value
                .split_whitespace()
                .next()
                .and_then(|part| part.parse::<u64>().ok())
                .unwrap_or(0);
            values.insert(key.trim(), kb);
        }
    }
    let kb = |key: &str| values.get(key).copied().unwrap_or(0) * 1024;
    let total = kb("MemTotal");
    let free = kb("MemFree");
    let buffers = kb("Buffers");
    let cached = kb("Cached") + kb("SReclaimable");
    let available = kb("MemAvailable");
    let shmem = kb("Shmem");
    // 优先用 MemAvailable；老内核没有该字段时按 free 的计算方式回退。
    let used = if available > 0 {
        total.saturating_sub(available)
    } else {
        total
            .saturating_sub(free + buffers + cached)
            .saturating_add(shmem)
    };
    MemMetrics {
        total,
        used: used.min(total),
        cached,
        free,
    }
}

const VIRTUAL_IFACE_PREFIXES: &[&str] = &[
    "lo",
    "veth",
    "docker",
    "br-",
    "virbr",
    "tun",
    "tap",
    "utun",
    "cni",
    "flannel",
    "kube",
    "cali",
    "nodelocaldns",
    "dummy",
];

fn is_virtual_iface(name: &str) -> bool {
    VIRTUAL_IFACE_PREFIXES
        .iter()
        .any(|prefix| name.starts_with(prefix))
}

/// 返回（累计接收字节，累计发送字节）。优先只统计物理网卡，避免容器网桥翻倍。
fn parse_net(lines: &[&str]) -> (u64, u64) {
    let mut real = (0u64, 0u64);
    let mut all = (0u64, 0u64);
    for line in lines {
        let Some((name, rest)) = line.split_once(':') else {
            continue;
        };
        let name = name.trim();
        if name == "lo" {
            continue;
        }
        let nums: Vec<u64> = rest
            .split_whitespace()
            .take(9)
            .filter_map(|part| part.parse::<u64>().ok())
            .collect();
        if nums.len() < 9 {
            continue;
        }
        all.0 += nums[0];
        all.1 += nums[8];
        if !is_virtual_iface(name) {
            real.0 += nums[0];
            real.1 += nums[8];
        }
    }
    if real == (0, 0) {
        all
    } else {
        real
    }
}

const PSEUDO_FS: &[&str] = &[
    "tmpfs",
    "devtmpfs",
    "udev",
    "none",
    "overlay",
    "overlay2",
    "squashfs",
    "proc",
    "sysfs",
    "cgroup",
    "cgroup2",
    "devpts",
    "mqueue",
    "nsfs",
    "debugfs",
    "securityfs",
    "pstore",
    "bpf",
    "tracefs",
    "configfs",
    "fusectl",
    "hugetlbfs",
    "autofs",
    "ramfs",
    "efivarfs",
    "binfmt_misc",
    "shm",
];

fn is_pseudo_fs(fs: &str, mount: &str) -> bool {
    PSEUDO_FS.contains(&fs)
        || fs.starts_with("proc")
        || fs.starts_with("sys")
        || mount.starts_with("/snap")
        || mount.starts_with("/var/lib/docker")
        || mount.starts_with("/var/lib/kubelet")
        || mount.starts_with("/run/")
}

fn parse_disks(lines: &[&str]) -> Vec<DiskMetrics> {
    let mut disks = Vec::new();
    // 跳过 df 表头。
    for line in lines.iter().skip(1) {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 6 {
            continue;
        }
        let (Ok(total_kb), Ok(used_kb)) = (parts[1].parse::<u64>(), parts[2].parse::<u64>()) else {
            continue;
        };
        let mount = parts[5..].join(" ");
        if is_pseudo_fs(parts[0], &mount) {
            continue;
        }
        disks.push(DiskMetrics {
            mount,
            total: total_kb.saturating_mul(1024),
            used: used_kb.saturating_mul(1024),
        });
    }
    disks.sort_by(|a, b| match (a.mount.as_str(), b.mount.as_str()) {
        ("/", "/") => std::cmp::Ordering::Equal,
        ("/", _) => std::cmp::Ordering::Less,
        (_, "/") => std::cmp::Ordering::Greater,
        _ => a.mount.cmp(&b.mount),
    });
    disks.dedup_by(|a, b| a.mount == b.mount);
    disks
}
