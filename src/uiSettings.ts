import { create } from "zustand";
import { uiSettingsGet, uiSettingsSave } from "./api";
import { DEFAULT_APPEARANCE } from "./lib/appearance";
import type {
  AppearanceSettings,
  ShortcutSettings,
  TerminalUiSettings,
  UiSettings,
} from "./types";

export const DEFAULT_TERMINAL: TerminalUiSettings = {
  font_family:
    '"Ubuntu", "Menlo", "Monaco", "Consolas", "Courier New", "Noto Sans Mono CJK SC", monospace',
  normal_weight: "normal",
  bold_weight: "bold",
  scrollback: 3000,
  font_size: 16,
  line_height: 1.0,
  letter_spacing: 0,
  cursor_blink: true,
  cursor_style: "bar",
  inactive_cursor_style: "none",
  quick_input: "floating",
  wheel_zoom: true,
  copy_on_select: false,
  right_click: "menu",
};

export const DEFAULT_SHORTCUTS: ShortcutSettings = {
  open_settings: "Ctrl+,",
  global_search: "Ctrl+Shift+F",
  next_tab: "Ctrl+Tab",
  prev_tab: "Ctrl+Shift+Tab",
  close_tab: "Ctrl+W",
  zoom_in: "Ctrl+=",
  zoom_out: "Ctrl+-",
  toggle_sidebar: "Ctrl+Shift+B",
};

export const DEFAULT_UI_SETTINGS: UiSettings = {
  appearance: DEFAULT_APPEARANCE,
  terminal: DEFAULT_TERMINAL,
  shortcuts: DEFAULT_SHORTCUTS,
};

interface UiSettingsStore {
  settings: UiSettings;
  loaded: boolean;
  error: string | null;
  load: () => Promise<void>;
  setAppearance: (patch: Partial<AppearanceSettings>) => void;
  setTerminal: (patch: Partial<TerminalUiSettings>) => void;
  setShortcuts: (patch: Partial<ShortcutSettings>) => void;
  resetAppearance: () => void;
  resetTerminal: () => void;
  resetShortcuts: () => void;
}

let saveTimer: number | undefined;
let loadPromise: Promise<void> | null = null;

function persist(settings: UiSettings, onError: (message: string | null) => void) {
  if (saveTimer) window.clearTimeout(saveTimer);
  // 设置页会连续改动多个字段，合并成一次写盘。
  saveTimer = window.setTimeout(() => {
    uiSettingsSave(settings)
      .then(() => onError(null))
      .catch(() => {
        // 浏览器预览或后端暂不可用时保留内存中的设置，不打断交互。
        onError("设置未能写入 settings.json");
      });
  }, 260);
}

export const useUiSettingsStore = create<UiSettingsStore>()((set, get) => ({
  settings: DEFAULT_UI_SETTINGS,
  loaded: false,
  error: null,

  load: async () => {
    if (get().loaded) return;
    if (!loadPromise) {
      loadPromise = uiSettingsGet()
        .then((settings) => {
          set({ settings, loaded: true, error: null });
        })
        .catch(() => {
          // 浏览器预览没有 Tauri 后端，使用默认值继续渲染。
          set({ loaded: true });
        })
        .finally(() => {
          loadPromise = null;
        });
    }
    await loadPromise;
  },

  setAppearance: (patch) => {
    const settings = {
      ...get().settings,
      appearance: { ...get().settings.appearance, ...patch },
    };
    set({ settings });
    persist(settings, (error) => set({ error }));
  },

  setTerminal: (patch) => {
    const settings = {
      ...get().settings,
      terminal: { ...get().settings.terminal, ...patch },
    };
    set({ settings });
    persist(settings, (error) => set({ error }));
  },

  setShortcuts: (patch) => {
    const settings = {
      ...get().settings,
      shortcuts: { ...get().settings.shortcuts, ...patch },
    };
    set({ settings });
    persist(settings, (error) => set({ error }));
  },

  resetAppearance: () => {
    const settings = { ...get().settings, appearance: DEFAULT_APPEARANCE };
    set({ settings });
    persist(settings, (error) => set({ error }));
  },

  resetTerminal: () => {
    const settings = { ...get().settings, terminal: DEFAULT_TERMINAL };
    set({ settings });
    persist(settings, (error) => set({ error }));
  },

  resetShortcuts: () => {
    const settings = { ...get().settings, shortcuts: DEFAULT_SHORTCUTS };
    set({ settings });
    persist(settings, (error) => set({ error }));
  },
}));
