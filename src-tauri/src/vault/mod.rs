use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use anyhow::{anyhow, bail, Context, Result};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::crypto;
use crate::session::model::SecretKind;
use crate::util::{now_unix, write_atomic};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SecretRef {
    pub id: Uuid,
    pub kind: SecretKind,
    pub label: String,
    pub updated_at: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct VaultItem {
    kind: SecretKind,
    label: String,
    nonce: String,
    ciphertext: String,
    updated_at: i64,
}

#[derive(Serialize, Deserialize)]
struct VaultFile {
    #[serde(default = "default_version")]
    version: u32,
    wrapped_key: String,
    #[serde(default)]
    items: HashMap<Uuid, VaultItem>,
}

fn default_version() -> u32 {
    1
}

struct Inner {
    file: VaultFile,
    key: Option<[u8; 32]>,
    load_error: Option<String>,
}

/// 凭据库：主密钥由 DPAPI 保护（Windows）或本地密钥包装（开发环境），
/// 每个凭据条目再用 AES-256-GCM 单独加密，AAD 绑定条目 id 与类型，防止密文被挪用。
pub struct Vault {
    path: PathBuf,
    inner: Mutex<Inner>,
}

impl Vault {
    pub fn open(dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(dir).context("创建数据目录失败")?;
        let path = dir.join("vault.json");
        let mut file: VaultFile = if path.exists() {
            let bytes = std::fs::read(&path).context("读取 vault.json 失败")?;
            serde_json::from_slice(&bytes).context("解析 vault.json 失败")?
        } else {
            VaultFile {
                version: 1,
                wrapped_key: String::new(),
                items: HashMap::new(),
            }
        };

        let (key, load_error, needs_persist) = if file.wrapped_key.trim().is_empty() {
            let mut key = [0u8; 32];
            rand::rng().fill_bytes(&mut key);
            file.wrapped_key = crypto::encrypt_secret(&STANDARD.encode(key), dir)
                .context("创建凭据库主密钥失败")?;
            // 新建库，或已有文件但缺少 wrapped_key：都需要立即把主密钥落盘，
            // 否则重启后无法解开本次写入的凭据。
            (Some(key), None, true)
        } else {
            match crypto::decrypt_secret(&file.wrapped_key, dir) {
                Ok(encoded) => match STANDARD
                    .decode(encoded.trim())
                    .ok()
                    .and_then(|raw| <[u8; 32]>::try_from(raw.as_slice()).ok())
                {
                    Some(key) => (Some(key), None, false),
                    None => (None, Some("凭据库主密钥格式异常".to_string()), false),
                },
                Err(e) => (None, Some(format!("凭据库主密钥无法解密: {e}")), false),
            }
        };

        let vault = Self {
            path,
            inner: Mutex::new(Inner {
                file,
                key,
                load_error,
            }),
        };

        if needs_persist {
            let inner = vault.inner.lock().unwrap();
            vault.persist(&inner)?;
        }
        Ok(vault)
    }

    pub fn put(
        &self,
        id: Option<Uuid>,
        kind: SecretKind,
        label: &str,
        plaintext: &str,
    ) -> Result<Uuid> {
        let mut inner = self.inner.lock().unwrap();
        let key = Self::key(&inner)?;
        let id = id.unwrap_or_else(Uuid::new_v4);
        let cipher = Aes256Gcm::new_from_slice(&key).expect("32 字节密钥");
        let mut nonce = [0u8; 12];
        rand::rng().fill_bytes(&mut nonce);
        let aad = aad_for(&id, kind);
        let ciphertext = cipher
            .encrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: plaintext.as_bytes(),
                    aad: &aad,
                },
            )
            .map_err(|_| anyhow!("凭据加密失败"))?;

        inner.file.items.insert(
            id,
            VaultItem {
                kind,
                label: label.to_string(),
                nonce: STANDARD.encode(nonce),
                ciphertext: STANDARD.encode(ciphertext),
                updated_at: now_unix(),
            },
        );
        self.persist(&inner)?;
        Ok(id)
    }

    pub fn get(&self, id: &Uuid) -> Result<Zeroizing<String>> {
        let inner = self.inner.lock().unwrap();
        let key = Self::key(&inner)?;
        let item = inner
            .file
            .items
            .get(id)
            .ok_or_else(|| anyhow!("凭据不存在或已被删除（{id}）"))?;
        let nonce = STANDARD.decode(&item.nonce).context("凭据 nonce 解码失败")?;
        let data = STANDARD
            .decode(&item.ciphertext)
            .context("凭据密文解码失败")?;
        let cipher = Aes256Gcm::new_from_slice(&key).expect("32 字节密钥");
        let aad = aad_for(id, item.kind);
        let plain = cipher
            .decrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: data.as_ref(),
                    aad: &aad,
                },
            )
            .map_err(|_| anyhow!("凭据解密失败（可能来自其他机器或已损坏）"))?;
        let text = String::from_utf8(plain).context("凭据不是合法 UTF-8")?;
        Ok(Zeroizing::new(text))
    }

    pub fn delete(&self, id: &Uuid) -> Result<()> {
        let mut inner = self.inner.lock().unwrap();
        if inner.file.items.remove(id).is_some() {
            self.persist(&inner)?;
        }
        Ok(())
    }

    pub fn list(&self) -> Vec<SecretRef> {
        let inner = self.inner.lock().unwrap();
        let mut items: Vec<SecretRef> = inner
            .file
            .items
            .iter()
            .map(|(id, item)| SecretRef {
                id: *id,
                kind: item.kind,
                label: item.label.clone(),
                updated_at: item.updated_at,
            })
            .collect();
        items.sort_by_key(|i| std::cmp::Reverse(i.updated_at));
        items
    }

    pub fn contains(&self, id: &Uuid) -> bool {
        self.inner.lock().unwrap().file.items.contains_key(id)
    }

    fn key(inner: &Inner) -> Result<[u8; 32]> {
        inner.key.ok_or_else(|| {
            anyhow!(
                "凭据库不可用：{}",
                inner
                    .load_error
                    .clone()
                    .unwrap_or_else(|| "主密钥缺失".to_string())
            )
        })
    }

    fn persist(&self, inner: &Inner) -> Result<()> {
        let bytes = serde_json::to_vec_pretty(&inner.file)?;
        write_atomic(&self.path, &bytes)
    }
}

fn aad_for(id: &Uuid, kind: SecretKind) -> Vec<u8> {
    let mut aad = Vec::with_capacity(48);
    aad.extend_from_slice(id.as_bytes());
    aad.push(b':');
    aad.extend_from_slice(kind.as_str().as_bytes());
    aad
}

/// 仅保证编译期类型存在，避免未使用告警影响 lint
#[allow(dead_code)]
fn _assert_send_sync(v: &Vault) {
    fn is_send_sync<T: Send + Sync>(_: &T) {}
    is_send_sync(v);
}
