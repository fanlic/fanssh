import type { AppearanceSettings } from "../types";

/** 20 个预设主题；Pro 只是角标视觉，全部默认可用。 */
export interface AppearancePreset {
  id: string;
  name: string;
  pro: boolean;
  dark: boolean;
  theme: string;
  background: string;
  nav: string;
}

export const APPEARANCE_PRESETS: AppearancePreset[] = [
  { id: "light", name: "明亮", pro: false, dark: false, theme: "#2f8f5b", background: "#f2f3f5", nav: "#e4e6e9" },
  { id: "dark", name: "暗夜", pro: false, dark: true, theme: "#3dbe71", background: "#141414", nav: "#313131" },
  { id: "vermilion", name: "朱红", pro: true, dark: true, theme: "#e0533f", background: "#1c1210", nav: "#2a1a17" },
  { id: "emerald", name: "翠绿", pro: true, dark: true, theme: "#2ecc71", background: "#101a14", nav: "#1a2a20" },
  { id: "silver", name: "银灰", pro: true, dark: true, theme: "#b9c2cc", background: "#191b1e", nav: "#2a2d31" },
  { id: "sky", name: "天蓝", pro: true, dark: true, theme: "#4aa8ff", background: "#0f1720", nav: "#182430" },
  { id: "gold", name: "金黄", pro: true, dark: true, theme: "#e0b341", background: "#1a1710", nav: "#2a2518" },
  { id: "amber", name: "橙黄", pro: true, dark: true, theme: "#f08a24", background: "#1b140d", nav: "#2b2014" },
  { id: "crimson", name: "艳红", pro: true, dark: true, theme: "#ff4d6a", background: "#1c1013", nav: "#2c171c" },
  { id: "pink", name: "粉红", pro: true, dark: true, theme: "#f472b6", background: "#1c1118", nav: "#2c1a26" },
  { id: "violet", name: "雅紫", pro: true, dark: true, theme: "#a78bfa", background: "#15111f", nav: "#231a33" },
  { id: "lake", name: "湖青", pro: true, dark: true, theme: "#22c3a6", background: "#0d1a19", nav: "#15292a" },
  { id: "navy", name: "深蓝", pro: true, dark: true, theme: "#5b8cff", background: "#0e1320", nav: "#171f33" },
  { id: "brown", name: "褐棕", pro: true, dark: true, theme: "#c08a5a", background: "#1a1510", nav: "#2a221a" },
  { id: "ink", name: "墨黑", pro: true, dark: true, theme: "#8a8f98", background: "#0b0b0c", nav: "#1a1a1c" },
  { id: "jade", name: "碧绿", pro: true, dark: true, theme: "#18b26b", background: "#0c1a13", nav: "#14291e" },
  { id: "scarlet", name: "赤红", pro: true, dark: true, theme: "#e63946", background: "#1b0e10", nav: "#2b1519" },
  { id: "indigo", name: "靛蓝", pro: true, dark: true, theme: "#4f46e5", background: "#111225", nav: "#1a1c3a" },
  { id: "tea", name: "茶褐", pro: true, dark: true, theme: "#b08968", background: "#17140f", nav: "#262019" },
  { id: "snow", name: "雪白", pro: true, dark: false, theme: "#2f8f5b", background: "#fafafa", nav: "#ececec" },
];

export const THEME_COLORS = [
  "#3dbe71",
  "#4aa8ff",
  "#e0533f",
  "#e0b341",
  "#a78bfa",
  "#f472b6",
  "#22c3a6",
  "#f08a24",
  "#b9c2cc",
];

export const BACKGROUND_COLORS = [
  "#141414",
  "#0f1720",
  "#1c1210",
  "#101a14",
  "#15111f",
  "#1b140d",
  "#191b1e",
  "#0d1a19",
  "#1a1510",
];

export function findPreset(id: string): AppearancePreset {
  return APPEARANCE_PRESETS.find((preset) => preset.id === id) ?? APPEARANCE_PRESETS[1];
}

export const DEFAULT_APPEARANCE: AppearanceSettings = {
  preset: "dark",
  theme_color: "#3dbe71",
  background_color: "#141414",
  nav_color: "#313131",
  follow_system: false,
  system_font: "default",
};

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function parseHex(hex: string): Rgb {
  const value = hex.replace("#", "").trim();
  const full =
    value.length === 3
      ? value
          .split("")
          .map((c) => c + c)
          .join("")
      : value.padEnd(6, "0").slice(0, 6);
  const num = Number.parseInt(full, 16);
  return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}

function toHex({ r, g, b }: Rgb): string {
  const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
  return `#${[clamp(r), clamp(g), clamp(b)].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}

/** amount > 0 变亮，< 0 变暗（按比例向黑/白混合）。 */
function shade(hex: string, amount: number): string {
  const { r, g, b } = parseHex(hex);
  const target = amount >= 0 ? 255 : 0;
  const weight = Math.abs(amount);
  return toHex({
    r: r + (target - r) * weight,
    g: g + (target - g) * weight,
    b: b + (target - b) * weight,
  });
}

function rgba(hex: string, alpha: number): string {
  const { r, g, b } = parseHex(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * 把外观设置写入 :root CSS 变量。
 * follow_system 开启时按系统深浅色选择面板明暗，但保留用户自定义的主题色。
 */
export function applyAppearance(appearance: AppearanceSettings, systemDark = true): void {
  const preset = findPreset(appearance.preset);
  const dark = appearance.follow_system ? systemDark : preset.dark;
  const background = appearance.background_color || preset.background;
  const nav = appearance.nav_color || preset.nav;
  const accent = appearance.theme_color || preset.theme;
  const root = document.documentElement;
  const set = (name: string, value: string) => root.style.setProperty(name, value);

  set("--bg", background);
  set("--panel", dark ? shade(background, 0.06) : shade(background, -0.04));
  set("--panel-soft", dark ? shade(background, 0.04) : shade(background, -0.02));
  set("--hover", dark ? shade(background, 0.1) : shade(background, -0.07));
  set("--input-bg", dark ? shade(background, 0.08) : shade(background, -0.03));
  set("--titlebar-bg", nav);

  set("--text", dark ? "#ffffff" : "#1d1f22");
  set("--text-dim", dark ? "rgba(255, 255, 255, 0.7)" : "rgba(20, 22, 25, 0.72)");
  set("--text-faint", dark ? "rgba(255, 255, 255, 0.45)" : "rgba(20, 22, 25, 0.5)");
  set("--border", dark ? "rgba(255, 255, 255, 0.15)" : "rgba(0, 0, 0, 0.14)");
  set("--border-strong", dark ? "#565656" : "#b7bbc1");

  set("--accent", accent);
  set("--accent-active", shade(accent, 0.12));
  set("--success", accent);
  set("--accent-weak", rgba(accent, 0.12));
  set("--accent-line", rgba(accent, 0.55));

  if (appearance.system_font && appearance.system_font !== "default") {
    set("--font-ui", appearance.system_font);
  } else {
    root.style.removeProperty("--font-ui");
  }
}
