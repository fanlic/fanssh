pub mod guard;
pub mod prompt;

use anyhow::{anyhow, bail, Context, Result};
use reqwest::Client;
use serde_json::{json, Value};
use std::time::Duration;

use crate::app::settings::AiSettingsFile;
use crate::ipc::dto::Nl2CmdResult;
use crate::session::model::ChatMessage;

const MAX_OUTPUT_TOKENS: u32 = 2048;

pub async fn chat(
    http: &Client,
    settings: &AiSettingsFile,
    api_key: Option<&str>,
    system: &str,
    messages: Vec<ChatMessage>,
    context: Option<&str>,
) -> Result<String> {
    let mut system = system.to_string();
    if let Some(context) = context.filter(|c| !c.trim().is_empty()) {
        let limit = (settings.max_context_kb.max(1) as usize) * 1024;
        system.push_str("\n\n以下是用户在终端中选中的内容（可能包含敏感信息，仅用于本次分析）：\n```\n");
        system.push_str(&truncate(context, limit));
        system.push_str("\n```");
    }
    complete(http, settings, api_key, &system, messages).await
}

pub async fn complete(
    http: &Client,
    settings: &AiSettingsFile,
    api_key: Option<&str>,
    system: &str,
    messages: Vec<ChatMessage>,
) -> Result<String> {
    if messages.is_empty() {
        bail!("消息不能为空");
    }
    if settings.model.trim().is_empty() {
        bail!("尚未配置模型名称");
    }

    let mut payload_messages: Vec<Value> = Vec::with_capacity(messages.len() + 1);
    payload_messages.push(json!({"role": "system", "content": system}));
    for message in &messages {
        if message.content.trim().is_empty() {
            continue;
        }
        payload_messages.push(json!({
            "role": message.role,
            "content": message.content,
        }));
    }

    match settings.provider.as_str() {
        "ollama" => {
            let url = endpoint(&settings.base_url, "/api/chat");
            let body = json!({
                "model": settings.model,
                "messages": payload_messages,
                "stream": false,
                "options": {
                    "temperature": settings.temperature,
                    "num_predict": MAX_OUTPUT_TOKENS,
                }
            });
            let response = http
                .post(url)
                .timeout(Duration::from_secs(180))
                .json(&body)
                .send()
                .await
                .context("请求 Ollama 服务失败（请确认服务已启动且地址正确）")?;
            let value = json_response(response).await?;
            extract_content(&value, "/message/content")
        }
        _ => {
            let url = endpoint(&settings.base_url, "/chat/completions");
            let body = json!({
                "model": settings.model,
                "messages": payload_messages,
                "temperature": settings.temperature,
                "max_tokens": MAX_OUTPUT_TOKENS,
                "stream": false,
            });
            let mut request = http
                .post(url)
                .timeout(Duration::from_secs(180))
                .json(&body);
            if let Some(key) = api_key.filter(|k| !k.trim().is_empty()) {
                request = request.bearer_auth(key);
            }
            let response = request
                .send()
                .await
                .context("请求 AI 服务失败（请检查 Base URL 和网络）")?;
            let value = json_response(response).await?;
            extract_content(&value, "/choices/0/message/content")
        }
    }
}

pub fn build_nl2cmd_messages(prompt: &str, context: Option<&str>) -> Vec<ChatMessage> {
    let mut content = format!("用户需求：{}\n", prompt.trim());
    if let Some(context) = context.filter(|c| !c.trim().is_empty()) {
        content.push_str("\n当前终端上下文（可能相关，也可能无关）：\n```\n");
        content.push_str(&truncate(context, 16 * 1024));
        content.push_str("\n```\n");
    }
    vec![ChatMessage {
        role: "user".to_string(),
        content,
    }]
}

pub fn parse_nl2cmd(raw: &str) -> Nl2CmdResult {
    let trimmed = raw.trim();
    if let Some(json_text) = extract_json_object(trimmed) {
        if let Ok(mut result) = serde_json::from_str::<Nl2CmdResult>(json_text) {
            finish_guard(&mut result, raw);
            return result;
        }
    }

    let command = extract_code_block(trimmed)
        .or_else(|| {
            trimmed
                .lines()
                .map(str::trim)
                .find(|line| !line.is_empty() && !line.starts_with('{'))
                .map(|line| line.to_string())
        })
        .unwrap_or_default();

    let mut result = Nl2CmdResult {
        command,
        shell: "bash".to_string(),
        explanation: "模型未返回结构化 JSON，已按原文提取命令；请人工确认".to_string(),
        risk: "high".to_string(),
        blocked: true,
        raw: Some(raw.trim().to_string()),
        ..Default::default()
    };
    finish_guard(&mut result, raw);
    result
}

fn finish_guard(result: &mut Nl2CmdResult, raw: &str) {
    if result.shell.trim().is_empty() {
        result.shell = "bash".to_string();
    }
    if result.raw.is_none() {
        result.raw = Some(raw.trim().to_string());
    }
    let (risk, blocked) = guard::assess(&result.command, &result.risk);
    result.risk = risk;
    result.blocked |= blocked;
}

async fn json_response(response: reqwest::Response) -> Result<Value> {
    let status = response.status();
    let text = response.text().await.context("读取 AI 响应失败")?;
    if !status.is_success() {
        let snippet = truncate(text.trim(), 512);
        return match status.as_u16() {
            401 | 403 => Err(anyhow!("AI 服务认证失败（HTTP {}）：{}", status.as_u16(), snippet)),
            429 => Err(anyhow!("AI 服务限流（HTTP 429），请稍后重试")),
            _ => Err(anyhow!("AI 服务返回错误（HTTP {}）：{}", status.as_u16(), snippet)),
        };
    }
    serde_json::from_str(&text).context("AI 返回内容不是合法 JSON")
}

fn extract_content(value: &Value, pointer: &str) -> Result<String> {
    let content = value
        .pointer(pointer)
        .and_then(|c| c.as_str())
        .map(str::trim)
        .filter(|c| !c.is_empty())
        .ok_or_else(|| anyhow!("AI 返回内容为空"))?;
    Ok(content.to_string())
}

fn endpoint(base: &str, path: &str) -> String {
    let base = base.trim().trim_end_matches('/');
    if base.ends_with(path) {
        base.to_string()
    } else {
        format!("{base}{path}")
    }
}

fn extract_json_object(text: &str) -> Option<&str> {
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    if end > start {
        Some(&text[start..=end])
    } else {
        None
    }
}

fn extract_code_block(text: &str) -> Option<String> {
    let mut parts = text.split("```");
    parts.next()?;
    let block = parts.next()?;
    let block = block.trim_start();
    let block = ["bash", "sh", "shell", "zsh", "powershell", "ps1"]
        .iter()
        .find_map(|lang| block.strip_prefix(lang).and_then(|rest| rest.strip_prefix('\n')))
        .unwrap_or(block)
        .trim();
    if block.is_empty() {
        None
    } else {
        Some(block.to_string())
    }
}

fn truncate(text: &str, max_bytes: usize) -> String {
    if text.len() <= max_bytes {
        return text.to_string();
    }
    let mut end = max_bytes;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n...（内容过长，已截断）", &text[..end])
}
