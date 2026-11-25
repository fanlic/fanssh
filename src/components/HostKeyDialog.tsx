import { useEffect, useRef, useState } from "react";
import { errorText, termHostKeyRespond } from "../api";
import type { HostKeyDecision, HostKeyPrompt } from "../types";
import { Icon } from "./Icon";

interface Props {
  prompt: HostKeyPrompt;
  onDone: () => void;
}

export function HostKeyDialog({ prompt, onDone }: Props) {
  const answered = useRef(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => () => {
    if (!answered.current) {
      void termHostKeyRespond(prompt.prompt_id, "cancel").catch(() => undefined);
    }
  }, [prompt.prompt_id]);

  const respond = async (decision: HostKeyDecision) => {
    if (answered.current) return;
    answered.current = true;
    setBusy(true);
    try {
      await termHostKeyRespond(prompt.prompt_id, decision);
      onDone();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
      answered.current = false;
    }
  };

  return (
    <div className="auth-mask host-key-mask" onMouseDown={(event) => event.stopPropagation()}>
      <div className="auth-dialog" role="alertdialog" aria-modal="true" aria-labelledby={`host-key-${prompt.prompt_id}`}>
        <div className="auth-head" id={`host-key-${prompt.prompt_id}`}>
          <Icon name="alert" size={15} /> 首次连接：请验证主机指纹
        </div>
        <div className="auth-body">
          <div>目标：{prompt.host}:{prompt.port}</div>
          <p>请与服务器管理员提供的指纹核对后再继续。</p>
          <code className="host-key-value">{prompt.algorithm} {prompt.fingerprint}</code>
          <button
            className="btn-ghost sm"
            onClick={() => void navigator.clipboard.writeText(prompt.fingerprint)
              .then(() => setCopied(true))
              .catch(() => setError("无法复制指纹，请手动选中复制"))}
          >
            {copied ? "已复制" : "复制指纹"}
          </button>
          {error && <p role="alert">{error}</p>}
        </div>
        <div className="auth-foot">
          <button className="btn-ghost" disabled={busy} onClick={() => void respond("once")}>仅本次连接</button>
          <div className="spacer" />
          <button className="btn-ghost" autoFocus disabled={busy} onClick={() => void respond("cancel")}>取消连接</button>
          <button className="btn-primary" disabled={busy} onClick={() => void respond("save")}>信任并保存</button>
        </div>
      </div>
    </div>
  );
}
