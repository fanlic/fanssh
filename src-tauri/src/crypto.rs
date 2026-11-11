use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use anyhow::{bail, Context, Result};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use rand::RngCore;
use std::path::Path;

const DPAPI_PREFIX: &str = "dpapi:v1:";
const AES_PREFIX: &str = "aesgcm:v1:";
const KEY_FILE: &str = "secret.key";

/// 加密敏感字符串。
///
/// - Windows：使用 DPAPI（CryptProtectData），密文与当前 Windows 用户绑定，
///   复制到其他机器/其他用户下无法解密。
/// - 其他平台：使用 AES-256-GCM，密钥保存在数据目录的 secret.key（0600），
///   仅用于本地开发调试，不提供 DPAPI 级别的系统级保护。
pub fn encrypt_secret(plain: &str, dir: &Path) -> Result<String> {
    #[cfg(windows)]
    {
        let encrypted = dpapi::protect(plain.as_bytes()).context("DPAPI 加密失败")?;
        Ok(format!("{DPAPI_PREFIX}{}", STANDARD.encode(encrypted)))
    }
    #[cfg(not(windows))]
    {
        let key = load_or_create_key(dir)?;
        let cipher = Aes256Gcm::new_from_slice(&key).expect("32 字节密钥");
        let mut nonce = [0u8; 12];
        rand::rng().fill_bytes(&mut nonce);
        let ciphertext = cipher
            .encrypt(Nonce::from_slice(&nonce), plain.as_bytes())
            .map_err(|_| anyhow::anyhow!("AES-GCM 加密失败"))?;
        Ok(format!(
            "{AES_PREFIX}{}:{}",
            STANDARD.encode(nonce),
            STANDARD.encode(ciphertext)
        ))
    }
}

pub fn decrypt_secret(value: &str, dir: &Path) -> Result<String> {
    if let Some(encoded) = value.strip_prefix(DPAPI_PREFIX) {
        #[cfg(windows)]
        {
            let raw = STANDARD.decode(encoded).context("DPAPI 密文解码失败")?;
            let plain = dpapi::unprotect(&raw).context("DPAPI 解密失败")?;
            return Ok(String::from_utf8(plain).context("凭据不是合法 UTF-8")?);
        }
        #[cfg(not(windows))]
        {
            let _ = encoded;
            bail!("该凭据由 Windows DPAPI 加密，只能在原 Windows 用户下解密");
        }
    }

    if let Some(rest) = value.strip_prefix(AES_PREFIX) {
        let mut parts = rest.splitn(2, ':');
        let nonce_b64 = parts.next().context("AES 密文格式错误")?;
        let data_b64 = parts.next().context("AES 密文格式错误")?;
        let nonce = STANDARD.decode(nonce_b64).context("AES nonce 解码失败")?;
        let data = STANDARD.decode(data_b64).context("AES 密文解码失败")?;
        let key = load_or_create_key(dir)?;
        let cipher = Aes256Gcm::new_from_slice(&key).expect("32 字节密钥");
        let plain = cipher
            .decrypt(Nonce::from_slice(&nonce), data.as_ref())
            .map_err(|_| anyhow::anyhow!("AES-GCM 解密失败（密钥不匹配或数据损坏）"))?;
        return String::from_utf8(plain).context("凭据不是合法 UTF-8");
    }

    bail!("未知的凭据加密格式")
}

#[cfg(not(windows))]
fn load_or_create_key(dir: &Path) -> Result<[u8; 32]> {
    let path = dir.join(KEY_FILE);
    if path.exists() {
        let bytes = std::fs::read(&path).context("读取本地密钥失败")?;
        if bytes.len() != 32 {
            bail!("本地密钥长度异常: {}（应为 32 字节）", bytes.len());
        }
        let mut key = [0u8; 32];
        key.copy_from_slice(&bytes);
        return Ok(key);
    }

    std::fs::create_dir_all(dir).context("创建数据目录失败")?;
    let mut key = [0u8; 32];
    rand::rng().fill_bytes(&mut key);
    std::fs::write(&path, key).context("写入本地密钥失败")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(key)
}

#[cfg(windows)]
mod dpapi {
    use anyhow::{bail, Result};
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    fn last_error() -> std::io::Error {
        std::io::Error::last_os_error()
    }

    pub fn protect(data: &[u8]) -> Result<Vec<u8>> {
        let mut input = CRYPT_INTEGER_BLOB {
            cbData: data.len() as u32,
            pbData: data.as_ptr() as *mut u8,
        };
        let mut output = CRYPT_INTEGER_BLOB::default();
        let ok = unsafe {
            CryptProtectData(
                &mut input,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        };
        if ok == 0 {
            bail!("CryptProtectData 失败: {}", last_error());
        }
        let result = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
        unsafe {
            LocalFree(output.pbData as *mut _);
        }
        Ok(result)
    }

    pub fn unprotect(data: &[u8]) -> Result<Vec<u8>> {
        let mut input = CRYPT_INTEGER_BLOB {
            cbData: data.len() as u32,
            pbData: data.as_ptr() as *mut u8,
        };
        let mut output = CRYPT_INTEGER_BLOB::default();
        let ok = unsafe {
            CryptUnprotectData(
                &mut input,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        };
        if ok == 0 {
            bail!("CryptUnprotectData 失败: {}", last_error());
        }
        let result = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
        unsafe {
            LocalFree(output.pbData as *mut _);
        }
        Ok(result)
    }
}
