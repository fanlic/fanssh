import { useEffect, useMemo, useRef, useState } from "react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { appPlatform, errorText, profileExport, profileImport, rdpLaunch, updaterStatus } from "./api";
import { AiSidebar } from "./components/AiSidebar";
import { ActivityBar } from "./components/ActivityBar";
import { DockerPanel } from "./components/DockerPanel";
import { Icon } from "./components/Icon";
import { PassphraseDialog } from "./components/PassphraseDialog";
import { SessionDialog } from "./components/SessionDialog";
import { SessionSidebar } from "./components/SessionSidebar";
import { SettingsDialog } from "./components/SettingsDialog";
import { SftpPanel } from "./components/SftpPanel";
import { TabBar } from "./components/TabBar";
import { TerminalPane } from "./components/TerminalPane";
import { TunnelDialog } from "./components/TunnelDialog";
import { useAppStore } from "./store";
import type { DockerContainer, Profile, Protocol } from "./types";

interface Notice {
  message: string;
  kind: "info" | "error";
}

export default function App() {
  const profiles = useAppStore((s) => s.profiles);
  const tabs = useAppStore((s) => s.tabs);
  const activeTabId = useAppStore((s) => s.activeTabId);
  const aiOpen = useAppStore((s) => s.aiOpen);
  const sftpProfileId = useAppStore((s) => s.sftpProfileId);
  const toggleAi = useAppStore((s) => s.toggleAi);
  const loadProfiles = useAppStore((s) => s.loadProfiles);
  const openProfileInSplit = useAppStore((s) => s.openProfileInSplit);
  const openProfileTab = useAppStore((s) => s.openProfileTab);
  const setSftpProfileId = useAppStore((s) => s.setSftpProfileId);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [editing, setEditing] = useState<Profile | null>(null);
  const [proto, setProto] = useState<Protocol>("ssh");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [dockerOpen, setDockerOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [version, setVersion] = useState("1.0.6");
  const [platform, setPlatform] = useState("windows");
  const [tunnelProfile, setTunnelProfile] = useState<Profile | null>(null);
  const quickSearchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void loadProfiles();
    updaterStatus()
      .then((status) => setVersion(status.currentVersion))
      .catch(() => undefined);
    appPlatform()
      .then(setPlatform)
      .catch(() => undefined);
  }, [loadProfiles]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 5000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    const toggleFullscreen = async () => {
      try {
        if (!("__TAURI_INTERNALS__" in window)) {
          if (document.fullscreenElement) await document.exitFullscreen();
          else await document.documentElement.requestFullscreen();
          return;
        }
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const win = getCurrentWindow();
        await win.setFullscreen(!(await win.isFullscreen()));
      } catch {
        /* 忽略窗口能力不可用 */
      }
    };

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "F11") {
        event.preventDefault();
        event.stopPropagation();
        void toggleFullscreen();
        return;
      }
      if (!(event.ctrlKey || event.metaKey)) return;

      const target = event.target as HTMLElement | null;
      // xterm 用隐藏 textarea 接收输入，不能把终端焦点当成“正在编辑表单”。
      const inTerminal = !!target?.classList.contains("xterm-helper-textarea");
      const editing =
        !inTerminal &&
        !!target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);
      if (editing) return;

      const key = event.key.toLowerCase();
      const state = useAppStore.getState();

      const isGlobalShortcut =
        (key === "f" && event.shiftKey) ||
        (key === "b" && event.shiftKey) ||
        (key === "j" && event.shiftKey) ||
        key === "w" ||
        key === "tab" ||
        /^[1-5]$/.test(key) ||
        key === "," ||
        key === "=" ||
        key === "+" ||
        key === "-" ||
        key === "_" ||
        (key === "s" && event.shiftKey);
      // 捕获阶段拦下应用快捷键，避免 xterm 同时把控制字符发给远端。
      if (!isGlobalShortcut) return;
      event.preventDefault();
      event.stopPropagation();

      // 依据：https://docs.xterminal.cn/reference/shortcuts —— 全局搜索使用 Ctrl+Shift+F。
      if (key === "f" && event.shiftKey) {
        event.preventDefault();
        setSidebarOpen(true);
        quickSearchRef.current?.focus();
        quickSearchRef.current?.select();
      } else if (key === "b" && event.shiftKey) {
        event.preventDefault();
        setSidebarOpen((value) => !value);
      } else if (key === "j" && event.shiftKey) {
        event.preventDefault();
        toggleAi();
      } else if (key === "w") {
        event.preventDefault();
        if (state.activeTabId) state.closeTab(state.activeTabId);
      } else if (key === "tab") {
        event.preventDefault();
        if (state.tabs.length > 1) {
          const index = state.tabs.findIndex((tab) => tab.id === state.activeTabId);
          const delta = event.shiftKey ? -1 : 1;
          const next = (index + delta + state.tabs.length) % state.tabs.length;
          state.setActiveTab(state.tabs[next].id);
        }
      } else if (/^[1-5]$/.test(key)) {
        event.preventDefault();
        const tab = state.tabs[Number(key) - 1];
        if (tab) state.setActiveTab(tab.id);
      } else if (key === ",") {
        event.preventDefault();
        setSettingsOpen(true);
      } else if (key === "=" || key === "+") {
        event.preventDefault();
        window.dispatchEvent(new CustomEvent("fanssh:zoom", { detail: 1 }));
      } else if (key === "-" || key === "_") {
        event.preventDefault();
        window.dispatchEvent(new CustomEvent("fanssh:zoom", { detail: -1 }));
      } else if (key === "s" && event.shiftKey) {
        event.preventDefault();
        const tab = state.tabs.find((item) => item.id === state.activeTabId);
        const pane = tab?.panes[tab.activePane];
        const profile = state.profiles.find((item) => item.id === pane?.profileId);
        if (profile?.protocol === "ssh") {
          state.setSftpProfileId(state.sftpProfileId === profile.id ? null : profile.id);
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toggleAi]);

  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  const activePane = activeTab?.panes[activeTab.activePane] ?? null;
  const sftpProfile = useMemo(
    () => profiles.find((profile) => profile.id === sftpProfileId) ?? null,
    [profiles, sftpProfileId],
  );
  const activeProfile = useMemo(
    () => profiles.find((profile) => profile.id === activePane?.profileId) ?? null,
    [profiles, activePane],
  );

  const notify = (message: string, kind: "info" | "error" = "info") => setNotice({ message, kind });
  const protoLabel = proto === "ssh" ? "SSH" : proto === "serial" ? "串口" : proto === "tunnel" ? "隧道" : "RDP";

  const handleNew = () => {
    setEditing(null);
    setDialogOpen(true);
  };

  const handleEdit = (profile: Profile) => {
    setEditing(profile);
    setProto(profile.protocol);
    setDialogOpen(true);
  };

  const handleRdp = async (profile: Profile) => {
    if (platform !== "windows") {
      notify("当前平台不支持 RDP 远程桌面，请在 Windows 客户端使用该配置。", "error");
      return;
    }
    try {
      const handle = await rdpLaunch(profile.id);
      notify(`已生成 ${handle.rdp_file}，正在调用 mstsc.exe${handle.pid ? `（pid ${handle.pid}）` : ""}`);
    } catch (error) {
      notify(errorText(error), "error");
    }
  };

  const handleSplit = () => {
    if (!activeTab) {
      notify("先打开一个终端会话再分屏", "error");
      return;
    }
    const pane = activeTab.panes[activeTab.activePane];
    const profile = profiles.find((item) => item.id === pane?.profileId);
    if (!profile) {
      notify("找不到当前面板对应的服务器配置", "error");
      return;
    }
    if (profile.protocol === "rdp") {
      notify("RDP 会话不支持终端分屏", "error");
      return;
    }
    openProfileInSplit(activeTab.id, profile);
  };

  const handleSftpToggle = () => {
    if (sftpProfileId) {
      setSftpProfileId(null);
      return;
    }
    if (!activeProfile || activeProfile.protocol !== "ssh") {
      notify("先打开一个 SSH 会话再使用 SFTP", "error");
      return;
    }
    setDockerOpen(false);
    setSftpProfileId(activeProfile.id);
  };

  const handleDockerToggle = () => {
    if (dockerOpen) {
      setDockerOpen(false);
      return;
    }
    setSftpProfileId(null);
    setDockerOpen(true);
  };

  /** 进入容器：新开 SSH 终端 Tab，把命令写进输入行但不回车。 */
  const handleDockerShell = (container: DockerContainer) => {
    if (!activeProfile || activeProfile.protocol !== "ssh") {
      notify("请先连接一个 Linux SSH 会话", "error");
      return;
    }
    // 只接受十六进制容器 id（与后端白名单一致），不使用远端返回的名称拼命令。
    if (!/^[0-9a-f]{12,64}$/i.test(container.id)) {
      notify("容器标识异常，已取消插入命令", "error");
      return;
    }
    openProfileTab(activeProfile, `docker exec -it ${container.id} bash`);
    notify(
      "已插入 docker exec 命令（未执行）。若容器内没有 bash，把末尾的 bash 改成 sh 后按 Enter。",
    );
  };

  const [passDialog, setPassDialog] = useState<{ mode: "export" | "import"; path: string } | null>(
    null,
  );
  const [passError, setPassError] = useState<string | null>(null);
  const [passBusy, setPassBusy] = useState(false);

  const handleImport = async () => {
    const path = await openDialog({
      filters: [{ name: "FanSSH 配置", extensions: ["fansshx", "json"] }],
    });
    if (!path || Array.isArray(path)) return;
    try {
      const count = await profileImport(path);
      await loadProfiles();
      notify(`已导入 ${count} 个配置`);
    } catch (error) {
      if ((error as { code?: string } | null)?.code === "profile.passphrase_required") {
        setPassError(null);
        setPassDialog({ mode: "import", path });
        return;
      }
      notify(errorText(error), "error");
    }
  };

  const handleExport = async () => {
    const path = await saveDialog({
      defaultPath: "fanssh-profiles.fansshx",
      filters: [{ name: "FanSSH 加密配置", extensions: ["fansshx"] }],
    });
    if (!path) return;
    setPassError(null);
    setPassDialog({ mode: "export", path });
  };

  const handlePassphrase = async (passphrase: string) => {
    if (!passDialog) return;
    setPassBusy(true);
    setPassError(null);
    try {
      if (passDialog.mode === "export") {
        const count = await profileExport(passDialog.path, passphrase);
        notify(`已导出 ${count} 个配置（口令加密）`);
      } else {
        const count = await profileImport(passDialog.path, passphrase);
        await loadProfiles();
        notify(`已导入 ${count} 个配置，凭据已写入本地凭据库`);
      }
      setPassDialog(null);
    } catch (error) {
      setPassError(errorText(error));
    } finally {
      setPassBusy(false);
    }
  };

  return (
    <div className="app-shell">
      <header className="titlebar">
        <div className="tb-icons">
          <button
            className={`tb-slot${sidebarOpen ? " is-active" : ""}`}
            title={sidebarOpen ? "收起会话列表 (Ctrl Shift B)" : "展开会话列表 (Ctrl Shift B)"}
            onClick={() => setSidebarOpen((value) => !value)}
          >
            <Icon name="term" size={14} />
          </button>
          <button className="tb-slot" title="新建连接" onClick={handleNew}>
            <Icon name="plus" size={14} />
          </button>
          <button
            className={`tb-slot${sftpProfileId ? " is-active" : ""}`}
            title={sftpProfileId ? "关闭 SFTP (Ctrl Shift S)" : "打开 SFTP (Ctrl Shift S)"}
            onClick={handleSftpToggle}
          >
            <Icon name="transfer" size={14} />
          </button>
          <button
            className={`tb-slot${dockerOpen ? " is-active" : ""}`}
            title={dockerOpen ? "关闭 Docker 面板" : "打开 Docker 面板"}
            onClick={handleDockerToggle}
          >
            <Icon name="docker" size={14} />
          </button>
        </div>
        <div className="tb-quick">
          <Icon name="search" size={13} />
          <input
            ref={quickSearchRef}
            value={query}
            placeholder="快速连接或搜索会话"
            onChange={(event) => {
              setQuery(event.target.value);
              setSidebarOpen(true);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setQuery("");
                quickSearchRef.current?.blur();
              }
            }}
          />
          {query ? (
            <button className="tb-clear" title="清空搜索" onClick={() => setQuery("")}>
              <Icon name="x" size={11} />
            </button>
          ) : (
            <kbd>Ctrl Shift F</kbd>
          )}
        </div>
        <div className="tb-right">
          <span className="brand-ver">v{version}</span>
          <button className="tb-gear" title="设置 (Ctrl ,)" onClick={() => setSettingsOpen(true)}>
            <Icon name="gear" size={18} />
          </button>
        </div>
      </header>

      <div className="protobar">
        <div className="proto-tabs" role="tablist">
          {(["ssh", "serial", "rdp", "tunnel"] as Protocol[])
            .filter((item) => item !== "rdp" || platform === "windows")
            .map((item) => (
              <button
                key={item}
                role="tab"
                aria-selected={proto === item}
                className={`proto-tab${proto === item ? " is-active" : ""}`}
                onClick={() => {
                  setProto(item);
                  setSidebarOpen(true);
                }}
              >
                {item === "ssh" ? "SSH" : item === "serial" ? "串口" : item === "tunnel" ? "隧道" : "RDP"}
              </button>
            ))}
        </div>
        <div className="spacer" />
        <button className="proto-action" onClick={handleImport}>
          <Icon name="import" size={12} />
          导入
        </button>
        <button className="proto-action" onClick={handleExport}>
          <Icon name="export" size={12} />
          导出配置
        </button>
      </div>

      <div className="app-body">
        {sidebarOpen && (
          <SessionSidebar
            proto={proto}
            onCollapse={() => setSidebarOpen(false)}
            onNew={handleNew}
            onEdit={handleEdit}
            onImport={handleImport}
            onExport={handleExport}
            onRdp={handleRdp}
            onOpenTunnel={setTunnelProfile}
            onNotice={notify}
            query={query}
            onQueryChange={setQuery}
          />
        )}

        <ActivityBar
          sftpOpen={sftpProfileId !== null}
          dockerOpen={dockerOpen}
          aiOpen={aiOpen}
          onToggleSftp={handleSftpToggle}
          onToggleDocker={handleDockerToggle}
          onToggleAi={toggleAi}
        />

        <main className="workspace">
          <TabBar onSplit={handleSplit} />

          <div className="workspace-body">
            {sftpProfile && (
              <SftpPanel
                profileId={sftpProfile.id}
                profileName={sftpProfile.name}
                onClose={() => setSftpProfileId(null)}
              />
            )}

            {dockerOpen && (
              <DockerPanel
                profile={activeProfile}
                sessionId={
                  activeProfile?.protocol === "ssh" ? (activePane?.sessionId ?? null) : null
                }
                paneReady={activePane?.status === "ready"}
                onClose={() => setDockerOpen(false)}
                onOpenShell={handleDockerShell}
              />
            )}

            <div className="stage">
            <div className="panes-host">
              {tabs.map((tab) => (
                <div
                  key={tab.id}
                  className={`tab-panes direction-${tab.direction}${tab.id === activeTabId ? "" : " is-hidden"}`}
                >
                  {tab.panes.map((pane, index) => (
                    <TerminalPane
                      key={pane.key}
                      tabId={tab.id}
                      pane={pane}
                      active={tab.id === activeTabId && index === tab.activePane}
                    />
                  ))}
                </div>
              ))}
              {tabs.length === 0 && (
                <div className="stage-empty">
                  <div className="se-card">
                    <span className="se-logo">
                      <Icon name="term" size={40} />
                    </span>
                    <h2>暂无{protoLabel}连接</h2>
                    <p>通过下方「+ {protoLabel}」按钮添加首个连接。</p>
                    <div className="se-actions">
                      <button className="btn-primary" onClick={handleNew}>
                        + 新建{protoLabel}连接
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
            </div>
          </div>
        </main>

        <AiSidebar collapsed={!aiOpen} />
      </div>

      <TunnelDialog
        open={tunnelProfile !== null}
        profile={tunnelProfile}
        onClose={() => setTunnelProfile(null)}
        onEdit={(profile) => {
          setTunnelProfile(null);
          handleEdit(profile);
        }}
        onNotice={notify}
      />

      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onNotice={notify}
        platform={platform}
      />

      <SessionDialog
        open={dialogOpen}
        initial={editing}
        platform={platform}
        defaultProtocol={proto}
        onClose={() => setDialogOpen(false)}
        onSaved={(profile) => {
          void loadProfiles();
          notify(`已保存 ${profile.name}`);
        }}
        onError={(message) => notify(message, "error")}
      />

      <PassphraseDialog
        open={passDialog !== null}
        mode={passDialog?.mode ?? "export"}
        busy={passBusy}
        error={passError}
        onSubmit={handlePassphrase}
        onClose={() => {
          if (passBusy) return;
          setPassDialog(null);
          setPassError(null);
        }}
      />

      {notice && (
        <div className={`toast toast-${notice.kind}`} onClick={() => setNotice(null)}>
          {notice.message}
        </div>
      )}
    </div>
  );
}
