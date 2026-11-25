import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent } from "react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { appPlatform, errorText, profileExport, profileImport, updaterStatus } from "./api";
import { AiSidebar } from "./components/AiSidebar";
import { ActivityBar } from "./components/ActivityBar";
import { DockerPanel } from "./components/DockerPanel";
import { Icon } from "./components/Icon";
import { MonitorPanel } from "./components/MonitorPanel";
import { PassphraseDialog } from "./components/PassphraseDialog";
import { RdpPane } from "./components/RdpPane";
import { SessionDialog } from "./components/SessionDialog";
import { SessionSidebar } from "./components/SessionSidebar";
import { SettingsDialog } from "./components/SettingsDialog";
import { SftpPanel } from "./components/SftpPanel";
import { TabBar } from "./components/TabBar";
import { TerminalPane } from "./components/TerminalPane";
import { TunnelDialog } from "./components/TunnelDialog";
import { VncPane } from "./components/VncPane";
import { applyAppearance } from "./lib/appearance";
import { matchesProfile } from "./lib/profileSearch";
import { useAppStore } from "./store";
import { useUiSettingsStore } from "./uiSettings";
import type { DockerContainer, Profile, Protocol } from "./types";

interface Notice {
  message: string;
  kind: "info" | "error";
}

type DropZone = "top" | "bottom" | "left" | "right";

