use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use anyhow::{anyhow, bail, Context, Result};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::session::model::{AuthRef, Profile, SecretKind};
use crate::util::{now_unix, write_atomic};
use crate::vault::Vault;

#[derive(Serialize, Deserialize)]
struct ProfilesFile {
    #[serde(default = "default_version")]
    version: u32,
    #[serde(default)]
    profiles: Vec<Profile>,
}

fn default_version() -> u32 {
    1
}

/// 导出载荷。加密后整体写入 `.fansshx`，不会留下任何明文凭据。
#[derive(Serialize, Deserialize)]
struct ExportEnvelope {
    version: u32,
    exported_at: i64,
    profiles: Vec<Profile>,
    #[serde(default)]
    secrets: Vec<ExportedSecret>,
}

#[derive(Serialize, Deserialize)]
struct ExportedSecret {
    id: Uuid,
    kind: SecretKind,
    label: String,
    plaintext: String,
}

const BUNDLE_MAGIC: &[u8; 8] = b"FANSSHX1";
/// Argon2id 参数：64 MiB 内存、3 轮、1 路并行，输出 32 字节。
const KDF_M_KIB: u32 = 65536;
const KDF_T: u32 = 3;
const KDF_P: u32 = 1;

/// 加密文件头，明文保存以便导入方按参数派生密钥。
#[derive(Serialize, Deserialize)]
struct BundleHeader {
    version: u32,
    kdf: String,
    m_kib: u32,
    t: u32,
    p: u32,
    salt: String,
    nonce: String,
}

#[derive(Debug, thiserror::Error)]
pub enum BundleError {
    #[error("口令错误或文件已损坏")]
    BadPassphrase,
    #[error("{0}")]
    Corrupt(String),
}

#[derive(Debug, thiserror::Error)]
pub enum ImportError {
    #[error("该文件已加密，需要输入口令")]
    PassphraseRequired,
    #[error("口令错误或文件已损坏")]
    BadPassphrase,
    #[error("{0:#}")]
    Failed(#[from] anyhow::Error),
}

fn derive_key(
    passphrase: &str,
    salt: &[u8],
    m_kib: u32,
    t: u32,
    p: u32,
) -> Result<Zeroizing<[u8; 32]>> {
    let params = Params::new(m_kib, t, p, Some(32)).map_err(|e| anyhow!("KDF 参数无效：{e}"))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut key = Zeroizing::new([0u8; 32]);
    argon
        .hash_password_into(passphrase.as_bytes(), salt, key.as_mut())
        .map_err(|e| anyhow!("密钥派生失败：{e}"))?;
    Ok(key)
}

/// 导出文件格式：`FANSSHX1` + 4 字节头部长度 + 头部 JSON + AES-256-GCM 密文。
/// 头部作为 AAD，篡改 KDF 参数会导致解密失败。
fn encrypt_bundle(plaintext: &[u8], passphrase: &str) -> Result<Vec<u8>> {
    let mut salt = [0u8; 16];
    let mut nonce = [0u8; 12];
    rand::rng().fill_bytes(&mut salt);
    rand::rng().fill_bytes(&mut nonce);
    let key = derive_key(passphrase, &salt, KDF_M_KIB, KDF_T, KDF_P)?;
    let header = BundleHeader {
        version: 2,
        kdf: "argon2id".to_string(),
        m_kib: KDF_M_KIB,
        t: KDF_T,
        p: KDF_P,
        salt: STANDARD.encode(salt),
        nonce: STANDARD.encode(nonce),
    };
    let header_bytes = serde_json::to_vec(&header)?;
    let cipher = Aes256Gcm::new_from_slice(key.as_ref()).expect("32 字节密钥");
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad: &header_bytes,
            },
        )
        .map_err(|_| anyhow!("导出加密失败"))?;
    let mut out = Vec::with_capacity(8 + 4 + header_bytes.len() + ciphertext.len());
    out.extend_from_slice(BUNDLE_MAGIC);
    out.extend_from_slice(&(header_bytes.len() as u32).to_le_bytes());
    out.extend_from_slice(&header_bytes);
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

