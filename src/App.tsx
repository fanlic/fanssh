import { useEffect, useMemo, useRef, useState } from "react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { errorText, profileExport, profileImport, rdpLaunch, updaterStatus } from "./api";
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
import { useAppStore } from "./store";
import type { DockerContainer, Profile } from "./types";

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
  const [notice, setNotice] = useState<Notice | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [dockerOpen, setDockerOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [version, setVersion] = useState("1.0.5");
  const quickSearchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void loadProfiles();
    updaterStatus()
      .then((status) => setVersion(status.currentVersion))
      .catch(() => undefined);
  }, [loadProfiles]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 5000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      const key = event.key.toLowerCase();
      if (key === "k") {
        event.preventDefault();
        setSidebarOpen(true);
        quickSearchRef.current?.focus();
        quickSearchRef.current?.select();
      } else if (key === "b") {
        event.preventDefault();
        setSidebarOpen((value) => !value);
      } else if (key === "j") {
        event.preventDefault();
        toggleAi();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
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

  const handleNew = () => {
    setEditing(null);
    setDialogOpen(true);
  };

  const handleEdit = (profile: Profile) => {
    setEditing(profile);
    setDialogOpen(true);
  };

  const handleRdp = async (profile: Profile) => {
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
        <button
          className="icon-btn tb-toggle"
          title={sidebarOpen ? "收起侧栏 (Ctrl B)" : "展开侧栏 (Ctrl B)"}
          onClick={() => setSidebarOpen((value) => !value)}
        >
          <Icon name="split" size={14} />
        </button>
        <div className="tb-left">
          <span className="brand-mark">
            <Icon name="term" size={12} />
          </span>
          <span className="brand-name">FanSSH</span>
          <span className="brand-ver">v{version}</span>
          <span className="tb-div" />
          <span className="tb-ws">本地工作区</span>
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
            <kbd>Ctrl K</kbd>
          )}
        </div>
        <div className="tb-right">
          <button className="icon-btn" title="设置" onClick={() => setSettingsOpen(true)}>
            <Icon name="gear" size={15} />
          </button>
        </div>
      </header>

      <div className="app-body">
        {sidebarOpen && (
          <SessionSidebar
            onNew={handleNew}
            onEdit={handleEdit}
            onImport={handleImport}
            onExport={handleExport}
            onRdp={handleRdp}
            onNotice={notify}
            query={query}
            onQueryChange={setQuery}
          />
        )}

        <main className="workspace">
          <TabBar onSplit={handleSplit} />

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
                      <Icon name="term" size={20} />
                    </span>
                    <h2>FanSSH</h2>
                    <p>SSH / 串口终端 · SFTP · AI 运维助手 · RDP 调用</p>
                    <div className="se-actions">
                      <button className="btn-primary" onClick={handleNew}>
                        新建服务器配置
                      </button>
                      <button className="btn-ghost" onClick={() => { setSidebarOpen(true); quickSearchRef.current?.focus(); }}>
                        搜索已有会话
                      </button>
                    </div>
                    <p className="se-hint">
                      在左侧双击服务器即可打开终端，凭据经系统加密后单独存储在本地凭据库。
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>

          <footer className="statusbar">
            <span className="sb-left">
              <span className={`dot st-${activePane?.status ?? "idle"}`} />
              <span className="sb-text">{activePane ? activePane.statusText : "就绪"}</span>
              {activePane && <span className="sb-meta">{activePane.profileName}</span>}
              {activeProfile && (
                <span className="sb-meta mono">
                  {activeProfile.protocol === "serial"
                    ? `${activeProfile.target.host} · ${activeProfile.options.serial?.baud_rate ?? 0}`
                    : `${activeProfile.target.user ? `${activeProfile.target.user}@` : ""}${activeProfile.target.host}`}
                </span>
              )}
            </span>
            <div className="spacer" />
            {activeProfile?.protocol === "ssh" && (
              <button className="sb-btn" onClick={() => setSftpProfileId(activeProfile.id)}>
                <Icon name="transfer" size={12} />
                SFTP
              </button>
            )}
            <button className="sb-btn" onClick={() => setSettingsOpen(true)}>
              <Icon name="refresh" size={12} />
              检查更新
            </button>
            <span className="sb-meta">{profiles.length} 个配置</span>
          </footer>

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
        </main>

        <ActivityBar
          sftpOpen={sftpProfileId !== null}
          dockerOpen={dockerOpen}
          aiOpen={aiOpen}
          onToggleSftp={handleSftpToggle}
          onToggleDocker={handleDockerToggle}
          onToggleAi={toggleAi}
        />

        <AiSidebar collapsed={!aiOpen} />
      </div>

      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onNotice={notify}
      />

      <SessionDialog
        open={dialogOpen}
        initial={editing}
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
