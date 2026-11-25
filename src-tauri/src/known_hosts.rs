use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::util::{now_unix, write_atomic};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct KnownHostEntry {
    pub host: String,
    pub port: u16,
    pub algorithm: String,
    pub fingerprint: String,
    pub first_seen: i64,
    pub last_seen: i64,
}

#[derive(Serialize, Deserialize)]
struct KnownHostsFile {
    #[serde(default = "default_version")]
    version: u32,
    #[serde(default)]
    hosts: Vec<KnownHostEntry>,
}

fn default_version() -> u32 {
    1
}

/// Local trust-on-first-use SSH host key store.
pub struct KnownHosts {
    path: PathBuf,
    entries: Mutex<HashMap<String, KnownHostEntry>>,
}

impl KnownHosts {
    pub fn open(dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(dir).context("创建数据目录失败")?;
        let path = dir.join("known_hosts.json");
        let entries = if path.exists() {
            let bytes = std::fs::read(&path).context("读取 known_hosts.json 失败")?;
            let file: KnownHostsFile =
                serde_json::from_slice(&bytes).context("解析 known_hosts.json 失败")?;
            file.hosts
                .into_iter()
                .map(|entry| (host_key(&entry.host, entry.port), entry))
                .collect()
        } else {
            HashMap::new()
        };
        Ok(Self {
            path,
            entries: Mutex::new(entries),
        })
    }

    pub fn list(&self) -> Vec<KnownHostEntry> {
        let entries = self.entries.lock().unwrap();
        let mut hosts: Vec<_> = entries.values().cloned().collect();
        sort_hosts(&mut hosts);
        hosts
    }

    pub fn delete(&self, host: &str, port: u16) -> Result<bool> {
        let host = host.trim().to_ascii_lowercase();
        let key = host_key(&host, port);
        let mut entries = self.entries.lock().unwrap();
        let removed = entries.remove(&key).is_some();
        if removed {
            self.persist(&entries)?;
        }
        Ok(removed)
    }

    pub fn verify(
        &self,
        host: &str,
        port: u16,
        algorithm: &str,
        fingerprint: &str,
        save_unknown: bool,
    ) -> Result<bool> {
        let host = host.trim().to_ascii_lowercase();
        let key = host_key(&host, port);
        let now = now_unix();
        let mut entries = self.entries.lock().unwrap();
        if let Some(entry) = entries.get(&key) {
            if entry.algorithm != algorithm || entry.fingerprint != fingerprint {
                bail!(
                    "SSH 主机密钥已变化：{}:{}\n已记录：{} {}\n本次收到：{} {}\n已拒绝连接。确认服务器换密钥后，可在安全设置删除旧记录。",
                    host, port, entry.algorithm, entry.fingerprint, algorithm, fingerprint
                );
            }
        } else if !save_unknown {
            return Ok(false);
        }

        let mut updated = entries.clone();
        updated
            .entry(key)
            .and_modify(|entry| entry.last_seen = now)
            .or_insert_with(|| KnownHostEntry {
                host,
                port,
                algorithm: algorithm.to_owned(),
                fingerprint: fingerprint.to_owned(),
                first_seen: now,
                last_seen: now,
            });
        self.persist(&updated)?;
        *entries = updated;
        Ok(true)
    }

    fn persist(&self, entries: &HashMap<String, KnownHostEntry>) -> Result<()> {
        let mut hosts: Vec<_> = entries.values().cloned().collect();
        sort_hosts(&mut hosts);
        let file = KnownHostsFile { version: 1, hosts };
        let bytes = serde_json::to_vec_pretty(&file).context("序列化 known_hosts.json 失败")?;
        write_atomic(&self.path, &bytes).context("写入 known_hosts.json 失败")
    }
}

fn host_key(host: &str, port: u16) -> String {
    format!("{}:{}", host.trim().to_ascii_lowercase(), port)
}

fn sort_hosts(hosts: &mut [KnownHostEntry]) {
    hosts.sort_by(|left, right| left.host.cmp(&right.host).then(left.port.cmp(&right.port)));
}

#[cfg(test)]
mod tests {
    use super::KnownHosts;

    #[test]
    fn unknown_keys_require_explicit_save_and_changed_keys_are_rejected() {
        let dir =
            std::env::temp_dir().join(format!("fanssh-host-key-test-{}", uuid::Uuid::new_v4()));
        let store = KnownHosts::open(&dir).unwrap();
        assert!(!store
            .verify("example.test", 22, "ssh-ed25519", "original", false)
            .unwrap());
        assert!(store.list().is_empty());
        assert!(store
            .verify("example.test", 22, "ssh-ed25519", "original", true)
            .unwrap());

        let persisted = KnownHosts::open(&dir).unwrap();
        assert!(persisted
            .verify("EXAMPLE.TEST", 22, "ssh-ed25519", "original", false)
            .unwrap());
        assert!(persisted
            .verify("example.test", 22, "ssh-ed25519", "changed", true)
            .is_err());
        assert_eq!(persisted.list()[0].fingerprint, "original");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