fn decrypt_bundle(bytes: &[u8], passphrase: &str) -> std::result::Result<Zeroizing<Vec<u8>>, BundleError> {
    if bytes.len() < 12 {
        return Err(BundleError::Corrupt("文件过短，不是有效的 FanSSH 加密配置".into()));
    }
    if &bytes[..8] != &BUNDLE_MAGIC[..] {
        return Err(BundleError::Corrupt("文件头不正确".into()));
    }
    let header_len = u32::from_le_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]) as usize;
    let header_end = 12 + header_len;
    if bytes.len() <= header_end {
        return Err(BundleError::Corrupt("文件头部不完整".into()));
    }
    let header_bytes = &bytes[12..header_end];
    let header: BundleHeader = serde_json::from_slice(header_bytes)
        .map_err(|e| BundleError::Corrupt(format!("文件头解析失败：{e}")))?;
    if header.kdf != "argon2id" {
        return Err(BundleError::Corrupt(format!("不支持的 KDF：{}", header.kdf)));
    }
    let salt = STANDARD
        .decode(&header.salt)
        .map_err(|e| BundleError::Corrupt(format!("salt 解码失败：{e}")))?;
    let nonce = STANDARD
        .decode(&header.nonce)
        .map_err(|e| BundleError::Corrupt(format!("nonce 解码失败：{e}")))?;
    let key = derive_key(passphrase, &salt, header.m_kib, header.t, header.p)
        .map_err(|e| BundleError::Corrupt(format!("{e:#}")))?;
    let cipher = Aes256Gcm::new_from_slice(key.as_ref()).expect("32 字节密钥");
    let plaintext = cipher
        .decrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &bytes[header_end..],
                aad: header_bytes,
            },
        )
        .map_err(|_| BundleError::BadPassphrase)?;
    Ok(Zeroizing::new(plaintext))
}

/// 服务器配置存储。只保存配置和凭据引用，绝不保存明文凭据。
pub struct ProfileStore {
    path: PathBuf,
    profiles: Mutex<Vec<Profile>>,
}

impl ProfileStore {
    pub fn open(dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(dir).context("创建数据目录失败")?;
        let path = dir.join("profiles.json");
        let profiles = if path.exists() {
            let bytes = std::fs::read(&path).context("读取 profiles.json 失败")?;
            let file: ProfilesFile =
                serde_json::from_slice(&bytes).context("解析 profiles.json 失败")?;
            file.profiles
        } else {
            vec![]
        };
        Ok(Self {
            path,
            profiles: Mutex::new(profiles),
        })
    }

    pub fn list(&self) -> Vec<Profile> {
        self.profiles.lock().unwrap().clone()
    }

    pub fn get(&self, id: &Uuid) -> Option<Profile> {
        self.profiles
            .lock()
            .unwrap()
            .iter()
            .find(|p| p.id == *id)
            .cloned()
    }

    pub fn upsert(&self, mut profile: Profile) -> Result<Profile> {
        if profile.id.is_nil() {
            profile.id = Uuid::new_v4();
        }
        validate(&profile)?;
        let mut profiles = self.profiles.lock().unwrap();
        if let Some(existing) = profiles.iter_mut().find(|p| p.id == profile.id) {
            *existing = profile.clone();
        } else {
            profiles.push(profile.clone());
        }
        self.persist(&profiles)?;
        Ok(profile)
    }

    pub fn delete(&self, id: &Uuid) -> Result<Option<Profile>> {
        let mut profiles = self.profiles.lock().unwrap();
        let index = profiles.iter().position(|p| p.id == *id);
        let removed = index.map(|i| profiles.remove(i));
        if removed.is_some() {
            self.persist(&profiles)?;
        }
        Ok(removed)
    }

    /// 导出为口令加密的配置包，凭据随配置一起加密，不再产生明文 JSON。
    pub fn export(&self, path: &Path, passphrase: &str, vault: &Vault) -> Result<usize> {
        if passphrase.trim().len() < 8 {
            bail!("导出口令至少 8 位");
        }
        let profiles = self.profiles.lock().unwrap().clone();
        let mut secrets = Vec::new();
        let mut seen = HashSet::new();
        for profile in &profiles {
            for id in profile.secret_ids() {
                if !seen.insert(id) {
                    continue;
                }
                let Ok(plaintext) = vault.get(&id) else {
                    // 凭据已被删除时跳过，避免导出失败
                    continue;
                };
                let meta = vault.list().into_iter().find(|item| item.id == id);
                secrets.push(ExportedSecret {
                    id,
                    kind: meta.as_ref().map(|item| item.kind).unwrap_or(SecretKind::Password),
                    label: meta.as_ref().map(|item| item.label.clone()).unwrap_or_default(),
                    plaintext: plaintext.to_string(),
                });
            }
        }
        let count = profiles.len();
        let envelope = ExportEnvelope {
            version: 2,
            exported_at: now_unix(),
            profiles,
            secrets,
        };
        let payload = serde_json::to_vec(&envelope)?;
        let bytes = encrypt_bundle(&payload, passphrase)?;
        write_atomic(path, &bytes)?;
        Ok(count)
    }

