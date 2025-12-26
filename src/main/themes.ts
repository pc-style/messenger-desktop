import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import { appState, store } from "./state.js";

export const THEME_OPTIONS = [
  { id: "default", label: "Default" },
  { id: "oled", label: "OLED Dark" },
  { id: "nord", label: "Nord" },
  { id: "dracula", label: "Dracula" },
  { id: "solarized", label: "Solarized Dark" },
  { id: "highcontrast", label: "High Contrast" },
  { id: "alternative", label: "[EXP] Alternative Look" },
  { id: "crimson", label: "Crimson" },
  { id: "electriccrimson", label: "Electric Crimson" },
  { id: "neoncoral", label: "Neon Coral" },
  { id: "infernoorange", label: "Inferno Orange" },
  { id: "solargold", label: "Solar Gold" },
  { id: "acidlime", label: "Acid Lime" },
  { id: "emeraldflash", label: "Emerald Flash" },
  { id: "cyberteal", label: "Cyber Teal" },
  { id: "electricblue", label: "Electric Blue" },
  { id: "ultraviolet", label: "Ultraviolet" },
  { id: "hotmagenta", label: "Hot Magenta" },
  { id: "compact", label: "Compact Mode" },
];

export function getThemeCSS(theme: string) {
  if (theme === "default") return "";
  const themesPath = path.join(app.getAppPath(), "themes.css");
  const allCSS = fs.readFileSync(themesPath, "utf8");
  const themeRegex = new RegExp(
    `\\/\\* ${theme} \\*\\/([\\s\\S]*?)(?=\\/\\* \\w+ \\*\\/|$)`
  );
  const match = allCSS.match(themeRegex);
  return match ? match[1] : "";
}

export function applyThemeCSS(theme: string) {
  if (!appState.mainWindow) return;

  const css = getThemeCSS(theme);
  appState.mainWindow.webContents.removeInsertedCSS("theme").catch(() => {});

  if (css) {
    appState.mainWindow.webContents
      .insertCSS(css, { cssKey: "theme" } as any)
      .catch(() => {});
  }
}

export function applyAndroidBubbles() {
  if (!appState.mainWindow) return;
  const enabled = store.get("androidBubbles");
  appState.mainWindow.webContents
    .removeInsertedCSS("android-bubbles")
    .catch(() => {});
  if (!enabled) return;
  const css = getThemeCSS("androidbubbles");
  if (css) {
    appState.mainWindow.webContents
      .insertCSS(css, { cssKey: "android-bubbles" } as any)
      .catch(() => {});
  }
}
