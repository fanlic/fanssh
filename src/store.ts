import { create } from "zustand";
import { profileList } from "./api";
import type { Profile } from "./types";

/** 单个分屏面板的运行时状态。 */
export interface PaneState {
  key: string;
  profileId: string;
  profileName: string;
  sessionId: string | null;
  status: "connecting" | "ready" | "closed" | "error";
  statusText: string;
  /** 会话就绪后写入远端输入行、不自动回车的文本（Docker 进入容器用）。 */
  initialInput?: string;
}

/** 一个标签页可以容纳多个 pane，为分屏预留。 */
export interface TabState {
  id: string;
  title: string;
  panes: PaneState[];
  activePane: number;
  direction: "row" | "column";
  /** 第一个面板占可拖动区域的比例，0.15 ~ 0.85。 */
  splitRatio: number;
}

export interface TabStatePatch {
  title?: string;
}

let paneSeq = 0;

const AI_OPEN_KEY = "fanssh.ai-panel-open";
const RECENT_KEY = "fanssh.recent-connections";

/** 最近连接的 profile id，供标签栏下拉菜单使用。 */
function readRecent(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function writeRecent(ids: string[]): void {
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(ids.slice(0, 12)));
  } catch {
    // 隐私模式下写入失败不影响本次会话
  }
}

function pushRecent(ids: string[], id: string): string[] {
  const next = [id, ...ids.filter((item) => item !== id)].slice(0, 12);
  writeRecent(next);
  return next;
}