    /// 导入加密配置包或旧版明文 JSON。凭据会重新写入本地 vault 并重映射 id。
    pub fn import(
        &self,
        path: &Path,
        passphrase: Option<&str>,
        vault: &Vault,
    ) -> std::result::Result<usize, ImportError> {
        let bytes = std::fs::read(path)
            .map_err(|e| anyhow::Error::new(e).context("读取导入文件失败"))?;
        let content = if bytes.starts_with(BUNDLE_MAGIC) {
            let passphrase = passphrase.ok_or(ImportError::PassphraseRequired)?;
            decrypt_bundle(&bytes, passphrase)
                .map_err(|err| match err {
                    BundleError::BadPassphrase => ImportError::BadPassphrase,
                    BundleError::Corrupt(message) => {
                        ImportError::Failed(anyhow!("{message}"))
                    }
                })?
                .to_vec()
        } else {
            bytes
        };

        let value: serde_json::Value = serde_json::from_slice(&content)
            .map_err(|e| anyhow::Error::new(e).context("导入文件不是合法 JSON"))?;

        // 加密包里的凭据先写入 vault，得到旧 id → 新 id 的映射
        let mut id_map: HashMap<Uuid, Uuid> = HashMap::new();
        if let Some(items) = value.get("secrets").and_then(|item| item.as_array()) {
            for item in items {
                let secret: ExportedSecret = serde_json::from_value(item.clone())
                    .map_err(|e| anyhow::Error::new(e).context("加密包中的凭据格式不正确"))?;
                let new_id = vault
                    .put(None, secret.kind, &secret.label, &secret.plaintext)
                    .context("把导入的凭据写入本地凭据库失败")?;
                id_map.insert(secret.id, new_id);
            }
        }

        let raw = if value.is_array() {
            value.clone()
        } else {
            value
                .get("profiles")
                .cloned()
                .ok_or_else(|| anyhow!("导入文件缺少 profiles 字段"))?
        };
        let mut incoming: Vec<Profile> = Vec::new();
        for item in raw.as_array().cloned().unwrap_or_default() {
            let (mut profile_value, legacy) = extract_legacy_secrets(item, vault)?;
            if let Some(auth) = legacy {
                // 旧版明文凭据已转入 vault，替换掉原有引用
                if let Some(object) = profile_value.as_object_mut() {
                    object.insert(
                        "auth".to_string(),
                        serde_json::to_value(auth).unwrap_or(serde_json::Value::Null),
                    );
                }
            }
            let profile: Profile = serde_json::from_value(profile_value)
                .map_err(|e| anyhow::Error::new(e).context("导入文件中的服务器配置格式不正确"))?;
            incoming.push(profile);
        }

        let mut profiles = self.profiles.lock().unwrap();
        let mut existing_ids: HashSet<Uuid> = profiles.iter().map(|p| p.id).collect();
        let mut count = 0usize;
        for profile in incoming.iter_mut() {
            if profile.id.is_nil() || existing_ids.contains(&profile.id) {
                profile.id = Uuid::new_v4();
            }
            existing_ids.insert(profile.id);
            remap_auth(&mut profile.auth, &id_map, vault);
            for hop in profile.jump.iter_mut() {
                remap_auth(&mut hop.auth, &id_map, vault);
            }
            if validate(profile).is_ok() {
                profiles.push(profile.clone());
                count += 1;
            }
        }
        self.persist(&profiles)?;
        Ok(count)
    }

    fn persist(&self, profiles: &[Profile]) -> Result<()> {
        let file = ProfilesFile {
            version: 1,
            profiles: profiles.to_vec(),
        };
        let bytes = serde_json::to_vec_pretty(&file)?;
        write_atomic(&self.path, &bytes)
    }
}

