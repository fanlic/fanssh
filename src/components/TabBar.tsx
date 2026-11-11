import { useAppStore } from "../store";

interface Props {
  onSplit: () => void;
}

export function TabBar({ onSplit }: Props) {
  const tabs = useAppStore((s) => s.tabs);
  const activeTabId = useAppStore((s) => s.activeTabId);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const closeTab = useAppStore((s) => s.closeTab);
  const closePane = useAppStore((s) => s.closePane);

  const activeTab = tabs.find((tab) => tab.id === activeTabId);

  return (
    <div className="tabbar">
      <div className="tabs">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`tab${tab.id === activeTabId ? " is-active" : ""}`}
            onClick={() => setActiveTab(tab.id)}
            title={tab.title}
          >
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
              ×
            </button>
          </div>
        ))}
      </div>
      {activeTab && (
        <div className="tab-actions">
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
          <button className="ghost small" onClick={onSplit} title="再开一个面板（分屏）">
            分屏
          </button>
          {activeTab.panes.length > 1 && (
            <button
              className="ghost small"
              onClick={() => {
                const pane = activeTab.panes[activeTab.activePane];
                if (pane) closePane(activeTab.id, pane.key);
              }}
            >
              关闭面板
            </button>
          )}
        </div>
      )}
    </div>
  );
}