/** 把键盘事件转成与设置页一致的绑定字符串。 */
function eventCombo(event: KeyboardEvent): string {
  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) parts.push("Ctrl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  let key = event.key;
  if (key === " ") key = "Space";
  else if (key.length === 1) key = key.toUpperCase();
  parts.push(key);
  return parts.join("+");
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
  const [assetView, setAssetView] = useState(true);
  const [assetTreeOpen, setAssetTreeOpen] = useState(true);
  const [assetFilter, setAssetFilter] = useState<"all" | "favorites" | "recent">("all");
  const favorites = useAppStore((s) => s.favoriteProfileIds);
  const recent = useAppStore((s) => s.recentProfileIds);
  const toggleFavorite = useAppStore((s) => s.toggleFavorite);
  const [dockerOpen, setDockerOpen] = useState(false);
  const updatePaneTools = useAppStore((s) => s.updatePaneTools);
  const [query, setQuery] = useState("");
  const [version, setVersion] = useState("1.0.6");
  const [platform, setPlatform] = useState("windows");
  const [tunnelProfile, setTunnelProfile] = useState<Profile | null>(null);
  const [dropZone, setDropZone] = useState<DropZone | null>(null);
  const appearance = useUiSettingsStore((s) => s.settings.appearance);
  const stageRef = useRef<HTMLDivElement>(null);
  const quickSearchRef = useRef<HTMLInputElement>(null);
  const focusConnectionSearch = () => {
    setAssetView(true);
    requestAnimationFrame(() => {
      quickSearchRef.current?.focus();
      quickSearchRef.current?.select();
    });
  };

  useEffect(() => {
    void loadProfiles();
    void useUiSettingsStore.getState().load();
    updaterStatus()
      .then((status) => setVersion(status.currentVersion))
      .catch(() => undefined);
    appPlatform()
      .then(setPlatform)
      .catch(() => undefined);
  }, [loadProfiles]);

  // 外观设置实时写入 CSS 变量；跟随系统时监听深浅色变化。
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => applyAppearance(appearance, media.matches);
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [appearance]);

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
      // 允许 Alt / Shift 等组合也参与匹配，具体是否拦截由绑定表决定。
      const withCmd = event.ctrlKey || event.metaKey;

      const target = event.target as HTMLElement | null;
      // 快捷键录制输入框里的按键只用于采集组合键，不触发应用操作。
      if (target?.closest?.(".sc-recorder")) return;
      // xterm 用隐藏 textarea 接收输入，不能把终端焦点当成“正在编辑表单”。
      const inTerminal = !!target?.classList.contains("xterm-helper-textarea");
      const editing =
        !inTerminal &&
        !!target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable);
      if (editing) return;

      const state = useAppStore.getState();
      const shortcuts = useUiSettingsStore.getState().settings.shortcuts;
      const combo = eventCombo(event);
      const action = (Object.keys(shortcuts) as Array<keyof typeof shortcuts>).find(
        (name) => shortcuts[name] && shortcuts[name] === combo,
      );
      if (action) {
        // 捕获阶段拦下应用快捷键，避免 xterm 同时把控制字符发给远端。
        event.preventDefault();
        event.stopPropagation();
        switch (action) {
          case "open_settings":
            setSettingsOpen(true);
            break;
          case "global_search":
            focusConnectionSearch();
            break;
          case "next_tab":
          case "prev_tab": {
            if (state.tabs.length < 2) break;
            const index = state.tabs.findIndex((tab) => tab.id === state.activeTabId);
            const delta = action === "next_tab" ? 1 : -1;
            const next = (index + delta + state.tabs.length) % state.tabs.length;
            state.setActiveTab(state.tabs[next].id);
            break;
          }
          case "close_tab":
            if (state.activeTabId) state.closeTab(state.activeTabId);
            break;
          case "zoom_in":
            window.dispatchEvent(new CustomEvent("fanssh:zoom", { detail: 1 }));
            break;
          case "zoom_out":
            window.dispatchEvent(new CustomEvent("fanssh:zoom", { detail: -1 }));
            break;
          case "toggle_sidebar":
            setAssetView((value) => !value || !useAppStore.getState().activeTabId);
            break;
        }
        return;
      }

      const key = event.key.toLowerCase();
      if (!withCmd) return;

      // 固定的应用级快捷键（不参与重绑）：标签序号、SFTP、AI 侧栏。
      if (/^[1-5]$/.test(key)) {
        event.preventDefault();
        event.stopPropagation();
        const tab = state.tabs[Number(key) - 1];
        if (tab) state.setActiveTab(tab.id);
      } else if (key === "s" && event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        const tab = state.tabs.find((item) => item.id === state.activeTabId);
        const pane = tab?.panes[tab.activePane];
        const profile = state.profiles.find((item) => item.id === pane?.profileId);
        if (tab && pane && profile?.protocol === "ssh") {
          state.updatePaneTools(tab.id, pane.key, { sftpHidden: !pane.sftpHidden });
          setDockerOpen(false);
          setAssetView(false);
        }
      } else if (key === "j" && event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        toggleAi();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toggleAi]);

  useEffect(() => {
    setAssetView(!activeTabId);
  }, [activeTabId]);

  const keyword = query.trim().toLowerCase();
  const protocolProfiles = profiles.filter((profile) => profile.protocol === proto);
  const favoritesCount = protocolProfiles.filter((profile) => favorites.includes(profile.id)).length;
  const recentCount = protocolProfiles.filter((profile) => recent.includes(profile.id)).length;
  const matchingProfiles = protocolProfiles.filter((profile) => matchesProfile(profile, keyword));
  const visibleProfiles = assetFilter === "recent"
    ? recent.flatMap((id) => matchingProfiles.filter((profile) => profile.id === id))
    : matchingProfiles.filter((profile) => assetFilter !== "favorites" || favorites.includes(profile.id));
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

  const isSshSession = activeProfile?.protocol === "ssh" && !!activePane;
  const sftpOpen = isSshSession && !activePane.sftpHidden && !dockerOpen;
  const monitorOpen = isSshSession && !activePane.monitorHidden;

  const notify = (message: string, kind: "info" | "error" = "info") => setNotice({ message, kind });
  const protoLabel =
    proto === "ssh"
      ? "SSH"
      : proto === "serial"
        ? "串口"
        : proto === "tunnel"
          ? "隧道"
          : proto === "telnet"
            ? "Telnet"
            : proto === "vnc"
              ? "VNC"
              : "RDP";

  const handleNew = () => {
    setEditing(null);
    setDialogOpen(true);
  };

  const handleEdit = (profile: Profile) => {
    setEditing(profile);
    setProto(profile.protocol);
    setDialogOpen(true);
  };

  // Windows 与 Linux 共用内嵌 RDP 会话，不再调用 mstsc.exe。
  const handleRdp = (profile: Profile) => {
    openProfileTab(profile);
  };

  const connectAsset = (profile: Profile) => {
    if (profile.protocol === "tunnel") setTunnelProfile(profile);
    else openProfileTab(profile);
  };

  const handleSplit = () => {
    if (!activeTab) {
      notify("先打开一个终端会话再分屏", "error");
      return;
    }
    const pane = activeTab.panes[activeTab.activePane];
    if (pane?.localShell) {
      openProfileInSplit(activeTab.id, pane.localShell);
      return;
    }
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

  /** 根据指针相对终端区的位置，判断落在哪条边（离边超过 30% 视为不分屏）。 */
  const dropZoneFor = (event: ReactDragEvent<HTMLDivElement>): DropZone | null => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const x = (event.clientX - rect.left) / Math.max(1, rect.width);
    const y = (event.clientY - rect.top) / Math.max(1, rect.height);
    const distances: Array<[DropZone, number]> = [
      ["left", x],
      ["right", 1 - x],
      ["top", y],
      ["bottom", 1 - y],
    ];
    distances.sort((a, b) => a[1] - b[1]);
    return distances[0][1] <= 0.3 ? distances[0][0] : null;
  };

  const handleStageDragOver = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!Array.from(event.dataTransfer.types).includes("application/x-fanssh-profile")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDropZone(dropZoneFor(event));
  };

  const handleStageLeave = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropZone(null);
  };

  const handleStageDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    const profileId = event.dataTransfer.getData("application/x-fanssh-profile");
    setDropZone(null);
    if (!profileId) return;
    event.preventDefault();
    const profile = profiles.find((item) => item.id === profileId);
    if (!profile) return;
    if (profile.protocol === "rdp" || profile.protocol === "tunnel") {
      notify("该协议不支持拖拽分屏，请双击连接", "error");
      return;
    }
    const zone = dropZoneFor(event);
    const tab = tabs.find((item) => item.id === activeTabId);
    if (!tab) {
      openProfileTab(profile);
      return;
    }
    openProfileInSplit(tab.id, profile, zone === "top" || zone === "bottom" ? "column" : "row");
  };

  /** 拖动分屏分隔条调整比例。 */
  const startSplitDrag = (
    event: ReactMouseEvent<HTMLDivElement>,
    tabId: string,
    direction: "row" | "column",
  ) => {
    event.preventDefault();
    const rect = (event.currentTarget.parentElement ?? event.currentTarget).getBoundingClientRect();
    const onMove = (move: MouseEvent) => {
      const ratio =
        direction === "column"
          ? (move.clientY - rect.top) / Math.max(1, rect.height)
          : (move.clientX - rect.left) / Math.max(1, rect.width);
      useAppStore.getState().setTabSplitRatio(tabId, ratio);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.classList.remove("is-resizing");
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    document.body.classList.add("is-resizing");
  };

  const handleSftpToggle = () => {
    if (!activeTab || !activePane || !isSshSession) {
      if (sftpProfileId) setSftpProfileId(null);
      else notify("先打开一个 SSH 会话再使用 SFTP", "error");
      return;
    }
    updatePaneTools(activeTab.id, activePane.key, { sftpHidden: assetView ? false : sftpOpen });
    setDockerOpen(false);
    setAssetView(false);
  };

  const handleDockerToggle = () => {
    if (dockerOpen) {
      setDockerOpen(false);
      return;
    }
    if (!isSshSession) {
      notify("先打开一个 SSH 会话再使用 Docker", "error");
      return;
    }
    setAssetView(false);
    setDockerOpen(true);
  };

  const handleMonitorToggle = () => {
    if (activeTab && activePane && isSshSession) {
      updatePaneTools(activeTab.id, activePane.key, { monitorHidden: monitorOpen });
    }
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
    <div className={`app-shell${!assetView && tabs.length > 0 ? " is-terminal-view" : ""}`}>
      <header className="titlebar">
        <div className="tb-icons">
          <button className="tb-slot" title="打开本地终端" onClick={() => openProfileTab("system")}>
            <Icon name="term" size={14} />
          </button>
          <button
            className={`tb-slot${assetView ? " is-active" : ""}`}
            title="资产管理 (Ctrl Shift B)"
            onClick={() => setAssetView(true)}
          >
            <Icon name="link" size={14} />
          </button>
          <button className="tb-slot" title="新建连接" onClick={handleNew}>
            <Icon name="plus" size={14} />
          </button>
          <button
            className={`tb-slot${(assetView ? sftpProfileId : sftpOpen) ? " is-active" : ""}`}
            title={(assetView ? sftpProfileId : sftpOpen) ? "关闭 SFTP (Ctrl Shift S)" : "打开 SFTP (Ctrl Shift S)"}
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
        <TabBar
          onActivate={() => setAssetView(false)}
          onOpenLocal={openProfileTab}
          platform={platform}
          onSplit={handleSplit}
          onToggleSftp={handleSftpToggle}
          onOpenSearch={focusConnectionSearch}
          onNew={handleNew}
          onManage={() => {
            setAssetView(true);
            setQuery("");
          }}
          onConnectProfile={connectAsset}
        />
        <div className="tb-right">
          <button className="tb-slot" title="搜索连接 (Ctrl Shift F)" onClick={focusConnectionSearch}>
            <Icon name="search" size={14} />
          </button>
          <span className="brand-ver">v{version}</span>
          <button className="tb-gear" title="设置 (Ctrl ,)" onClick={() => setSettingsOpen(true)}>
            <Icon name="gear" size={18} />
          </button>
        </div>
      </header>

      <div className="protobar">
        <div className="proto-tabs" role="tablist">
          {(["ssh", "rdp", "telnet", "tunnel", "vnc", "serial"] as Protocol[]).map((item) => (
            <button
              key={item}
              role="tab"
              aria-selected={proto === item}
              className={`proto-tab${proto === item ? " is-active" : ""}`}
              onClick={() => {
                setProto(item);
                setAssetView(true);
              }}
            >
              {item === "ssh"
                ? "SSH"
                : item === "serial"
                  ? "串口"
                  : item === "tunnel"
                    ? "隧道"
                    : item === "telnet"
                      ? "Telnet"
                      : item === "vnc"
                        ? "VNC"
                        : "RDP"}
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
        {assetView && assetTreeOpen && (
          <SessionSidebar
            proto={proto}
            onCollapse={() => setAssetTreeOpen(false)}
            onNew={handleNew}
            onEdit={handleEdit}
            onImport={handleImport}
            onExport={handleExport}
            onRdp={handleRdp}
            onOpenTunnel={setTunnelProfile}
            onNotice={notify}
            query={query}
            onClearSearch={() => setQuery("")}
            filter={assetFilter}
            onFilterChange={setAssetFilter}
            favoritesCount={favoritesCount}
            recentCount={recentCount}
          />
        )}

        {assetView && sftpProfile && (
          <SftpPanel
            key={sftpProfile.id}
            profileId={sftpProfile.id}
            profileName={sftpProfile.name}
            onClose={() => setSftpProfileId(null)}
          />
        )}

        <main className="workspace">
          {assetView && (
            <div className="connection-toolbar">
              {!assetTreeOpen && (
                <button className="btn-ghost sm" onClick={() => setAssetTreeOpen(true)}>展开目录</button>
              )}
              <span>{assetFilter === "favorites" ? "收藏" : assetFilter === "recent" ? "最近" : "全部"}</span>
              <div className="tb-quick">
                <Icon name="search" size={13} />
                <input
                  ref={quickSearchRef}
                  value={query}
                  placeholder="快速连接或搜索会话"
                  onChange={(event) => setQuery(event.target.value)}
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
              <div className="spacer" />
              <button className="icon-btn sm" title="刷新连接" onClick={() => void loadProfiles()}>
                <Icon name="refresh" size={14} />
              </button>
              <button className="btn-primary sm" title={`新建 ${protoLabel} 连接`} onClick={handleNew}>
                <Icon name="plus" size={14} />
              </button>
            </div>
          )}
          {assetView && (
            <section className="asset-list" aria-label={`${protoLabel} 连接`}>
              {visibleProfiles.length > 0 && (
                <table className="asset-table">
                  <thead>
                    <tr>
                      <th className="asset-star" aria-label="收藏" />
                      <th>名称</th>
                      <th>地址</th>
                      <th>分组</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleProfiles.map((profile) => (
                      <tr key={profile.id} onDoubleClick={() => connectAsset(profile)}>
                        <td className="asset-star" onDoubleClick={(event) => event.stopPropagation()}>
                          <button
                            className="icon-btn sm"
                            aria-pressed={favorites.includes(profile.id)}
                            aria-label={favorites.includes(profile.id) ? "取消收藏" : "收藏连接"}
                            onClick={() => toggleFavorite(profile.id)}
                          >
                            <Icon name="star" size={14} />
                          </button>
                        </td>
                        <td>{profile.name}</td>
                        <td>{profile.protocol === "serial"
                          ? profile.options.serial?.port
                          : profile.protocol === "tunnel"
                            ? `${profile.options.tunnel?.routes.length ?? 0} 条路由`
                            : `${profile.target.host}:${profile.target.port}`}</td>
                        <td>{profile.group || "未分组"}</td>
                        <td>
                          <div className="asset-actions" onDoubleClick={(event) => event.stopPropagation()}>
                            <button className="btn-primary sm" onClick={() => connectAsset(profile)}>
                              {profile.protocol === "tunnel" ? "打开" : "连接"}
                            </button>
                            <button className="btn-ghost sm" onClick={() => handleEdit(profile)}>编辑</button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {visibleProfiles.length === 0 && (
                <div className="stage-empty">
                  <div className="se-card">
                    <span className="se-logo"><Icon name="term" size={40} /></span>
                    <h2>{keyword ? "没有匹配的连接" : assetFilter === "favorites"
                      ? "暂无收藏" : assetFilter === "recent" ? "暂无最近连接" : `暂无${protoLabel}连接`}</h2>
                    {assetFilter === "all" && !keyword && (
                      <div className="se-actions">
                        <button className="btn-primary" onClick={handleNew}>+ 新建{protoLabel}连接</button>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </section>
          )}

          <div className={`workspace-body${assetView ? " is-hidden" : ""}`}>
            {tabs.flatMap((tab) => tab.panes.map((pane) => {
              const profile = profiles.find((item) => item.id === pane.profileId);
              if (profile?.protocol !== "ssh" || pane.sftpHidden || pane.status !== "ready" || !pane.sessionId) {
                return null;
              }
              return (
                <div className="session-sftp" key={pane.sessionId} hidden={!sftpOpen || pane !== activePane}>
                  <SftpPanel
                    profileId={profile.id}
                    profileName={profile.name}
                    sessionId={pane.sessionId}
                    onClose={() => updatePaneTools(tab.id, pane.key, { sftpHidden: true })}
                  />
                </div>
              );
            }))}

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

            <div
              className="stage"
              ref={stageRef}
              onDragOver={handleStageDragOver}
              onDragLeave={handleStageLeave}
              onDrop={handleStageDrop}
            >
              <div className="panes-host">
                {tabs.map((tab) => (
                  <div
                    key={tab.id}
                    className={`tab-panes direction-${tab.direction}${tab.id === activeTabId ? "" : " is-hidden"}`}
                  >
                    {tab.panes.map((pane, index) => {
                      const paneProfile = profiles.find((item) => item.id === pane.profileId);
                      const content =
                        paneProfile?.protocol === "vnc" ? (
                          <VncPane
                            tabId={tab.id}
                            pane={pane}
                            active={!assetView && tab.id === activeTabId && index === tab.activePane}
                          />
                        ) : paneProfile?.protocol === "rdp" ? (
                          <RdpPane
                            tabId={tab.id}
                            pane={pane}
                            active={!assetView && tab.id === activeTabId && index === tab.activePane}
                          />
                        ) : (
                          <TerminalPane
                            tabId={tab.id}
                            pane={pane}
                            active={!assetView && tab.id === activeTabId && index === tab.activePane}
                          />
                        );
                      return (
                        <Fragment key={pane.key}>
                          {index > 0 && (
                            <div
                              className={`pane-splitter splitter-${tab.direction}`}
                              role="separator"
                              aria-orientation={tab.direction === "row" ? "vertical" : "horizontal"}
                              onMouseDown={(event) => startSplitDrag(event, tab.id, tab.direction)}
                            />
                          )}
                          <div
                            className="pane-slot"
                            style={
                              tab.panes.length > 1 && index === 0
                                ? { flex: `0 0 ${(tab.splitRatio * 100).toFixed(2)}%` }
                                : undefined
                            }
                          >
                            {content}
                          </div>
                        </Fragment>
                      );
                    })}
                  </div>
                ))}

              </div>
              {dropZone && (
                <div className={`drop-zone zone-${dropZone}`}>
                  <span>
                    {dropZone === "top" || dropZone === "bottom"
                      ? "松手创建上下分屏"
                      : "松手创建左右分屏"}
                  </span>
                </div>
              )}
            </div>

            {monitorOpen && (
              <MonitorPanel
                profile={activeProfile}
                sessionId={
                  activeProfile?.protocol === "ssh" ? (activePane?.sessionId ?? null) : null
                }
                paneReady={activePane?.status === "ready"}
                enabled={activePane?.monitorEnabled ?? false}
                onEnable={() => {
                  if (activeTab && activePane) {
                    updatePaneTools(activeTab.id, activePane.key, { monitorEnabled: true });
                  }
                }}
                onClose={handleMonitorToggle}
              />
            )}
          </div>
        </main>

        <ActivityBar
          sftpOpen={sftpOpen}
          dockerOpen={dockerOpen}
          monitorOpen={monitorOpen}
          aiOpen={aiOpen}
          onToggleSftp={handleSftpToggle}
          onToggleDocker={handleDockerToggle}
          onToggleMonitor={handleMonitorToggle}
          onToggleAi={toggleAi}
        />

        <AiSidebar collapsed={assetView || !aiOpen} />
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
