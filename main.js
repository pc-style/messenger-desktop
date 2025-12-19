const {
  app,
  BrowserWindow,
  session,
  Menu,
  ipcMain,
  Notification,
  dialog,
  nativeImage,
  shell,
} = require("electron");
const path = require("path");
const fs = require("fs");
const { net } = require("electron");
const Store = require("electron-store");

const store = new Store({
  defaults: {
    alwaysOnTop: false,
    theme: "default",
    doNotDisturb: false,
    windowBounds: { width: 1200, height: 800 },
    launchAtLogin: false,
    focusMode: false,
    quickReplies: [
      { key: "1", text: "On my way!" },
      { key: "2", text: "Be right back" },
      { key: "3", text: "Sounds good!" },
    ],
    menuBarMode: false,
    blockReadReceipts: false,
    spellCheck: true,
    keywordAlerts: ["urgent", "asap"],
    keywordAlertsEnabled: true,
    clipboardSanitize: true,
    scheduleDelayMs: 30000,
    blockTypingIndicator: false,
    windowOpacity: 1.0,
    customCSS: "",
    modernLook: false,
    floatingGlass: false,
  },
});

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

let mainWindow = null;
let pipWindow = null;
let tray = null;
let unreadCount = 0;
let typingBlockerHandler = null;

// combine uploaded body buffers into string
function getRequestBody(details) {
  const { uploadData } = details;
  if (!uploadData || !uploadData.length) return "";
  try {
    return uploadData
      .map((part) => {
        if (part.bytes) {
          return Buffer.from(part.bytes).toString();
        }
        if (part.file) {
          try {
            return fs.readFileSync(part.file, "utf8");
          } catch (_) {
            return "";
          }
        }
        return "";
      })
      .join("");
  } catch (_) {
    return "";
  }
}

function isTypingIndicatorPayload(body) {
  if (!body || typeof body !== "string") return false;

  const tryJSON = (value) => {
    try {
      return JSON.parse(value);
    } catch (_) {
      return null;
    }
  };

  // URL-encoded GraphQL batch: queries=[{...}]
  const params = new URLSearchParams(body);
  if (params.has("is_typing")) {
    const v = params.get("is_typing");
    if (v === "true" || v === "1") return true;
  }
  if (params.has("typing")) {
    const v = params.get("typing");
    if (v === "true" || v === "1") return true;
  }
  if (params.has("queries")) {
    const parsed = tryJSON(params.get("queries"));
    if (Array.isArray(parsed)) {
      const hit = parsed.some((entry) => {
        const vars = entry?.variables || entry?.params?.variables;
        return vars?.is_typing === true || vars?.typing === true;
      });
      if (hit) return true;
    }
  }

  // raw JSON (GraphQL or REST)
  const json = tryJSON(body);
  if (json) {
    if (Array.isArray(json)) {
      if (
        json.some(
          (item) =>
            item?.variables?.is_typing === true ||
            item?.variables?.typing === true
        )
      )
        return true;
    } else if (
      json.variables?.is_typing === true ||
      json.is_typing === true ||
      json.typing === true
    ) {
      return true;
    }
  }

  return false;
}

// URL patterns for blocking read receipts
const READ_RECEIPT_URL_PATTERNS = [
  /\/ajax\/mercury\/change_read_status\.php/i,
  /\/ajax\/mercury\/mark_seen\.php/i,
  /\/ajax\/mercury\/delivery_receipts\.php/i,
  /\/webgraphql\/mutation.*MarkThreadRead/i,
  /\/graphql.*mark.*read/i,
  /\/graphql.*mark.*seen/i,
];

// URL patterns for blocking typing indicators
const TYPING_URL_PATTERNS = [
  /\/ajax\/messaging\/typ\.php/i,
  /\/ajax\/mercury\/type\.php/i,
  /\/ajax\/mercury\/send_message_typing\.php/i,
  /\/webgraphql\/mutation.*SendTypingIndicator/i,
  /\/graphql.*typing/i,
  /-edge-chat\.facebook\.com/i,
  /-edge-chat\.messenger\.com/i,
];

// Global request blocker handler
let requestBlockerHandler = null;

function shouldBlockReadReceipt(url, body) {
  // Check URL patterns first (most reliable)
  for (const pattern of READ_RECEIPT_URL_PATTERNS) {
    if (pattern.test(url)) return true;
  }
  
  // Check body for GraphQL mutations related to read status
  if (body) {
    const lower = body.toLowerCase();
    if (
      (lower.includes("markread") || lower.includes("mark_read") || lower.includes("markseen") || lower.includes("mark_seen")) &&
      (lower.includes("mutation") || lower.includes("graphql") || lower.includes("thread"))
    ) {
      return true;
    }
  }
  
  return false;
}

function shouldBlockTyping(url, body) {
  // Check URL patterns first (most reliable)
  for (const pattern of TYPING_URL_PATTERNS) {
    if (pattern.test(url)) return true;
  }
  
  // Also check body for typing-related data
  if (body) {
    // Check if payload contains typing indicators
    if (isTypingIndicatorPayload(body)) return true;
  }
  
  return false;
}

function updateRequestBlocker() {
  const blockReadReceipts = store.get("blockReadReceipts");
  const blockTypingIndicator = store.get("blockTypingIndicator");
  
  const filter = {
    urls: [
      "https://*.messenger.com/*",
      "https://*.facebook.com/*",
      "https://*-edge-chat.facebook.com/*",
      "https://*-edge-chat.messenger.com/*",
    ],
  };

  // Remove existing handler if any
  if (requestBlockerHandler) {
    try {
      session.defaultSession.webRequest.onBeforeRequest(filter, null);
    } catch (_) {}
    requestBlockerHandler = null;
  }

  // Only install handler if at least one blocking feature is enabled
  if (blockReadReceipts || blockTypingIndicator) {
    requestBlockerHandler = (details, callback) => {
      const url = details.url || "";
      const body = details.method === "POST" ? getRequestBody(details) : "";
      
      // Check read receipts blocking
      if (blockReadReceipts && shouldBlockReadReceipt(url, body)) {
        console.log("[Unleashed] Blocked read receipt:", url.slice(0, 100));
        return callback({ cancel: true });
      }
      
      // Check typing indicator blocking
      if (blockTypingIndicator && shouldBlockTyping(url, body)) {
        console.log("[Unleashed] Blocked typing indicator:", url.slice(0, 100));
        return callback({ cancel: true });
      }
      
      return callback({});
    };
    
    session.defaultSession.webRequest.onBeforeRequest(filter, requestBlockerHandler);
  }
}

// Legacy function kept for compatibility, now delegates to unified handler
function updateTypingBlocker(enabled) {
  store.set("blockTypingIndicator", enabled);
  updateRequestBlocker();
}