/** AI 面板折叠状态在刷新后保持；没有记录时默认折叠。 */
function readAiOpen(): boolean {
  try {
    return window.localStorage.getItem(AI_OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

function writeAiOpen(open: boolean): void {
  try {
    window.localStorage.setItem(AI_OPEN_KEY, open ? "1" : "0");
  } catch {
    // 隐私模式下写入失败不影响本次会话
  }
}

function newPane(profile: Profile): PaneState {
  paneSeq += 1;
  return {
    key: `pane-${Date.now().toString(36)}-${paneSeq}`,
    profileId: profile.id,
    profileName: profile.name,
    sessionId: null,
    status: "connecting",
    statusText: "连接中…",
  };
}

interface AppStore {
  profiles: Profile[];
  profilesLoading: boolean;
  profilesError: string | null;
  tabs: TabState[];
  activeTabId: string | null;
  sftpProfileId: string | null;
  aiOpen: boolean;
  recentProfileIds: string[];

  loadProfiles: () => Promise<void>;
  openProfileTab: (profile: Profile, initialInput?: string) => void;
  openProfileInSplit: (tabId: string, profile: Profile, direction?: "row" | "column") => void;
  closeTab: (tabId: string) => void;
  closePane: (tabId: string, paneKey: string) => void;
  moveTab: (fromId: string, toId: string) => void;
  setTabSplitRatio: (tabId: string, ratio: number) => void;
  removeRecent: (profileId: string) => void;
  setActiveTab: (tabId: string) => void;
  setActivePane: (tabId: string, index: number) => void;
  setPaneTitle: (tabId: string, paneKey: string, title: string) => void;
  setPaneStatus: (
    tabId: string,
    paneKey: string,
    status: PaneState["status"],
    statusText: string,
  ) => void;
  setPaneSession: (tabId: string, paneKey: string, sessionId: string) => void;
  setSftpProfileId: (id: string | null) => void;
  toggleAi: () => void;
}

export const useAppStore = create<AppStore>()((set, get) => ({
  profiles: [],
  profilesLoading: false,
  profilesError: null,
  tabs: [],
  activeTabId: null,
  sftpProfileId: null,
  aiOpen: readAiOpen(),
  recentProfileIds: readRecent(),

  loadProfiles: async () => {
    set({ profilesLoading: true, profilesError: null });
    try {
      const profiles = await profileList();
      set({ profiles, profilesLoading: false });
    } catch (error) {
      set({ profilesLoading: false, profilesError: String(error) });
    }
  },

  openProfileTab: (profile, initialInput) => {
    const pane = newPane(profile);
    if (initialInput) pane.initialInput = initialInput;
    const tab: TabState = {
      id: `tab-${Date.now().toString(36)}-${paneSeq}`,
      title: profile.name,
      panes: [pane],
      activePane: 0,
      direction: "row",
      splitRatio: 0.5,
    };
    set((state) => ({
      tabs: [...state.tabs, tab],
      activeTabId: tab.id,
      recentProfileIds: pushRecent(state.recentProfileIds, profile.id),
    }));
  },

  openProfileInSplit: (tabId, profile, direction = "row") => {
    const pane = newPane(profile);
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === tabId
          ? {
              ...tab,
              panes: [...tab.panes, pane],
              activePane: tab.panes.length,
              direction: tab.panes.length === 0 ? "row" : direction,
            }
          : tab,
      ),
      recentProfileIds: pushRecent(state.recentProfileIds, profile.id),
    }));
  },

  moveTab: (fromId, toId) => {
    if (fromId === toId) return;
    set((state) => {
      const from = state.tabs.findIndex((tab) => tab.id === fromId);
      const to = state.tabs.findIndex((tab) => tab.id === toId);
      if (from < 0 || to < 0) return {};
      const tabs = [...state.tabs];
      const [moved] = tabs.splice(from, 1);
      tabs.splice(to, 0, moved);
      return { tabs };
    });
  },

  setTabSplitRatio: (tabId, ratio) =>
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === tabId
          ? { ...tab, splitRatio: Math.min(0.85, Math.max(0.15, ratio)) }
          : tab,
      ),
    })),

  removeRecent: (profileId) =>
    set((state) => {
      const next = state.recentProfileIds.filter((id) => id !== profileId);
      writeRecent(next);
      return { recentProfileIds: next };
    }),

  closeTab: (tabId) => {
    set((state) => {
      const tabs = state.tabs.filter((tab) => tab.id !== tabId);
      const activeTabId =
        state.activeTabId === tabId ? (tabs.length > 0 ? tabs[tabs.length - 1].id : null) : state.activeTabId;
      return { tabs, activeTabId };
    });
  },

  closePane: (tabId, paneKey) => {
    const state = get();
    const tab = state.tabs.find((item) => item.id === tabId);
    if (!tab) return;
    if (tab.panes.length <= 1) {
      get().closeTab(tabId);
      return;
    }
    set({
      tabs: state.tabs.map((item) => {
        if (item.id !== tabId) return item;
        const panes = item.panes.filter((pane) => pane.key !== paneKey);
        const activePane = Math.max(0, Math.min(item.activePane, panes.length - 1));
        return { ...item, panes, activePane };
      }),
    });
  },

  setActiveTab: (tabId) => set({ activeTabId: tabId }),

  setActivePane: (tabId, index) =>
    set((state) => ({
      tabs: state.tabs.map((tab) => (tab.id === tabId ? { ...tab, activePane: index } : tab)),
    })),

  setPaneTitle: (tabId, paneKey, title) =>
    set((state) => ({
      tabs: state.tabs.map((tab) => {
        if (tab.id !== tabId) return tab;
        const panes = tab.panes.map((pane) =>
          pane.key === paneKey ? { ...pane, statusText: title } : pane,
        );
        const first = tab.panes[0];
        return {
          ...tab,
          panes,
          title: first && first.key === paneKey && title.trim() ? title.trim() : tab.title,
        };
      }),
    })),

  setPaneStatus: (tabId, paneKey, status, statusText) =>
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === tabId
          ? {
              ...tab,
              panes: tab.panes.map((pane) =>
                pane.key === paneKey ? { ...pane, status, statusText } : pane,
              ),
            }
          : tab,
      ),
    })),

  setPaneSession: (tabId, paneKey, sessionId) =>
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === tabId
          ? {
              ...tab,
              panes: tab.panes.map((pane) =>
                pane.key === paneKey ? { ...pane, sessionId } : pane,
              ),
            }
          : tab,
      ),
    })),

  setSftpProfileId: (id) => set({ sftpProfileId: id }),
  toggleAi: () =>
    set((state) => {
      const aiOpen = !state.aiOpen;
      writeAiOpen(aiOpen);
      return { aiOpen };
    }),
}));

/** 返回当前激活 pane（供 AI 侧栏定位终端）。 */
export function activePaneSelector(state: AppStore): PaneState | null {
  const tab = state.tabs.find((item) => item.id === state.activeTabId);
  if (!tab) return null;
  return tab.panes[tab.activePane] ?? tab.panes[0] ?? null;
}
