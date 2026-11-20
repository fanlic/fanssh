import { useEffect, useRef, useState } from "react";
import { useAppStore } from "../store";
import type { Profile } from "../types";
import { Icon } from "./Icon";

interface Props {
  onSplit: () => void;
  onOpenSearch: () => void;
  onNew: () => void;
  onManage: () => void;
  onConnectProfile: (profile: Profile) => void;
}

export function TabBar({ onSplit, onOpenSearch, onNew, onManage, onConnectProfile }: Props) {
  const tabs = useAppStore((s) => s.tabs);
  const activeTabId = useAppStore((s) => s.activeTabId);
  const profiles = useAppStore((s) => s.profiles);
  const recentProfileIds = useAppStore((s) => s.recentProfileIds);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const closeTab = useAppStore((s) => s.closeTab);
  const closePane = useAppStore((s) => s.closePane);
  const moveTab = useAppStore((s) => s.moveTab);
  const removeRecent = useAppStore((s) => s.removeRecent);
  const setSftpProfileId = useAppStore((s) => s.setSftpProfileId);
  const [menuOpen, setMenuOpen] = useState(false);
  const [leftOpen, setLeftOpen] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const leftRef = useRef<HTMLDivElement>(null);

  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  const activePane = activeTab?.panes[activeTab.activePane] ?? null;
  const activeProfile = profiles.find((profile) => profile.id === activePane?.profileId) ?? null;
  const recentProfiles = recentProfileIds
    .map((id) => profiles.find((profile) => profile.id === id))
    .filter((profile): profile is Profile => !!profile);

  useEffect(() => {
    if (!menuOpen && !leftOpen) return;
    const onDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
      if (!leftRef.current?.contains(event.target as Node)) setLeftOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [menuOpen, leftOpen]);

  return (
    <div className="tabbar">
      <div className="tab-menu-wrap" ref={leftRef}>
        <button
          className={`tab-menu-btn${leftOpen ? " is-on" : ""}`}
          title="标签与连接菜单"
          onClick={() => setLeftOpen((value) => !value)}
        >
          <Icon name="chev" size={12} />
        </button>
        {leftOpen && (
          <div className="tab-left-menu">
            <div className="menu-label">操作</div>
            <button
              className="menu-item"
              onClick={() => {
                setLeftOpen(false);
                onOpenSearch();
              }}
            >
              <Icon name="search" size={12} />
              <span className="mi-name">打开搜索</span>
              <kbd>Ctrl Shift F</kbd>
            </button>
            <button
              className="menu-item"
              onClick={() => {
                setLeftOpen(false);
                onNew();
              }}
            >
              <Icon name="plus" size={12} />
              <span className="mi-name">新建连接</span>
            </button>
            <button
              className="menu-item"
              onClick={() => {
                setLeftOpen(false);
                onManage();
              }}
            >
              <Icon name="gear" size={12} />
              <span className="mi-name">管理连接</span>
            </button>

            <div className="menu-sep" />
            <div className="menu-label">打开控制台</div>
            {tabs.length === 0 && <div className="menu-empty">暂无打开的会话</div>}
            {tabs.map((tab) => {
              const pane = tab.panes[tab.activePane] ?? tab.panes[0];
              return (
                <div
                  key={tab.id}
                  className={`menu-item menu-row${tab.id === activeTabId ? " is-active" : ""}`}
                  onClick={() => {
                    setActiveTab(tab.id);
                    setLeftOpen(false);
                  }}
                >
                  <span className={`dot st-${pane?.status ?? "idle"}`} />
                  <span className="mi-name">{tab.title}</span>
                  <span className="mi-meta">{tab.panes.length} 面板</span>
                  <button
                    className="mi-close"
                    title="关闭标签页"
                    onClick={(event) => {
                      event.stopPropagation();
                      closeTab(tab.id);
                    }}
                  >
                    <Icon name="x" size={9} />
                  </button>
                </div>
              );
            })}

            <div className="menu-sep" />
            <div className="menu-label">最近连接</div>
            {recentProfiles.length === 0 && <div className="menu-empty">还没有连接记录</div>}
            {recentProfiles.map((profile) => (
              <div
                key={profile.id}
                className="menu-item menu-row"
                title={`连接到 ${profile.name}`}
                onClick={() => {
                  setLeftOpen(false);
                  onConnectProfile(profile);
                }}
              >
                <span className={`s-icon ${profile.protocol}`}>
                  <Icon
                    name={
                      profile.protocol === "serial"
                        ? "plug"
                        : profile.protocol === "tunnel"
                          ? "transfer"
                          : "term"
                    }
                    size={11}
                  />
                </span>
                <span className="mi-name">{profile.name}</span>
                <button
                  className="mi-close"
                  title="从最近连接移除"
                  onClick={(event) => {
                    event.stopPropagation();
                    removeRecent(profile.id);
                  }}
                >
                  <Icon name="x" size={9} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="tabs">
        {tabs.map((tab) => {
          const pane = tab.panes[tab.activePane] ?? tab.panes[0];
          return (
            <div
              key={tab.id}
              className={`tab${tab.id === activeTabId ? " is-active" : ""}${
                dragId === tab.id ? " is-dragging" : ""
              }${overId === tab.id && dragId !== tab.id ? " is-drop-target" : ""}`}
              onClick={() => setActiveTab(tab.id)}
              title={tab.title}
              draggable
              onDragStart={(event) => {
                setDragId(tab.id);
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("application/x-fanssh-tab", tab.id);
              }}
              onDragOver={(event) => {
                if (!dragId || dragId === tab.id) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                setOverId(tab.id);
              }}
              onDrop={(event) => {
                const from = event.dataTransfer.getData("application/x-fanssh-tab") || dragId;
                setDragId(null);
                setOverId(null);
                if (!from) return;
                event.preventDefault();
                moveTab(from, tab.id);
              }}
              onDragEnd={() => {
                setDragId(null);
                setOverId(null);
              }}
            >
              <span className={`dot st-${pane?.status ?? "idle"}`} />
              <span className="tab-title">{tab.title}</span>
              {tab.panes.length > 1 && <span className="tab-count">{tab.panes.length}</span>}
              <button
                className="tab-close"
                title="关闭标签页"
                onClick={(event) => {
                  event.stopPropagation();
                  closeTab(tab.id);
                }}
              >
                <Icon name="x" size={10} />
              </button>
            </div>
          );
        })}
      </div>

      {activeTab && (
        <div className="tab-tools">
          {activeTab.panes.length > 1 && (
            <select
              className="pane-select"
              value={activeTab.activePane}
              onChange={(event) =>
                useAppStore.getState().setActivePane(activeTab.id, Number(event.target.value))
              }
            >
              {activeTab.panes.map((pane, index) => (
                <option key={pane.key} value={index}>
                  面板 {index + 1} · {pane.profileName}
                </option>
              ))}
            </select>
          )}
          <button className="icon-btn sm" title="分屏（再开一个面板）" onClick={onSplit}>
            <Icon name="split" size={14} />
          </button>
          {activeProfile?.protocol === "ssh" && (
            <button
              className="icon-btn sm"
              title="SFTP 文件传输"
              onClick={() => setSftpProfileId(activeProfile.id)}
            >
              <Icon name="transfer" size={14} />
            </button>
          )}
          <div className="menu-wrap" ref={menuRef}>
            <button
              className={`icon-btn sm${menuOpen ? " is-on" : ""}`}
              title="更多操作"
              onClick={() => setMenuOpen((value) => !value)}
            >
              <Icon name="more" size={14} />
            </button>
            {menuOpen && (
              <div className="tab-menu">
                <div className="menu-label">所有标签页</div>
                {tabs.map((tab) => (
                  <button
                    key={tab.id}
                    className={`menu-item${tab.id === activeTabId ? " is-active" : ""}`}
                    onClick={() => {
                      setActiveTab(tab.id);
                      setMenuOpen(false);
                    }}
                  >
                    <span className="mi-name">{tab.title}</span>
                    <span className="mi-meta">{tab.panes.length} 面板</span>
                  </button>
                ))}
                {activeTab.panes.length > 1 && (
                  <>
                    <div className="menu-sep" />
                    <button
                      className="menu-item danger"
                      onClick={() => {
                        closePane(activeTab.id, activePane!.key);
                        setMenuOpen(false);
                      }}
                    >
                      关闭当前面板
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
