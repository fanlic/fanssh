import { useEffect, useRef, useState } from "react";
import { useAppStore } from "../store";
import { Icon } from "./Icon";

interface Props {
  onSplit: () => void;
}

export function TabBar({ onSplit }: Props) {
  const tabs = useAppStore((s) => s.tabs);
  const activeTabId = useAppStore((s) => s.activeTabId);
  const profiles = useAppStore((s) => s.profiles);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const closeTab = useAppStore((s) => s.closeTab);
  const closePane = useAppStore((s) => s.closePane);
  const setSftpProfileId = useAppStore((s) => s.setSftpProfileId);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  const activePane = activeTab?.panes[activeTab.activePane] ?? null;
  const activeProfile = profiles.find((profile) => profile.id === activePane?.profileId) ?? null;

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  return (
    <div className="tabbar">
      <div className="tabs">
        {tabs.map((tab) => {
          const pane = tab.panes[tab.activePane] ?? tab.panes[0];
          return (
            <div
              key={tab.id}
              className={`tab${tab.id === activeTabId ? " is-active" : ""}`}
              onClick={() => setActiveTab(tab.id)}
              title={tab.title}
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
