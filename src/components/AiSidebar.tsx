import { useEffect, useRef, useState } from "react";
import { aiChat, aiNl2Cmd, aiSettingsGet, aiSettingsSave, errorText, vaultPut } from "../api";
import { terminalRegistry } from "../lib/terminalRegistry";
import { activePaneSelector, useAppStore } from "../store";
import type { ChatMessage, Nl2CmdResult } from "../types";
import { Icon } from "./Icon";

const RISK_LABEL: Record<string, string> = {
  low: "低风险",
  medium: "中风险",
  high: "高风险",
};

export function AiSidebar() {
  const pane = useAppStore(activePaneSelector);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [inserted, setInserted] = useState<string | null>(null);

  const [provider, setProvider] = useState("ollama");
  const [baseUrl, setBaseUrl] = useState("http://127.0.0.1:11434");
  const [model, setModel] = useState("qwen2.5-coder:7b");
  const [temperature, setTemperature] = useState(0.2);
  const [maxContextKb, setMaxContextKb] = useState(32);
  const [secretId, setSecretId] = useState<string | null>(null);
  const [hasKey, setHasKey] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [nlPrompt, setNlPrompt] = useState("");
  const [nlResult, setNlResult] = useState<Nl2CmdResult | null>(null);
  const [autoRun, setAutoRun] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    aiSettingsGet()
      .then((settings) => {
        setProvider(settings.provider);
        setBaseUrl(settings.base_url);
        setModel(settings.model);
        setTemperature(settings.temperature);
        setMaxContextKb(settings.max_context_kb);
        setSecretId(settings.secret_id);
        setHasKey(settings.has_key);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, busy]);

  useEffect(() => {
    if (!inserted) return;
    const timer = window.setTimeout(() => setInserted(null), 2600);
    return () => window.clearTimeout(timer);
  }, [inserted]);

  const saveSettings = async () => {
    setError(null);
    try {
      let nextSecret = secretId;
      if (apiKeyInput.trim()) {
        nextSecret = await vaultPut(secretId, "token", "AI API Key", apiKeyInput.trim());
        setSecretId(nextSecret);
        setApiKeyInput("");
      }
      const saved = await aiSettingsSave({
        provider,
        base_url: baseUrl,
        model,
        temperature,
        secret_id: nextSecret,
        max_context_kb: maxContextKb,
      });
      setHasKey(saved.has_key);
      setShowSettings(false);
    } catch (err) {
      setError(errorText(err));
    }
  };

  const contextFromTerminal = (): string => {
    if (!pane) return "";
    const selection = terminalRegistry.selection(pane.key);
    if (selection.trim()) return selection;
    return terminalRegistry.tail(pane.key, 40);
  };

  const send = async (text: string, kind: "chat" | "explain") => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    const next: ChatMessage[] = [...messages, { role: "user", content: trimmed }];
    setMessages(next);
    setBusy(true);
    setError(null);
    try {
      const context = contextFromTerminal();
      const reply = await aiChat(next, kind, context || null);
      setMessages((prev) => [...prev, { role: "assistant", content: reply }]);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const analyzeSelection = () => {
    if (!pane) {
      setError("当前没有打开的终端面板");
      return;
    }
    const selection = terminalRegistry.selection(pane.key);
    const content = selection.trim() ? selection : terminalRegistry.tail(pane.key, 40);
    if (!content.trim()) {
      setError("终端里还没有可分析的内容");
      return;
    }
    void send(
      `请分析下面这段终端输出，指出问题原因并给出排查/修复命令：\n\n\`\`\`\n${content}\n\`\`\``,
      "explain",
    );
  };

  const generateCommand = async () => {
    if (!nlPrompt.trim() || busy) return;
    setBusy(true);
    setError(null);
    setNlResult(null);
    try {
      const result = await aiNl2Cmd(nlPrompt, contextFromTerminal() || null);
      setNlResult(result);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const insertCommand = () => {
    if (!nlResult || !pane) return;
    const ok = terminalRegistry.insert(pane.key, nlResult.command, autoRun && !nlResult.blocked && nlResult.risk !== "high");
    if (!ok) {
      setError("终端面板不存在，请先打开会话");
      return;
    }
    setInserted(nlResult.command);
    setNlResult(null);
    setNlPrompt("");
  };

  return (
    <aside className="ai-panel">
      <div className="ai-head">
        <span className="ai-title">
          <Icon name="spark" size={14} />
          AI 助手
        </span>
        <span className="ai-model">
          <span className="dot st-ready" />
          {model}
        </span>
        <div className="spacer" />
        <button
          className={`icon-btn sm${showSettings ? " is-on" : ""}`}
          title="AI 设置"
          onClick={() => setShowSettings((value) => !value)}
        >
          <Icon name="gear" size={14} />
        </button>
      </div>

      {showSettings && (
        <div className="ai-settings">
          <label>
            服务
            <select value={provider} onChange={(event) => setProvider(event.target.value)}>
              <option value="ollama">Ollama（本地）</option>
              <option value="openai">OpenAI 兼容接口</option>
            </select>
          </label>
          <label>
            Base URL
            <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} />
          </label>
          <label>
            模型
            <input value={model} onChange={(event) => setModel(event.target.value)} />
          </label>
          <div className="ai-settings-row">
            <label>
              Temperature
              <input
                type="number"
                step="0.1"
                min="0"
                max="2"
                value={temperature}
                onChange={(event) => setTemperature(Number(event.target.value))}
              />
            </label>
            <label>
              上下文上限 (KB)
              <input
                type="number"
                min="1"
                max="128"
                value={maxContextKb}
                onChange={(event) => setMaxContextKb(Number(event.target.value))}
              />
            </label>
          </div>
          <label>
            API Key {hasKey && <span className="muted">（已保存，留空不修改）</span>}
            <input
              type="password"
              value={apiKeyInput}
              onChange={(event) => setApiKeyInput(event.target.value)}
              placeholder={hasKey ? "••••••••" : "sk-..."}
            />
          </label>
          <div className="ai-settings-foot">
            <button className="btn-primary sm" onClick={saveSettings}>
              保存设置
            </button>
            <span className="muted">密钥只进凭据库，不回传前端</span>
          </div>
        </div>
      )}

      <div className="ai-ctx">
        <span className="ctx-pane">
          <span className={`dot st-${pane?.status ?? "idle"}`} />
          {pane ? pane.profileName : "未打开终端"}
        </span>
        <button className="btn-ghost sm" onClick={analyzeSelection} disabled={busy || !pane}>
          <Icon name="search" size={12} />
          分析选中内容
        </button>
      </div>

      {error && (
        <div className="banner err" onClick={() => setError(null)}>
          {error}
        </div>
      )}

      <div className="ai-chat">
        {messages.length === 0 && (
          <div className="ai-empty">
            <span className="ai-empty-icon">
              <Icon name="spark" size={18} />
            </span>
            <div className="empty-title">运维助手就绪</div>
            <p>
              选中终端里的报错后点「分析选中内容」，或直接在下方提问。
              自然语言转命令默认只插入，不自动执行。
            </p>
          </div>
        )}
        {messages.map((message, index) => (
          <div className={`msg msg-${message.role}`} key={index}>
            <div className="msg-role">
              {message.role === "user" ? "你" : <Icon name="spark" size={11} />}
            </div>
            <div className="msg-body">
              <pre>{message.content}</pre>
            </div>
          </div>
        ))}
        {busy && (
          <div className="msg msg-assistant is-loading">
            <div className="msg-role">
              <Icon name="spark" size={11} />
            </div>
            <div className="msg-body">
              <span className="typing">
                <i />
                <i />
                <i />
              </span>
            </div>
          </div>
        )}
        <div ref={chatEndRef} />
      </div>

      {inserted && (
        <div className="ai-inserted">
          <Icon name="check" size={12} />
          已插入到输入行（未执行）
        </div>
      )}

      <div className="ai-compose">
        <textarea
          rows={2}
          value={input}
          placeholder="向 AI 提问…（Ctrl+Enter 发送）"
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
              void send(input, "chat");
              setInput("");
            }
          }}
        />
        <div className="compose-foot">
          <span className="muted">Ctrl+Enter 发送</span>
          <button
            className="btn-primary sm"
            disabled={busy || !input.trim()}
            onClick={() => {
              void send(input, "chat");
              setInput("");
            }}
          >
            发送
          </button>
        </div>
      </div>

      <div className="ai-nl2cmd">
        <div className="section-title">自然语言转命令</div>
        <div className="nl-input-row">
          <input
            value={nlPrompt}
            placeholder="例如：查找占用内存最高的前 5 个进程"
            onChange={(event) => setNlPrompt(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && generateCommand()}
          />
          <button className="btn-ghost sm" onClick={generateCommand} disabled={busy || !nlPrompt.trim()}>
            生成
          </button>
        </div>
        {nlResult && (
          <div className={`cmd-card risk-${nlResult.risk}`}>
            <div className="cmd-head">
              <span className="cmd-title">命令建议</span>
              <span className={`risk-badge risk-${nlResult.risk}`}>
                {RISK_LABEL[nlResult.risk] ?? nlResult.risk}
              </span>
              {nlResult.requires_sudo && <span className="tag">sudo</span>}
              {nlResult.blocked && <span className="tag danger">已拦截</span>}
              <div className="spacer" />
              <button
                className="icon-btn sm"
                title="复制命令"
                onClick={() => void navigator.clipboard?.writeText(nlResult.command)}
              >
                <Icon name="copy" size={12} />
              </button>
            </div>
            <pre className="cmd-code">{nlResult.command}</pre>
            {nlResult.explanation && <div className="cmd-note">{nlResult.explanation}</div>}
            {nlResult.assumptions.length > 0 && (
              <ul className="nl-assumptions">
                {nlResult.assumptions.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            )}
            <div className="cmd-foot">
              <label className="check">
                <input
                  type="checkbox"
                  checked={autoRun}
                  disabled={nlResult.blocked || nlResult.risk === "high"}
                  onChange={(event) => setAutoRun(event.target.checked)}
                />
                插入后按回车执行
              </label>
              <div className="spacer" />
              <button className="btn-ghost sm" onClick={() => setNlResult(null)}>
                放弃
              </button>
              <button className="btn-primary sm" onClick={insertCommand}>
                确认并插入
              </button>
            </div>
            <div className="cmd-hint">
              shell: {nlResult.shell} · 只写入终端输入行，需你确认后才会执行
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