function escapeHTML(value) {
  return (value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isSafeCSS(css) {
  const dangerous =
    /<script|javascript:|expression\s*\(|@import\s+url|behavior\s*:/i;
  return !dangerous.test(css);
}

async function openInputDialog({
  title,
  message,
  defaultValue = "",
  multiline = false,
}) {
  return new Promise((resolve) => {
    const channel = `dialog-result-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}`;

    const inputWindow = new BrowserWindow({
      width: 420,
      height: multiline ? 320 : 220,
      parent: mainWindow || undefined,
      modal: !!mainWindow,
      show: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, "dialog-preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        additionalArguments: [`--dialog-channel=${channel}`],
      },
    });

    const html = `<!DOCTYPE html>
      <html>
      <head>
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline';" />
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; padding: 16px; background: #1e1e1e; color: #f0f0f0; }
          h3 { margin: 0 0 8px 0; font-size: 16px; }
          p { margin: 0 0 12px 0; font-size: 13px; color: #b0b0b0; }
          input, textarea { width: 100%; padding: 10px; box-sizing: border-box; border-radius: 6px; border: 1px solid #3a3a3a; background: #2a2a2a; color: #fff; font-size: 13px; }
          textarea { height: 140px; resize: vertical; }
          .buttons { margin-top: 14px; text-align: right; }
          button { padding: 8px 14px; margin-left: 8px; border: none; border-radius: 6px; cursor: pointer; font-size: 13px; }
          .cancel { background: #444; color: #fff; }
          .ok { background: #0084ff; color: #fff; }
        </style>
      </head>
      <body>
        <h3>${escapeHTML(title || "Input")}</h3>
        <p>${escapeHTML(message || "Enter a value:")}</p>
        ${
          multiline
            ? `<textarea id="input">${escapeHTML(defaultValue)}</textarea>`
            : `<input type="text" id="input" value="${escapeHTML(
                defaultValue
              )}" />`
        }
        <div class="buttons">
          <button class="cancel" onclick="window.dialogAPI.cancel()">Cancel</button>
          <button class="ok" onclick="window.dialogAPI.submit(document.getElementById('input').value)">OK</button>
        </div>
        <script>
          const input = document.getElementById('input');
          input.focus();
          input.select();
          input.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') window.dialogAPI.cancel();
            if (!${multiline} && e.key === 'Enter') window.dialogAPI.submit(input.value);
          });
        </script>
      </body>
      </html>`;

    ipcMain.once(channel, (_, value) => {
      if (!inputWindow.isDestroyed()) inputWindow.close();
      resolve(value ?? null);
    });

    inputWindow.on("closed", () => {
      resolve(null);
    });

    inputWindow.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
    );

    inputWindow.once("ready-to-show", () => {
      inputWindow.show();
    });
  });
}

// get platform-appropriate icon path
function getIconPath() {
  const iconName =
    process.platform === "win32"
      ? "icon.ico"
      : process.platform === "darwin"
      ? "icon.icns"
      : "icon.png";
  const iconPath = path.join(__dirname, iconName);
  if (fs.existsSync(iconPath)) return iconPath;
  // fallback to any available icon
  for (const ext of ["png", "ico", "icns"]) {
    const fallback = path.join(__dirname, `icon.${ext}`);
    if (fs.existsSync(fallback)) return fallback;
  }
  return null;
}

// handle native notifications from renderer
ipcMain.on("show-notification", (event, data) => {
  if (store.get("doNotDisturb")) return;

  const iconPath = getIconPath();
  const notification = new Notification({
    title: data.title || "Messenger",
    body: data.body || "",
    silent: data.silent || false,
    ...(iconPath && { icon: iconPath }),
  });

  notification.on("click", () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
    event.sender.send("notification-clicked");
  });

  notification.show();
});

// IPC handlers for dialogs (replacing prompt()) - backed by sandboxed modal window
ipcMain.handle(
  "show-input-dialog",
  async (event, { title, message, defaultValue, multiline = false }) => {
    return openInputDialog({ title, message, defaultValue, multiline });
  }
);

// IPC handler for CSS validation and application
ipcMain.handle("validate-css", (event, css) => {
  // basic CSS validation - check for script injection attempts
  if (!isSafeCSS(css)) {
    return {
      valid: false,
      error: "CSS contains potentially dangerous content",
    };
  }
  return { valid: true };
});

function getThemeCSS(theme) {
  const themesPath = path.join(__dirname, "themes.css");
  const allCSS = fs.readFileSync(themesPath, "utf8");

  if (theme === "default") return "";

  const themeRegex = new RegExp(
    `\\/\\* ${theme} \\*\\/([\\s\\S]*?)(?=\\/\\* \\w+ \\*\\/|$)`
  );
  const match = allCSS.match(themeRegex);
  return match ? match[1] : "";
}

function applyThemeCSS(theme) {
  if (!mainWindow) return;

  const css = getThemeCSS(theme);
  mainWindow.webContents.removeInsertedCSS("theme").catch(() => {});

  if (css) {
    mainWindow.webContents.insertCSS(css, { cssKey: "theme" }).catch(() => {});
  }
}

function applyTheme(theme) {
  if (!mainWindow) return;

  store.set("theme", theme);
  updateMenu();

  mainWindow.webContents.reloadIgnoringCache();
}

function toggleAlwaysOnTop() {
  const current = store.get("alwaysOnTop");
  store.set("alwaysOnTop", !current);
  mainWindow.setAlwaysOnTop(!current);
  updateMenu();
}

function toggleDoNotDisturb() {
  const current = store.get("doNotDisturb");
  store.set("doNotDisturb", !current);
  updateMenu();
}

function toggleLaunchAtLogin() {
  const current = store.get("launchAtLogin");
  const newValue = !current;

  const canSetLogin =
    process.platform !== "darwin" ||
    (app.isInApplicationsFolder && app.isInApplicationsFolder());

  if (canSetLogin) {
    try {
      app.setLoginItemSettings({
        openAtLogin: newValue,
        openAsHidden: false,
      });
    } catch (err) {
      console.warn("Failed to set login item", err);
    }
  }

  store.set("launchAtLogin", newValue);
  updateMenu();
}

function toggleFocusMode() {
  const current = store.get("focusMode");
  const newValue = !current;
  store.set("focusMode", newValue);

  if (!mainWindow) return;

  if (newValue) {
    mainWindow.webContents.insertCSS(
      `
      div[aria-label="Chats"],
      div[role="navigation"] { display: none !important; }
      div[role="main"] { width: 100% !important; max-width: 100% !important; }
    `,
      { cssKey: "focus-mode" }
    );
  } else {
    mainWindow.webContents.reloadIgnoringCache();
  }

  updateMenu();
}

function reloadMessenger() {
  if (!mainWindow) return;
  mainWindow.webContents.reloadIgnoringCache();
}

// modern text insertion using InputEvent instead of deprecated execCommand
function sendQuickReply(text) {
  if (!mainWindow) return;
  mainWindow.webContents.executeJavaScript(`
    (function() {
      const input = document.querySelector('[contenteditable="true"][role="textbox"]');
      if (!input) return false;
      input.focus();

      // use modern InputEvent API instead of deprecated execCommand
      const selection = window.getSelection();
      let range;
      if (selection.rangeCount > 0) {
        range = selection.getRangeAt(0);
      } else {
        range = document.createRange();
        range.selectNodeContents(input);
        range.collapse(false);
      }
      range.deleteContents();
      const textNode = document.createTextNode(${JSON.stringify(text)});
      range.insertNode(textNode);
      range.setStartAfter(textNode);
      range.setEndAfter(textNode);
      selection.removeAllRanges();
      selection.addRange(range);

      // dispatch input event to trigger React state update
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(
        text
      )} }));

      // simulate Enter key
      const enterEvent = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true });
      input.dispatchEvent(enterEvent);
      return true;
    })()
  `);
}

function toggleMenuBarMode() {
  const current = store.get("menuBarMode");
  const newValue = !current;
  store.set("menuBarMode", newValue);

  if (newValue) {
    const success = createTray();
    if (success && mainWindow) {
      mainWindow.setSkipTaskbar(true);
      mainWindow.hide();
      if (process.platform === "darwin" && app.dock) app.dock.hide();
    }
    if (!success) {
      store.set("menuBarMode", false);
      dialog.showErrorBox("Menu Bar Mode", "Failed to create tray icon.");
    }
  } else {
    if (tray) {
      tray.destroy();
      tray = null;
    }
    if (mainWindow) {
      mainWindow.setSkipTaskbar(false);
      mainWindow.show();
      mainWindow.focus();
    }
    if (process.platform === "darwin" && app.dock) app.dock.show();
  }

  updateMenu();
}

function createTray() {
  if (tray) return true;

  const { Tray } = require("electron");

  try {
    // prefer the pre-sized tray PNG, fall back to platform-specific icon
    let iconPath = path.join(__dirname, "trayIcon.png");
    if (!fs.existsSync(iconPath)) {
      iconPath = getIconPath();
    }

    if (!iconPath || !fs.existsSync(iconPath)) {
      console.error("No icon file found for tray");
      return false;
    }

    const trayIcon = nativeImage.createFromPath(iconPath);
    if (trayIcon.isEmpty()) {
      console.error("Failed to load tray icon from:", iconPath);
      return false;
    }

    const resized = trayIcon.resize({ width: 16, height: 16 });
    if (process.platform === "darwin") resized.setTemplateImage(true);

    tray = new Tray(resized);
    tray.setToolTip("Messenger Unleashed");
    if (tray.setTitle) tray.setTitle(unreadCount > 0 ? ` ${unreadCount}` : "");

    tray.on("click", () => {
      if (mainWindow) {
        if (mainWindow.isVisible()) {
          mainWindow.hide();
          if (process.platform === "darwin" && app.dock) app.dock.hide();
        } else {
          mainWindow.show();
          mainWindow.focus();
          if (process.platform === "darwin" && app.dock) app.dock.show();
        }
      }
    });

    tray.on("right-click", () => {
      if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
        if (process.platform === "darwin" && app.dock) app.dock.show();
      }
    });

    return true;
  } catch (err) {
    console.error("Failed to create tray:", err);
    return false;
  }
}

function toggleBlockReadReceipts() {
  const current = store.get("blockReadReceipts");
  const newValue = !current;
  store.set("blockReadReceipts", newValue);

  if (!mainWindow) return;

  // Update the unified request blocker
  updateRequestBlocker();

  // notify preload to update visibility blocking state (additional layer)
  mainWindow.webContents.send("set-block-read-receipts", newValue);

  if (!newValue) {
    // reload to restore normal behavior
    mainWindow.webContents.reload();
  }

  updateMenu();
}

function focusSearch() {
  if (!mainWindow) return;
  mainWindow.webContents
    .executeJavaScript(
      `
    (function() {
      const search = document.querySelector('input[aria-label="Search Messenger"], input[placeholder*="Search"], input[type="search"]');
      if (!search) return false;
      search.focus();
      if (search.select) search.select();
      return true;
    })()
  `
    )
    .catch(() => {});
}

function setScheduleDelay(delayMs) {
  store.set("scheduleDelayMs", delayMs);
  pushRendererConfig();
  updateMenu();
}

function scheduleSendNow() {
  if (!mainWindow) return;
  const delay = store.get("scheduleDelayMs");
  mainWindow.webContents.send("schedule-send", delay);
}

function toggleClipboardSanitize() {
  const next = !store.get("clipboardSanitize");
  store.set("clipboardSanitize", next);
  pushRendererConfig();
  updateMenu();
}

function toggleKeywordAlerts() {
  const next = !store.get("keywordAlertsEnabled");
  store.set("keywordAlertsEnabled", next);
  pushRendererConfig();
  updateMenu();
}

// use IPC dialog instead of prompt()
async function editKeywordAlerts() {
  if (!mainWindow) return;
  const existing = store.get("keywordAlerts").join(", ");

  const value = await openInputDialog({
    title: "Keyword Alerts",
    message: "Enter keywords (comma separated):",
    defaultValue: existing,
  });

  if (typeof value === "string") {
    const list = value
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean);
    store.set("keywordAlerts", list);
    pushRendererConfig();
    updateMenu();
  }
}

// (legacy channel preserved for renderer modal use)
ipcMain.on("keyword-input-result", (event, result) => {
  if (typeof result !== "string") return;
  const list = result
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
  store.set("keywordAlerts", list);
  pushRendererConfig();
  updateMenu();
});

function pushRendererConfig() {
  if (!mainWindow) return;
  const config = {
    keywordAlerts: store.get("keywordAlerts"),
    keywordAlertsEnabled: store.get("keywordAlertsEnabled"),
    clipboardSanitize: store.get("clipboardSanitize"),
    scheduleDelayMs: store.get("scheduleDelayMs"),
    blockTypingIndicator: store.get("blockTypingIndicator"),
  };

  mainWindow.webContents.send("update-config", config);
}

function updateUnreadBadge(count) {
  unreadCount = count;
  if (process.platform === "darwin" && app.dock) {
    app.dock.setBadge(count > 0 ? String(count) : "");
  }
  if (tray && tray.setTitle) {
    tray.setTitle(count > 0 ? ` ${count}` : "");
  }
}

function toggleSpellCheck() {
  const current = store.get("spellCheck");
  const newValue = !current;
  store.set("spellCheck", newValue);

  dialog.showMessageBox(mainWindow, {
    type: "info",
    title: "Restart Required",
    message: "Please restart the app for spell check changes to take effect.",
    buttons: ["OK"],
  });

  updateMenu();
}

function toggleBlockTypingIndicator() {
  const current = store.get("blockTypingIndicator");
  const newValue = !current;
  store.set("blockTypingIndicator", newValue);
  
  // Update the unified request blocker
  updateRequestBlocker();

  if (!mainWindow) return;

  // notify preload to update typing indicator blocking
  mainWindow.webContents.send("set-block-typing-indicator", newValue);

  if (!newValue) {
    mainWindow.webContents.reload();
  }

  updateMenu();
}

function setWindowOpacity(opacity) {
  store.set("windowOpacity", opacity);
  if (mainWindow) {
    mainWindow.setOpacity(opacity);
  }
  updateMenu();
}

function navigateConversation(direction) {
  if (!mainWindow) return;
  mainWindow.webContents
    .executeJavaScript(
      `
    (function() {
      // Prioritize the actual chat list. Messenger usually labels it "Chats" or "Conversations".
      // We explicitly avoid selecting the main navigation sidebar (which often has role="navigation").
      const chatList = document.querySelector('div[aria-label="Chats"]') ||
                       document.querySelector('div[aria-label="Conversations"]') ||
                       document.querySelector('div[role="grid"][aria-label]') ||
                       document.querySelector('div[role="main"] div[role="grid"]') ||
                       document.querySelector('div[role="navigation"] + div div[role="grid"]'); // Often the layout is [Nav] [ChatList] [Main]
      
      if (!chatList) return;

      // Only select links that are actually threads (/t/) or identified as chat rows.
      // We want to avoid catching the sidebar tabs (which are often also role="gridcell").
      const rows = Array.from(chatList.querySelectorAll('a[href*="/t/"], div[role="row"] a, div[role="gridcell"] a[href*="/t/"]'));
      if (!rows.length) return;

      const active = document.querySelector('a[aria-current="page"]') ||
                     document.querySelector('a[aria-selected="true"]') ||
                     document.querySelector('[role="row"][aria-selected="true"]') ||
                     document.querySelector('[role="gridcell"][aria-selected="true"]') ||
                     document.activeElement;
      let currentIdx = rows.findIndex(r => 
        r.contains(active) || 
        r === active || 
        r.getAttribute('aria-current') === 'page' ||
        r.getAttribute('aria-selected') === 'true'
      );

      if (currentIdx === -1) {
        currentIdx = ${direction === "up" ? "rows.length" : "-1"};
      }

      const nextIdx = ${
        direction === "up"
          ? "Math.max(0, currentIdx - 1)"
          : "Math.min(rows.length - 1, currentIdx + 1)"
      };
      const target = rows[nextIdx];
      if (target) {
        target.click();
        target.focus();
      }
    })()
  `
    )
    .catch(() => {});
}

// use IPC dialog instead of prompt() for CSS editing
async function editCustomCSS() {
  if (!mainWindow) return;
  const existing = store.get("customCSS");

  // show dialog to confirm editing
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: "question",
    title: "Custom CSS",
    message: "Edit custom CSS styling?",
    detail: existing
      ? `Current CSS:\n${existing.slice(0, 200)}${
          existing.length > 200 ? "..." : ""
        }`
      : "No custom CSS set.",
    buttons: ["Cancel", "Edit", "Clear"],
    defaultId: 1,
  });

  if (response === 2) {
    // clear
    clearCustomCSS();
  } else if (response === 1) {
    const css = await openInputDialog({
      title: "Custom CSS",
      message: "Enter CSS rules:",
      defaultValue: existing,
      multiline: true,
    });

    if (typeof css === "string") {
      if (!isSafeCSS(css)) {
        dialog.showErrorBox(
          "Invalid CSS",
          "The CSS contains potentially dangerous content and was rejected."
        );
        return;
      }
      store.set("customCSS", css);
      applyCustomCSS();
    }
  }
}

async function checkForUpdates() {
  const CURRENT_VERSION = app.getVersion();
  const VERSION_URL =
    "https://raw.githubusercontent.com/pcstyleorg/messenger-desktop/main/.version";

  try {
    const request = net.request(VERSION_URL);
    request.on("response", (response) => {
      let data = "";
      response.on("data", (chunk) => {
        data += chunk;
      });
      response.on("end", () => {
        const latestVersion = data.trim();
        const normalize = (v) => v.replace(/^v/, "");
        const normalizedLatest = normalize(latestVersion);
        const normalizedCurrent = normalize(CURRENT_VERSION);

        if (
          latestVersion &&
          normalizedLatest !== normalizedCurrent &&
          !latestVersion.startsWith("<!DOCTYPE")
        ) {
          dialog
            .showMessageBox(mainWindow, {
              type: "info",
              title: "Update Available",
              message: `A new version (${latestVersion}) is available. Your current version is ${CURRENT_VERSION}.`,
              buttons: ["Download and Update", "Later"],
              defaultId: 0,
            })
            .then(({ response }) => {
              if (response === 0) {
                shell.openExternal(
                  "https://github.com/pcstyleorg/messenger-desktop/releases"
                );
              }
            });
        }
        // Save local .version file
        const versionPath = path.join(app.getPath("userData"), ".version");
        fs.writeFileSync(versionPath, latestVersion || CURRENT_VERSION);
      });
    });
    request.on("error", (err) => {
      console.error("Update check failed:", err);
    });
    request.end();
  } catch (err) {
    console.error("Update check request error:", err);
  }
}

function applyModernLook() {
  if (!mainWindow) return;
  const enabled = store.get("modernLook");
  mainWindow.webContents.removeInsertedCSS("modern-look").catch(() => {});

  if (enabled) {
    // Premium modern look with glassmorphism floating panels
    const modernCSS = `
      :root {
        --modern-radius: 20px !important;
        --modern-spacing: 10px !important;
        --modern-bg: rgba(24, 24, 27, 0.85) !important;
        --modern-border: rgba(255, 255, 255, 0.08) !important;
        --modern-shadow: 0 8px 32px rgba(0, 0, 0, 0.4), 0 2px 8px rgba(0, 0, 0, 0.3) !important;
        --modern-glow: 0 0 40px rgba(99, 102, 241, 0.15) !important;
      }
      
      /* Global dark canvas */
      html {
        background: linear-gradient(135deg, #0a0a0f 0%, #111118 50%, #0d0d14 100%) !important;
      }
      
      body {
        background: transparent !important;
        padding: var(--modern-spacing) !important;
        min-height: 100vh !important;
      }

      /* Main container wrapper */
      body > div:first-child,
      #root,
      div[role="main"].__fb-light-mode,
      div.__fb-light-mode {
        background: transparent !important;
      }

      /* Left icon sidebar - floating pill */
      div[role="navigation"]:first-of-type,
      div[aria-label="Messenger"] > div > div:first-child {
        background: var(--modern-bg) !important;
        backdrop-filter: blur(20px) saturate(180%) !important;
        -webkit-backdrop-filter: blur(20px) saturate(180%) !important;
        border-radius: var(--modern-radius) !important;
        margin: var(--modern-spacing) !important;
        margin-right: 0 !important;
        border: 1px solid var(--modern-border) !important;
        box-shadow: var(--modern-shadow) !important;
        overflow: hidden !important;
      }

      /* Sidebar icons styling */
      div[role="navigation"] a,
      div[role="navigation"] div[role="button"] {
        border-radius: 14px !important;
        margin: 6px 8px !important;
        transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1) !important;
      }
      
      div[role="navigation"] a:hover,
      div[role="navigation"] div[role="button"]:hover {
        background: rgba(255, 255, 255, 0.1) !important;
        transform: scale(1.05) !important;
      }

      /* Chat list panel - floating card */
      div[aria-label="Chats"],
      div[aria-label="Chats"] > div {
        background: var(--modern-bg) !important;
        backdrop-filter: blur(20px) saturate(180%) !important;
        -webkit-backdrop-filter: blur(20px) saturate(180%) !important;
        border-radius: var(--modern-radius) !important;
        margin: var(--modern-spacing) !important;
        margin-left: 5px !important;
        margin-right: 0 !important;
        border: 1px solid var(--modern-border) !important;
        box-shadow: var(--modern-shadow) !important;
        overflow: hidden !important;
      }

      /* Main conversation area - floating card */
      div[role="main"] {
        background: var(--modern-bg) !important;
        backdrop-filter: blur(20px) saturate(180%) !important;
        -webkit-backdrop-filter: blur(20px) saturate(180%) !important;
        border-radius: var(--modern-radius) !important;
        margin: var(--modern-spacing) !important;
        margin-left: 5px !important;
        border: 1px solid var(--modern-border) !important;
        box-shadow: var(--modern-shadow), var(--modern-glow) !important;
        overflow: hidden !important;
      }

      /* Messages container */
      div[aria-label="Messages"] {
        background: transparent !important;
      }

      /* Search bar - pill shape with glow */
      input[aria-label="Search Messenger"],
      input[placeholder*="Search"],
      div[aria-label="Search Messenger"] {
        border-radius: 24px !important;
        padding: 10px 18px !important;
        background: rgba(255, 255, 255, 0.05) !important;
        border: 1px solid rgba(255, 255, 255, 0.1) !important;
        transition: all 0.3s ease !important;
      }
      
      input[aria-label="Search Messenger"]:focus,
      input[placeholder*="Search"]:focus {
        background: rgba(255, 255, 255, 0.08) !important;
        border-color: rgba(99, 102, 241, 0.5) !important;
        box-shadow: 0 0 20px rgba(99, 102, 241, 0.2) !important;
      }

      /* Chat list items - subtle hover glow */
      div[aria-label="Chats"] a,
      div[role="listitem"],
      div[role="row"] {
        border-radius: 12px !important;
        margin: 2px 6px !important;
        transition: all 0.2s ease !important;
      }
      
      div[aria-label="Chats"] a:hover {
        background: rgba(255, 255, 255, 0.06) !important;
      }

      /* Message bubbles - softer, modern look */
      div[role="row"] div[style*="border-radius"],
      div[role="none"] > div > div[dir="auto"] {
        border-radius: 18px !important;
        transition: transform 0.15s ease !important;
      }

      /* Header bar in chat */
      div[role="banner"],
      div[aria-label="Conversation actions"] {
        background: transparent !important;
        border-bottom: 1px solid rgba(255, 255, 255, 0.06) !important;
      }

      /* Message input area */
      div[aria-label="Message"],
      div[contenteditable="true"] {
        border-radius: 20px !important;
      }

      /* Emoji/gif/attachment buttons */
      div[aria-label="Choose an emoji"] button,
      div[aria-label="Attach a file"] button {
        border-radius: 50% !important;
        transition: all 0.2s ease !important;
      }
      
      div[aria-label="Choose an emoji"] button:hover,
      div[aria-label="Attach a file"] button:hover {
        background: rgba(255, 255, 255, 0.1) !important;
        transform: scale(1.1) !important;
      }

      /* Sleek scrollbars */
      ::-webkit-scrollbar {
        width: 6px !important;
        height: 6px !important;
      }
      ::-webkit-scrollbar-thumb {
        background: rgba(255, 255, 255, 0.15) !important;
        border-radius: 10px !important;
        transition: background 0.2s ease !important;
      }
      ::-webkit-scrollbar-thumb:hover {
        background: rgba(255, 255, 255, 0.25) !important;
      }
      ::-webkit-scrollbar-track {
        background: transparent !important;
      }

      /* Subtle animations */
      @keyframes float-in {
        from {
          opacity: 0;
          transform: translateY(10px);
        }
        to {
          opacity: 1;
          transform: translateY(0);
        }
      }

      div[role="main"],
      div[aria-label="Chats"],
      div[role="navigation"] {
        animation: float-in 0.4s cubic-bezier(0.4, 0, 0.2, 1) !important;
      }

      /* Remove any harsh edges */
      * {
        outline: none !important;
      }

      /* Accent color enhancement for active elements */
      a[aria-current="page"],
      div[aria-selected="true"] {
        background: linear-gradient(135deg, rgba(99, 102, 241, 0.2) 0%, rgba(139, 92, 246, 0.15) 100%) !important;
        border-left: 3px solid #6366f1 !important;
      }
    `;
    mainWindow.webContents
      .insertCSS(modernCSS, { cssKey: "modern-look" })
      .catch(() => {});
  }
}

function toggleModernLook() {
  const current = store.get("modernLook");
  const newValue = !current;
  
  if (newValue) {
    store.set("floatingGlass", false);
  }
  store.set("modernLook", newValue);

  applyModernLook();
  applyFloatingGlass();
  updateMenu();
}

function toggleFloatingGlass() {
  const current = store.get("floatingGlass");
  const newValue = !current;
  
  if (newValue) {
    store.set("modernLook", false);
  }
  store.set("floatingGlass", newValue);

  applyModernLook();
  applyFloatingGlass();
  updateMenu();
}

function applyFloatingGlass() {
  if (!mainWindow) return;
  const enabled = store.get("floatingGlass");
  mainWindow.webContents.removeInsertedCSS("floating-glass").catch(() => {});

  if (enabled) {
    // Proposal 1: Glassmorphism premium UI
    const glassCSS = `
      :root {
        --glass-bg: rgba(24, 24, 27, 0.65) !important;
        --glass-blur: 25px !important;
        --glass-border: 1px solid rgba(255, 255, 255, 0.1) !important;
        --glass-radius: 24px !important;
        --accent-primary: #6366f1 !important;
        --accent-secondary: #06b6d4 !important;
      }

      /* Base Canvas */
      html, body, div[role="main"] {
        background: transparent !important;
      }

      body::before {
        content: "";
        position: fixed;
        top: 0; left: 0; right: 0; bottom: 0;
        background: linear-gradient(135deg, #0f172a 0%, #1e1b4b 50%, #020617 100%) !important;
        z-index: -1;
      }

      /* Floating Glass Panels */
      div[role="navigation"], 
      div[aria-label="Chats"], 
      div[role="main"] > div:first-child,
      aside[role="complementary"] {
        background: var(--glass-bg) !important;
        backdrop-filter: blur(var(--glass-blur)) saturate(180%) !important;
        border: var(--glass-border) !important;
        border-radius: var(--glass-radius) !important;
        margin: 12px !important;
        box-shadow: 0 20px 50px rgba(0, 0, 0, 0.3) !important;
        overflow: hidden !important;
      }

      /* Message bubble styling */
      div[data-testid="message-container"] div[dir="auto"] {
        border-radius: 18px !important;
      }

      /* Sent bubbles */
      div[data-testid="outgoing_message"] div[dir="auto"] {
        background: linear-gradient(135deg, var(--accent-primary), var(--accent-secondary)) !important;
        color: white !important;
      }

      /* Received bubbles */
      div[data-testid="incoming_message"] div[dir="auto"] {
        background: rgba(255, 255, 255, 0.1) !important;
        backdrop-filter: blur(5px) !important;
        border: 1px solid rgba(255, 255, 255, 0.05) !important;
      }

      /* Navigation highlight */
      div[role="navigation"] a[aria-current="page"],
      div[aria-label="Chats"] div[aria-selected="true"] {
        background: rgba(255, 255, 255, 0.1) !important;
        border-radius: 12px !important;
      }

      /* Search bar */
      input[aria-label="Search Messenger"] {
        background: rgba(255, 255, 255, 0.05) !important;
        border-radius: 12px !important;
        border: 1px solid rgba(255, 255, 255, 0.1) !important;
      }

      /* Animations */
      @keyframes glassFadeIn {
        from { opacity: 0; transform: translateY(10px); }
        to { opacity: 1; transform: translateY(0); }
      }
      div[role="navigation"], div[aria-label="Chats"], div[role="main"] {
        animation: glassFadeIn 0.8s cubic-bezier(0.16, 1, 0.3, 1) forwards;
      }
    `;
    mainWindow.webContents
      .insertCSS(glassCSS, { cssKey: "floating-glass" })
      .catch(() => {});
      
    // Force default theme to avoid clashing
    applyThemeCSS("default");
  } else {
    // Restore normal theme settings
    const currentTheme = store.get("theme");
    applyThemeCSS(currentTheme);
  }
}

// Function to open the Settings UI
function openSettingsUI() {
  if (!mainWindow) return;
  
  // Send the full config so the Settings UI knows what's enabled
  const fullConfig = {
    blockReadReceipts: store.get("blockReadReceipts"),
    blockTypingIndicator: store.get("blockTypingIndicator"),
    clipboardSanitize: store.get("clipboardSanitize"),
    keywordAlertsEnabled: store.get("keywordAlertsEnabled"),
    modernLook: store.get("modernLook"),
    floatingGlass: store.get("floatingGlass"),
    theme: store.get("theme"),
    windowOpacity: store.get("windowOpacity"),
    alwaysOnTop: store.get("alwaysOnTop"),
    menuBarMode: store.get("menuBarMode"),
    launchAtLogin: store.get("launchAtLogin"),
    spellCheck: store.get("spellCheck"),
    scheduleDelayMs: store.get("scheduleDelayMs"),
  }

  mainWindow.webContents.send("open-settings-modal", fullConfig);
}


ipcMain.on("update-setting", (event, { key, value }) => {
  store.set(key, value);
  
  // Handle specific side effects
  switch (key) {
    case "blockReadReceipts":
      updateRequestBlocker();
      mainWindow.webContents.send("set-block-read-receipts", value);
      break;
    case "blockTypingIndicator":
      updateRequestBlocker();
      mainWindow.webContents.send("set-block-typing-indicator", value);
      break;
    case "clipboardSanitize":
      mainWindow.webContents.send("update-config", { clipboardSanitize: value });
      break;
    case "modernLook":
      if (value) store.set("floatingGlass", false);
      applyModernLook();
      applyFloatingGlass();
      break;
    case "floatingGlass":
      if (value) store.set("modernLook", false);
      applyModernLook();
      applyFloatingGlass();
      break;
    case "alwaysOnTop":
      mainWindow.setAlwaysOnTop(value);
      break;
    case "launchAtLogin":
      app.setLoginItemSettings({ openAtLogin: value });
      break;
    case "spellCheck":
      mainWindow.webContents.session.setSpellCheckerEnabled(value);
      break;
  }
  
  updateMenu();
});

ipcMain.on("edit-custom-css", () => {
  editCustomCSS();
});

// IPC handler for CSS input result
ipcMain.on("css-input-result", (event, css) => {
  if (typeof css !== "string") return;

  if (!isSafeCSS(css)) {
    dialog.showErrorBox(
      "Invalid CSS",
      "The CSS contains potentially dangerous content and was rejected."
    );
    return;
  }

  store.set("customCSS", css);
  applyCustomCSS();
  updateMenu();
});

function applyCustomCSS() {
  if (!mainWindow) return;
  const css = store.get("customCSS");
  // We now delegate CSS application to preload.js so it can be responsive to chat backgrounds
  mainWindow.webContents.send("apply-custom-css", css);
}

function clearCustomCSS() {
  store.set("customCSS", "");
  if (mainWindow) {
    mainWindow.webContents.removeInsertedCSS("custom-css").catch(() => {});
  }
  updateMenu();
}

async function exportCookies() {
  const { filePath } = await dialog.showSaveDialog(mainWindow, {
    title: "Export Session",
    defaultPath: "messenger-session.json",
    filters: [{ name: "JSON", extensions: ["json"] }],
  });

  if (!filePath) return;

  try {
    const cookies = await session.defaultSession.cookies.get({
      url: "https://www.messenger.com",
    });
    const facebookCookies = await session.defaultSession.cookies.get({
      url: "https://www.facebook.com",
    });
    const allCookies = [...cookies, ...facebookCookies];

    fs.writeFileSync(filePath, JSON.stringify(allCookies, null, 2));
    dialog.showMessageBox(mainWindow, {
      type: "info",
      title: "Export Complete",
      message: `Exported ${allCookies.length} cookies`,
    });
  } catch (err) {
    dialog.showErrorBox("Export Failed", err.message);
  }
}

async function importCookies() {
  const { filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: "Import Session",
    filters: [{ name: "JSON", extensions: ["json"] }],
    properties: ["openFile"],
  });

  if (!filePaths || filePaths.length === 0) return;

  try {
    const data = fs.readFileSync(filePaths[0], "utf8");
    const cookies = JSON.parse(data);

    for (const cookie of cookies) {
      const url = `https://${cookie.domain.replace(/^\./, "")}${cookie.path}`;
      await session.defaultSession.cookies.set({
        url,
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        expirationDate: cookie.expirationDate,
      });
    }

    dialog.showMessageBox(mainWindow, {
      type: "info",
      title: "Import Complete",
      message: `Imported ${cookies.length} cookies. Reloading...`,
    });

    mainWindow.webContents.reload();
  } catch (err) {
    dialog.showErrorBox("Import Failed", err.message);
  }
}

