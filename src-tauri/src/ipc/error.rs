use serde::Serialize;

/// 统一 IPC 错误结构，前端按 code 做本地化与恢复动作。
#[derive(Debug, Clone, Serialize)]
pub struct AppError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    pub retryable: bool,
}

pub type AppResult<T> = Result<T, AppError>;

impl AppError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
            detail: None,
            retryable: false,
        }
    }

    pub fn with_detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }

    pub fn retryable(mut self, retryable: bool) -> Self {
        self.retryable = retryable;
        self
    }

    pub fn internal(error: impl std::fmt::Display) -> Self {
        Self {
            code: "internal".to_string(),
            message: error.to_string(),
            detail: None,
            retryable: false,
        }
    }
}

impl From<anyhow::Error> for AppError {
    fn from(error: anyhow::Error) -> Self {
        let text = format!("{error:#}");
        let lower = text.to_lowercase();

        let (code, retryable) = if lower.contains("authentication")
            || lower.contains("认证失败")
            || lower.contains("permission denied (publickey")
        {
            ("ssh.auth_failed", false)
        } else if lower.contains("connection refused") {
            ("ssh.tcp_refused", true)
        } else if lower.contains("failed to lookup")
            || lower.contains("name or service not known")
            || lower.contains("dns")
            || lower.contains("nodename nor servname")
            || lower.contains("no such host")
        {
            ("ssh.dns_failed", false)
        } else if lower.contains("timed out") || lower.contains("超时") || lower.contains("timeout") {
            ("ssh.timeout", true)
        } else if lower.contains("administratively prohibited") {
            ("ssh.jump_forward_denied", false)
        } else if lower.contains("ai 服务认证失败") {
            ("ai.auth_failed", false)
        } else if lower.contains("ai 服务限流") {
            ("ai.rate_limited", true)
        } else if lower.contains("请求 ai 服务失败")
            || lower.contains("请求 ollama 服务失败")
            || lower.contains("ai 服务返回错误")
        {
            ("ai.unavailable", true)
        } else if lower.contains("凭据")
            || lower.contains("decrypt")
            || lower.contains("dpapi")
            || lower.contains("aes-gcm")
        {
            ("vault.decrypt_failed", false)
        } else if lower.contains("sftp") && lower.contains("permission denied") {
            ("sftp.permission_denied", false)
        } else if lower.contains("未找到") {
            ("profile.not_found", false)
        } else {
            ("internal", false)
        };

        Self {
            code: code.to_string(),
            message: text.clone(),
            detail: Some(text),
            retryable,
        }
    }
}