/// 旧版明文配置可能把密码/私钥直接写在 JSON 里，导入时转入 vault 并返回新引用。
fn extract_legacy_secrets(
    mut item: serde_json::Value,
    vault: &Vault,
) -> Result<(serde_json::Value, Option<AuthRef>)> {
    let Some(object) = item.as_object_mut() else {
        return Ok((item, None));
    };
    let label = object
        .get("name")
        .and_then(|value| value.as_str())
        .unwrap_or("导入配置")
        .to_string();

    let mut password: Option<String> = None;
    let mut private_key: Option<String> = None;
    let mut passphrase: Option<String> = None;
    for key in ["password", "private_key", "privateKey", "passphrase"] {
        let text = object.get(key).and_then(|value| value.as_str()).map(str::to_string);
        if text.is_some() {
            match key {
                "password" => password = text,
                "passphrase" => passphrase = text,
                _ => private_key = text,
            }
        }
        object.remove(key);
    }
    if let Some(auth) = object.get_mut("auth").and_then(|value| value.as_object_mut()) {
        for key in ["password", "private_key", "passphrase"] {
            let text = auth.get(key).and_then(|value| value.as_str()).map(str::to_string);
            if text.is_some() {
                match key {
                    "password" => password = text,
                    "passphrase" => passphrase = text,
                    _ => private_key = text,
                }
            }
            auth.remove(key);
        }
        // 更早的格式把明文密码放在 auth.secret 里，而不是 UUID
        if auth.get("kind").and_then(|value| value.as_str()) == Some("password") {
            if let Some(secret) = auth.get("secret").and_then(|value| value.as_str()) {
                if Uuid::parse_str(secret).is_err() && !secret.trim().is_empty() {
                    password = Some(secret.to_string());
                }
            }
        }
    }

    let auth = if let Some(key_text) = private_key.filter(|text| !text.trim().is_empty()) {
        let key_id = vault.put(None, SecretKind::PrivateKey, &format!("{label} 私钥"), &key_text)?;
        let pass_id = match passphrase.filter(|text| !text.trim().is_empty()) {
            Some(text) => Some(vault.put(
                None,
                SecretKind::Passphrase,
                &format!("{label} 私钥口令"),
                &text,
            )?),
            None => None,
        };
        Some(AuthRef::Key {
            key: key_id,
            passphrase: pass_id,
        })
    } else if let Some(text) = password.filter(|text| !text.trim().is_empty()) {
        Some(AuthRef::Password {
            secret: vault.put(None, SecretKind::Password, &format!("{label} 密码"), &text)?,
        })
    } else {
        None
    };

    Ok((item, auth))
}

/// 导入后把凭据引用指向本地 vault：优先用 id 映射，其次保留本机已存在的 id。
fn remap_auth(auth: &mut AuthRef, map: &HashMap<Uuid, Uuid>, vault: &Vault) {
    let next = match auth {
        AuthRef::Password { secret } => match map.get(secret) {
            Some(new_id) => AuthRef::Password { secret: *new_id },
            None if vault.contains(secret) => AuthRef::Password { secret: *secret },
            None => AuthRef::None,
        },
        AuthRef::Key { key, passphrase } => {
            let new_key = map.get(key).copied().or_else(|| vault.contains(key).then_some(*key));
            match new_key {
                Some(new_key) => AuthRef::Key {
                    key: new_key,
                    passphrase: passphrase.and_then(|id| {
                        map.get(&id).copied().or_else(|| vault.contains(&id).then_some(id))
                    }),
                },
                None => AuthRef::None,
            }
        }
        AuthRef::None => AuthRef::None,
    };
    *auth = next;
}

fn validate(profile: &Profile) -> Result<()> {
    use crate::session::model::Protocol;

    if profile.name.trim().is_empty() {
        bail!("名称不能为空");
    }
    if profile.protocol != Protocol::Serial {
        if profile.target.host.trim().is_empty() {
            bail!("主机地址不能为空");
        }
        if profile.target.port == 0 {
            bail!("端口必须在 1-65535 之间");
        }
    }
    match profile.protocol {
        Protocol::Ssh => {
            if profile.target.user.trim().is_empty() {
                bail!("SSH 用户名不能为空");
            }
        }
        Protocol::Rdp => {}
        Protocol::Serial => {
            let prefs = profile.serial_prefs();
            if prefs.port.trim().is_empty() {
                bail!("串口端口不能为空");
            }
            if prefs.baud_rate == 0 {
                bail!("波特率必须大于 0");
            }
            if !(5..=8).contains(&prefs.data_bits) {
                bail!("数据位只能是 5-8");
            }
            if prefs.stop_bits != 1 && prefs.stop_bits != 2 {
                bail!("停止位只能是 1 或 2");
            }
            if !profile.jump.is_empty() {
                bail!("串口配置不支持跳板机");
            }
        }
    }
    if profile.jump.len() > 1 {
        bail!("当前版本最多支持一层跳板机");
    }
    if let Some(hop) = profile.jump.first() {
        if hop.target.host.trim().is_empty() || hop.target.user.trim().is_empty() {
            bail!("跳板机的主机和用户名不能为空");
        }
    }
    Ok(())
}
