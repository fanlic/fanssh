import { useEffect, useMemo, useState } from "react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { errorText, profileExport, profileImport, rdpLaunch } from "./api";
import { SessionSidebar } from "./components/SessionSidebar";
import { SessionDialog } from "./components/SessionDialog";
import { SftpPanel } from "./components/SftpPanel";
import { TabBar } from "./components/TabBar";
import { TerminalPane } from "./components/TerminalPane";
import { AiSidebar } from "./components/AiSidebar";
import { useAppStore } from "./store";
import type { Profile } from "./types";

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
  const openProfileTab = useAppStore((s) => s.openProfileTab);
  const openProfileInSplit = useAppStore((s) => s.openProfileInSplit);
  const setSftpProfileId = useAppStore((s) => s.setSftpProfileId);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Profile | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  useEffect(() => {
    void loadProfiles();
  }, [loadProfiles]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 5000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  const activePane = activeTab?.panes[activeTab.activePane] ?? null;
  const sftpProfile = useMemo(
    () => profiles.find((profile) => profile.id === sftpProfileId) ?? null,
    [profiles, sftpProfileId],
  );

  const notify = (message: string, kind: "info" | "error" = "info") => setNotice({ message, kind });

  const sshProfiles = profiles.filter((profile) => profile.protocol === "ssh");

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
      notify("先打开一个 SSH 会话再分屏", "error");
      return;
    }
    const pane = activeTab.panes[activeTab.activePane];
    const profile = profiles.find((item) => item.id === pane?.profileId);
    if (!profile) {
      notify("找不到当前面板对应的服务器配置", "error");
      return;
    }
    if (profile.protocol !== "ssh") {
      notify("RDP 会话不支持终端分屏", "error");
      return;
    }
    openProfileInSplit(activeTab.id, profile);
  };

  const handleImport = async () => {
    const path = await openDialog({ filters: [{ name: "JSON", extensions: ["json"] }] });
    if (!path || Array.isArray(path)) return;
    try {
      const count = await profileImport(path);
      await loadProfiles();
      notify(`已导入 ${count} 个配置（凭据需重新填写）`);
    } catch (error) {
      notify(errorText(error), "error");
    }
  };

  const handleExport = async () => {
    const path = await saveDialog({
      defaultPath: "fanssh-profiles.json",
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (!path) return;
    try {
      const count = await profileExport(path);
      notify(`已导出 ${count} 个配置（不含密码/私钥）`);
    } catch (error) {
      notify(errorText(error), "error");
    }
  };

  return (
    <div className="app-shell">
      <SessionSidebar
        onNew={handleNew}
        onEdit={handleEdit}
        onImport={handleImport}
        onExport={handleExport}
        onRdp={handleRdp}
        onNotice={notify}
      />

      <section className="workspace">
        <div className="workspace-head">
          <select
            className="quick-connect"
            value=""
            onChange={(event) => {
              const profile = profiles.find((item) => item.id === event.target.value);
              if (profile) openProfileTab(profile);
            }}
          >
            <option value="">快速连接 SSH…</option>
            {sshProfiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name} · {profile.target.user}@{profile.target.host}
              </option>
            ))}
          </select>
          <div className="spacer" />
          <button className="ghost small" onClick={handleNew}>
            + 新建
          </button>
          <button className={`ghost small${aiOpen ? " is-on" : ""}`} onClick={toggleAi}>
            AI 面板
          </button>
        </div>

        <TabBar onSplit={handleSplit} />

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
            <div className="empty-state">
              <h2>FanSSH</h2>
              <p>SSH 终端 · SFTP · AI 运维助手 · RDP 调用</p>
              <div className="row center">
                <button className="primary" onClick={handleNew}>
                  新建服务器配置
                </button>
              </div>
              <p className="muted">
                在左侧双击服务器即可打开终端。凭据经系统加密后单独存储在本地凭据库。
              </p>
            </div>
          )}
        </div>

        <div className="statusbar">
          <span>
            {activePane
              ? `${activePane.profileName} · ${activePane.statusText}`
              : "就绪"}
          </span>
          <div className="spacer" />
          <span className="muted">
            协议 SSH/RDP · SFTP {sftpProfile ? sftpProfile.name : "未打开"}
          </span>
        </div>
      </section>

      {aiOpen && <AiSidebar />}

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

      {sftpProfile && (
        <SftpPanel
          profileId={sftpProfile.id}
          profileName={sftpProfile.name}
          onClose={() => setSftpProfileId(null)}
        />
      )}

      {notice && (
        <div className={`toast toast-${notice.kind}`} onClick={() => setNotice(null)}>
          {notice.message}
        </div>
      )}
    </div>
  );
}
