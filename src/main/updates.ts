import { app, dialog, net } from "electron";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { appState } from "./state.js";

let autoUpdater: any = null;
if (process.platform === "win32") {
  try {
    ({ autoUpdater } = await import("electron-updater"));
  } catch (error: any) {
    console.warn("[Unleashed] Auto-updater unavailable:", error?.message);
  }
}

const UPDATE_REPO = "pcstyleorg/messenger-desktop";
const INSTALL_SCRIPT_URL =
  process.env.MU_INSTALL_SCRIPT_URL ||
  "https://raw.githubusercontent.com/pcstyleorg/messenger-desktop/main/install.sh";

let updateCheckInFlight = false;
let lastUpdateCheckWasSilent = true;
let windowsUpdaterReady = false;

function normalizeVersion(value: string) {
  return String(value || "")
    .trim()
    .replace(/^v/i, "")
    .split("-")[0];
}

function isNewerVersion(candidate: string, current: string) {
  const a = normalizeVersion(candidate).split(".").map(Number);
  const b = normalizeVersion(current).split(".").map(Number);
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i += 1) {
    const left = a[i] || 0;
    const right = b[i] || 0;
    if (left > right) return true;
    if (left < right) return false;
  }
  return false;
}

function requestText(url: string) {
  return new Promise<string>((resolve, reject) => {
    const request = net.request({
      method: "GET",
      url,
      headers: {
        "User-Agent": `${app.getName()} (${process.platform})`,
        Accept: "application/vnd.github+json",
      },
    });
    request.on("response", (response) => {
      let data = "";
      response.on("data", (chunk) => {
        data += chunk;
      });
      response.on("end", () => {
        if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) {
          resolve(data);
        } else {
          reject(
            new Error(
              `Request failed (${response.statusCode}) for ${url}`
            )
          );
        }
      });
    });
    request.on("error", reject);
    request.end();
  });
}

async function fetchLatestReleaseInfo() {
  const url = `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`;
  const payload = await requestText(url);
  const data = JSON.parse(payload);
  const version = data.tag_name || data.name || "";
  return {
    version: normalizeVersion(version),
    displayVersion: version || "",
    url: data.html_url || `https://github.com/${UPDATE_REPO}/releases`,
  };
}

function ensureWindowsAutoUpdater() {
  if (!autoUpdater || windowsUpdaterReady) return;
  windowsUpdaterReady = true;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("checking-for-update", () => {
    if (!lastUpdateCheckWasSilent) {
      console.log("[Unleashed] Checking for updates...");
    }
  });

  autoUpdater.on("update-available", (info: any) => {
    if (!lastUpdateCheckWasSilent && appState.mainWindow) {
      dialog.showMessageBox(appState.mainWindow, {
        type: "info",
        title: "Update Available",
        message: `Downloading version ${info?.version || ""}...`,
      });
    }
  });

  autoUpdater.on("update-not-available", () => {
    if (!lastUpdateCheckWasSilent && appState.mainWindow) {
      dialog.showMessageBox(appState.mainWindow, {
        type: "info",
        title: "No Updates",
        message: "You're already on the latest version.",
      });
    }
  });

  autoUpdater.on("error", (error: any) => {
    console.error("[Unleashed] Auto-update error:", error);
    if (!lastUpdateCheckWasSilent) {
      dialog.showErrorBox(
        "Update Error",
        error?.message || "Update failed."
      );
    }
  });

  autoUpdater.on("update-downloaded", () => {
    if (!appState.mainWindow) {
      autoUpdater.quitAndInstall();
      return;
    }
    dialog
      .showMessageBox(appState.mainWindow, {
        type: "info",
        title: "Update Ready",
        message: "Update downloaded. Restart to install?",
        buttons: ["Restart Now", "Later"],
        defaultId: 0,
      })
      .then(({ response }) => {
        if (response === 0) {
          autoUpdater.quitAndInstall();
        }
      });
  });
}

async function runMacInstallScript() {
  const script = await requestText(INSTALL_SCRIPT_URL);
  if (!script.trim().startsWith("#!")) {
    throw new Error("Installer script looks invalid.");
  }

  const tempDir = fs.mkdtempSync(
    path.join(app.getPath("temp"), "messenger-update-")
  );
  const scriptPath = path.join(tempDir, "install.sh");
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });

  const command = `/bin/bash "${scriptPath.replace(/"/g, '\\"')}"`;
  const osaScript = `do shell script ${JSON.stringify(
    command
  )} with administrator privileges`;

  const child = spawn("osascript", ["-e", osaScript], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  setTimeout(() => {
    app.quit();
  }, 1000);
}

async function checkForUpdatesMac({ silent }: { silent: boolean }) {
  if (process.platform !== "darwin") return;

  if (!app.isPackaged) {
    if (!silent && appState.mainWindow) {
      dialog.showMessageBox(appState.mainWindow, {
        type: "info",
        title: "Updates Disabled",
        message: "Auto-updates only work in packaged builds.",
      });
    }
    return;
  }

  try {
    const currentVersion = app.getVersion();
    const latest = await fetchLatestReleaseInfo();
    if (latest?.version && isNewerVersion(latest.version, currentVersion)) {
      if (!appState.mainWindow) return;
      const { response } = await dialog.showMessageBox(appState.mainWindow, {
        type: "info",
        title: "Update Available",
        message: `Version ${latest.displayVersion || latest.version} is available.`,
        detail:
          "The updater will download and install using the installer script, and the app will quit during install. You may be asked for your macOS password.",
        buttons: ["Install Update", "Later"],
        defaultId: 0,
      });
      if (response === 0) {
        await runMacInstallScript();
      }
    } else if (!silent && appState.mainWindow) {
      dialog.showMessageBox(appState.mainWindow, {
        type: "info",
        title: "No Updates",
        message: "You're already on the latest version.",
      });
    }
  } catch (error: any) {
    console.error("[Unleashed] Mac update check failed:", error);
    if (!silent) {
      dialog.showErrorBox(
        "Update Error",
        error?.message || "Update check failed."
      );
    }
  }
}

async function checkForUpdatesWindows({ silent }: { silent: boolean }) {
  if (process.platform !== "win32") return;
  if (!autoUpdater) {
    if (!silent) {
      dialog.showErrorBox(
        "Updater Missing",
        "Auto-updater is not available in this build."
      );
    }
    return;
  }

  if (!app.isPackaged) {
    if (!silent && appState.mainWindow) {
      dialog.showMessageBox(appState.mainWindow, {
        type: "info",
        title: "Updates Disabled",
        message: "Auto-updates only work in packaged builds.",
      });
    }
    return;
  }

  try {
    ensureWindowsAutoUpdater();
    await autoUpdater.checkForUpdates();
  } catch (error: any) {
    console.error("[Unleashed] Windows update check failed:", error);
    if (!silent) {
      dialog.showErrorBox(
        "Update Error",
        error?.message || "Update check failed."
      );
    }
  }
}

export async function checkForUpdates({ silent = true } = {}) {
  if (updateCheckInFlight) return;
  updateCheckInFlight = true;
  lastUpdateCheckWasSilent = !!silent;
  try {
    if (process.platform === "win32") {
      await checkForUpdatesWindows({ silent });
    } else if (process.platform === "darwin") {
      await checkForUpdatesMac({ silent });
    }
  } finally {
    updateCheckInFlight = false;
  }
}