async function clearSession() {
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: "warning",
    title: "Clear Session",
    message: "This will log you out. Continue?",
    buttons: ["Cancel", "Clear"],
  });

  if (response === 1) {
    await session.defaultSession.clearStorageData();
    mainWindow.webContents.reload();
  }
}

function createPipWindow() {
  if (pipWindow) {
    pipWindow.focus();
    return;
  }

  pipWindow = new BrowserWindow({
    width: 400,
    height: 300,
    minWidth: 200,
    minHeight: 150,
    alwaysOnTop: true,
    frame: false,
    transparent: false,
    resizable: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  pipWindow.loadURL("https://www.messenger.com");
  pipWindow.webContents.setUserAgent(USER_AGENT);

  pipWindow.webContents.on("before-input-event", (event, input) => {
    if (input.key === "Escape") {
      pipWindow.close();
    }
  });

  // inject close button using insertCSS + simple JS (no script tag)
  pipWindow.webContents.on("did-finish-load", () => {
    pipWindow.webContents.insertCSS(`
      .pip-close-btn {
        position: fixed; top: 8px; right: 8px;
        width: 24px; height: 24px;
        background: rgba(0,0,0,0.6); color: white;
        border-radius: 50%; display: flex;
        align-items: center; justify-content: center;
        cursor: pointer; z-index: 999999;
        font-size: 18px; font-weight: bold;
        transition: background 0.2s;
        -webkit-app-region: no-drag;
        border: none;
      }
      .pip-close-btn:hover { background: rgba(255,0,0,0.8); }
    `);
    pipWindow.webContents.executeJavaScript(`
      (function() {
        const btn = document.createElement('button');
        btn.className = 'pip-close-btn';
        btn.textContent = '×';
        btn.onclick = () => window.close();
        document.body.appendChild(btn);
      })()
    `);
  });

  pipWindow.on("closed", () => {
    pipWindow = null;
  });
}

function updateMenu() {
  const alwaysOnTop = store.get("alwaysOnTop");
  const theme = store.get("theme");
  const dnd = store.get("doNotDisturb");
  const launchAtLogin = store.get("launchAtLogin");
  const focusMode = store.get("focusMode");
  const quickReplies = store.get("quickReplies");
  const menuBarMode = store.get("menuBarMode");
  const blockReadReceipts = store.get("blockReadReceipts");
  const spellCheck = store.get("spellCheck");
  const scheduleDelayMs = store.get("scheduleDelayMs");
  const clipboardSanitize = store.get("clipboardSanitize");
  const keywordAlertsEnabled = store.get("keywordAlertsEnabled");
  const blockTypingIndicator = store.get("blockTypingIndicator");
  const windowOpacity = store.get("windowOpacity");
  const customCSS = store.get("customCSS");

  const template = [
    {
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        { role: "toggleDevTools" },
      ],
    },
    {
      label: "Unleashed",
      submenu: [
        {
          label: "Open Settings...",
          accelerator: "CmdOrCtrl+,",
          click: openSettingsUI,
        },
        { type: "separator" },
        {
          label: "Privacy & Stealth",
          submenu: [
            {
              label: "Block Read Receipts",
              type: "checkbox",
              checked: blockReadReceipts,
              click: toggleBlockReadReceipts,
            },
            {
              label: "Block Typing Indicator",
              type: "checkbox",
              checked: blockTypingIndicator,
              click: toggleBlockTypingIndicator,
            },
            { type: "separator" },
            {
              label: "Clipboard Sanitizer",
              type: "checkbox",
              checked: clipboardSanitize,
              click: toggleClipboardSanitize,
            },
            {
              label: "Keyword Alerts",
              type: "checkbox",
              checked: keywordAlertsEnabled,
              click: toggleKeywordAlerts,
            },
            { label: "Edit Keywords...", click: editKeywordAlerts },
          ],
        },
        {
          label: "Appearance",
          submenu: [
            {
              label: "Theme",
              submenu: [
                {
                  label: "Default",
                  type: "radio",
                  checked: theme === "default",
                  click: () => applyTheme("default"),
                },
                { type: "separator" },
                {
                  label: "OLED Dark",
                  type: "radio",
                  checked: theme === "oled",
                  click: () => applyTheme("oled"),
                },
                {
                  label: "Nord",
                  type: "radio",
                  checked: theme === "nord",
                  click: () => applyTheme("nord"),
                },
                {
                  label: "Dracula",
                  type: "radio",
                  checked: theme === "dracula",
                  click: () => applyTheme("dracula"),
                },
                {
                  label: "Solarized Dark",
                  type: "radio",
                  checked: theme === "solarized",
                  click: () => applyTheme("solarized"),
                },
                {
                  label: "High Contrast",
                  type: "radio",
                  checked: theme === "highcontrast",
                  click: () => applyTheme("highcontrast"),
                },
                { type: "separator" },
                {
                  label: "Vibrant Colors",
                  submenu: [
                    {
                      label: "Crimson",
                      type: "radio",
                      checked: theme === "crimson",
                      click: () => applyTheme("crimson"),
                    },
                    {
                      label: "Electric Crimson",
                      type: "radio",
                      checked: theme === "electriccrimson",
                      click: () => applyTheme("electriccrimson"),
                    },
                    {
                      label: "Neon Coral",
                      type: "radio",
                      checked: theme === "neoncoral",
                      click: () => applyTheme("neoncoral"),
                    },
                    {
                      label: "Inferno Orange",
                      type: "radio",
                      checked: theme === "infernoorange",
                      click: () => applyTheme("infernoorange"),
                    },
                    {
                      label: "Solar Gold",
                      type: "radio",
                      checked: theme === "solargold",
                      click: () => applyTheme("solargold"),
                    },
                    {
                      label: "Acid Lime",
                      type: "radio",
                      checked: theme === "acidlime",
                      click: () => applyTheme("acidlime"),
                    },
                    {
                      label: "Emerald Flash",
                      type: "radio",
                      checked: theme === "emeraldflash",
                      click: () => applyTheme("emeraldflash"),
                    },
                    {
                      label: "Cyber Teal",
                      type: "radio",
                      checked: theme === "cyberteal",
                      click: () => applyTheme("cyberteal"),
                    },
                    {
                      label: "Electric Blue",
                      type: "radio",
                      checked: theme === "electricblue",
                      click: () => applyTheme("electricblue"),
                    },
                    {
                      label: "Ultraviolet",
                      type: "radio",
                      checked: theme === "ultraviolet",
                      click: () => applyTheme("ultraviolet"),
                    },
                    {
                      label: "Hot Magenta",
                      type: "radio",
                      checked: theme === "hotmagenta",
                      click: () => applyTheme("hotmagenta"),
                    },
                  ],
                },
                { type: "separator" },
                {
                  label: "Compact Mode",
                  type: "radio",
                  checked: theme === "compact",
                  click: () => applyTheme("compact"),
                },
              ],
            },
            {
              label: "Modern Look (Floating)",
              type: "checkbox",
              checked: store.get("modernLook"),
              click: toggleModernLook,
            },
            {
              label: "Floating Glass (Theme Override)",
              type: "checkbox",
              checked: store.get("floatingGlass"),
              click: toggleFloatingGlass,
            },
            {
              label: "Focus Mode",
              type: "checkbox",
              checked: focusMode,
              accelerator: "CmdOrCtrl+Shift+F",
              click: toggleFocusMode,
            },
            { type: "separator" },
            {
              label: "Window Opacity",
              submenu: [1.0, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4].map((op) => ({
                label: `${op * 100}%`,
                type: "radio",
                checked: windowOpacity === op,
                click: () => setWindowOpacity(op),
              })),
            },
            {
              label: "Custom CSS",
              submenu: [
                {
                  label: customCSS ? "Edit CSS..." : "Add CSS...",
                  click: editCustomCSS,
                },
                {
                  label: "Clear CSS",
                  enabled: !!customCSS,
                  click: clearCustomCSS,
                },
              ],
            },
            { type: "separator" },
            {
              label: "Theme Creator...",
              click: () => shell.openExternal("https://mstheme.pcstyle.dev"),
            },
          ],
        },
        {
          label: "Power Tools",
          submenu: [
            {
              label: "Scheduled Messages",
              submenu: [
                {
                  label: `Send in ${Math.round(scheduleDelayMs / 1000)}s Now`,
                  accelerator: "CmdOrCtrl+Alt+Enter",
                  click: scheduleSendNow,
                },
                { type: "separator" },
                {
                  label: "Delay: 5s",
                  type: "radio",
                  checked: scheduleDelayMs === 5000,
                  click: () => setScheduleDelay(5000),
                },
                {
                  label: "Delay: 30s",
                  type: "radio",
                  checked: scheduleDelayMs === 30000,
                  click: () => setScheduleDelay(30000),
                },
                {
                  label: "Delay: 60s",
                  type: "radio",
                  checked: scheduleDelayMs === 60000,
                  click: () => setScheduleDelay(60000),
                },
                {
                  label: "Delay: 2 min",
                  type: "radio",
                  checked: scheduleDelayMs === 120000,
                  click: () => setScheduleDelay(120000),
                },
              ],
            },
            {
              label: "Quick Replies",
              submenu: quickReplies.map((qr) => ({
                label: `[${qr.key}] ${qr.text}`,
                accelerator: `CmdOrCtrl+Shift+${qr.key}`,
                click: () => sendQuickReply(qr.text),
              })),
            },
            { type: "separator" },
            {
              label: "Picture in Picture",
              accelerator: "CmdOrCtrl+Shift+P",
              click: createPipWindow,
            },
            {
              label: "Do Not Disturb",
              type: "checkbox",
              checked: dnd,
              accelerator: "CmdOrCtrl+Shift+D",
              click: toggleDoNotDisturb,
            },
          ],
        },
        {
          label: "Navigation",
          submenu: [
            {
              label: "Focus Search",
              accelerator: "CmdOrCtrl+K",
              click: focusSearch,
            },
            { type: "separator" },
            {
              label: "Previous Chat",
              accelerator: "CmdOrCtrl+Up",
              click: () => navigateConversation("up"),
            },
            {
              label: "Next Chat",
              accelerator: "CmdOrCtrl+Down",
              click: () => navigateConversation("down"),
            },
          ],
        },
        { type: "separator" },
        {
          label: "App Settings",
          submenu: [
            {
              label: "Always on Top",
              type: "checkbox",
              checked: alwaysOnTop,
              accelerator: "CmdOrCtrl+Shift+T",
              click: toggleAlwaysOnTop,
            },
            {
              label: "Menu Bar Mode",
              type: "checkbox",
              checked: menuBarMode,
              click: toggleMenuBarMode,
            },
            {
              label: "Launch at Login",
              type: "checkbox",
              checked: launchAtLogin,
              click: toggleLaunchAtLogin,
            },
            {
              label: "Spell Check",
              type: "checkbox",
              checked: spellCheck,
              click: toggleSpellCheck,
            },
          ],
        },
        {
          label: "Session Management",
          submenu: [
            { label: "Export Cookies...", click: exportCookies },
            { label: "Import Cookies...", click: importCookies },
            { type: "separator" },
            { label: "Logout (Clear Session)", click: clearSession },
          ],
        },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        { type: "separator" },
        { role: "front" },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  const bounds = store.get("windowBounds");

  mainWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    minWidth: 400,
    minHeight: 300,
    title: "Messenger Unleashed",
    alwaysOnTop: store.get("alwaysOnTop"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: store.get("spellCheck"),
    },
  });

  mainWindow.webContents.setUserAgent(USER_AGENT);
  mainWindow.webContents.setMaxListeners(20);

  const opacity = store.get("windowOpacity");
  if (opacity < 1.0) {
    mainWindow.setOpacity(opacity);
  }

  session.defaultSession.setPermissionRequestHandler(
    (webContents, permission, callback) => {
      const allowedPermissions = [
        "media",
        "mediaKeySystem",
        "geolocation",
        "notifications",
        "fullscreen",
        "pointerLock",
      ];
      callback(allowedPermissions.includes(permission));
    }
  );

  session.defaultSession.setPermissionCheckHandler(
    (webContents, permission) => {
      const allowedPermissions = [
        "media",
        "mediaKeySystem",
        "geolocation",
        "notifications",
        "fullscreen",
        "pointerLock",
      ];
      return allowedPermissions.includes(permission);
    }
  );

  // apply request blockers before loading content (read receipts + typing indicator)
  updateRequestBlocker();

  mainWindow.loadURL("https://www.messenger.com");

  mainWindow.on("page-title-updated", (event, title) => {
    const match = title.match(/\((\d+)\)/);
    const count = match ? parseInt(match[1], 10) : 0;
    updateUnreadBadge(Number.isFinite(count) ? count : 0);
  });

  mainWindow.webContents.on("did-finish-load", () => {
    const theme = store.get("theme");
    if (theme !== "default") {
      applyThemeCSS(theme);
    }

    if (store.get("focusMode")) {
      mainWindow.webContents.insertCSS(
        `
        div[aria-label="Chats"],
        div[role="navigation"] { display: none !important; }
        div[role="main"] { width: 100% !important; max-width: 100% !important; }
      `,
        { cssKey: "focus-mode" }
      );
    }

    applyCustomCSS();
    pushRendererConfig();

    // send initial feature states to preload
    mainWindow.webContents.send(
      "set-block-read-receipts",
      store.get("blockReadReceipts")
    );
    mainWindow.webContents.send(
      "set-block-typing-indicator",
      store.get("blockTypingIndicator")
    );

    applyModernLook();
    applyFloatingGlass();
  });

  mainWindow.on("resize", () => {
    const { width, height } = mainWindow.getBounds();
    store.set("windowBounds", { width, height });
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  if (store.get("menuBarMode")) {
    const success = createTray();
    if (success) {
      mainWindow.setSkipTaskbar(true);
    } else {
      store.set("menuBarMode", false);
    }
  }

  updateMenu();
}

app.on("ready", () => {
  const { globalShortcut } = require("electron");

  globalShortcut.register("CmdOrCtrl+Shift+T", toggleAlwaysOnTop);
  globalShortcut.register("CmdOrCtrl+Shift+D", toggleDoNotDisturb);
  globalShortcut.register("CmdOrCtrl+Shift+F", toggleFocusMode);
  globalShortcut.register("CmdOrCtrl+Shift+P", createPipWindow);
  globalShortcut.register("CmdOrCtrl+K", focusSearch);
  globalShortcut.register("CmdOrCtrl+Alt+Enter", scheduleSendNow);

  globalShortcut.register("CmdOrCtrl+Up", () => navigateConversation("up"));
  globalShortcut.register("CmdOrCtrl+Down", () => navigateConversation("down"));

  const quickReplies = store.get("quickReplies");
  quickReplies.forEach((qr) => {
    globalShortcut.register(`CmdOrCtrl+Shift+${qr.key}`, () =>
      sendQuickReply(qr.text)
    );
  });
});

app.whenReady().then(() => {
  const launchAtLogin = store.get("launchAtLogin");
  const canSetLogin =
    process.platform !== "darwin" ||
    (app.isInApplicationsFolder && app.isInApplicationsFolder());
  if (canSetLogin) {
    try {
      app.setLoginItemSettings({
        openAtLogin: launchAtLogin,
        openAsHidden: false,
      });
    } catch (err) {
      console.warn("Failed to set login item", err);
    }
  }

  createWindow();
  checkForUpdates();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("will-quit", () => {
  const { globalShortcut } = require("electron");
  globalShortcut.unregisterAll();
});
