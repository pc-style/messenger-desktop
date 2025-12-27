import {
  app,
  BrowserWindow,
  session,
  Menu,
  type MenuItemConstructorOptions,
  ipcMain,
  Notification,
  dialog,
  desktopCapturer,
  nativeImage,
  shell,
  globalShortcut,
  Tray,
  nativeTheme,
  clipboard,
} from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appState, store } from "./state.js";
import { openInputDialog, openSelectionDialog } from "./dialogs.js";
import { applyAndroidBubbles, applyThemeCSS, THEME_OPTIONS } from "./themes.js";
import { checkForUpdates } from "./updates.js";
import { hideChatHead, initChatHeadIPC, showChatHeadIfAvailable } from "./chat-head.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.setName("Messenger Unleashed");

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", (event, commandLine, workingDirectory) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

initChatHeadIPC();

if (process.platform === 'win32') {
  app.setAppUserModelId(app.name);
}

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

let mainWindow: BrowserWindow | null = null;
let pipWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let unreadCount = 0;
let typingBlockerHandler: ((details: any, callback: any) => void) | null = null;
let quietHoursTimer: NodeJS.Timeout | null = null;
let shortcutsRegistered = false;
let shortcutsDirty = true;
let localProbeBlockerInstalled = false;

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

function parseGraphqlBody(body) {
  const result = {
    friendlyName: "",
    docId: "",
    variablesText: "",
    rawText: body || "",
  };

  if (!body || typeof body !== "string") return result;

  const trimmed = body.trim();
  const tryJSON = (value) => {
    try {
      return JSON.parse(value);
    } catch (_) {
      return null;
    }
  };

  if (trimmed.startsWith("{")) {
    const parsed = tryJSON(trimmed);
    if (parsed && typeof parsed === "object") {
      result.friendlyName = parsed.fb_api_req_friendly_name || parsed.friendly_name || "";
      result.docId = parsed.doc_id || parsed.document_id || "";
      if (parsed.variables) {
        result.variablesText = JSON.stringify(parsed.variables);
      }
      return result;
    }
  }

  try {
    const params = new URLSearchParams(body);
    result.friendlyName =
      params.get("fb_api_req_friendly_name") ||
      params.get("friendly_name") ||
      "";
    result.docId = params.get("doc_id") || params.get("document_id") || "";

    const variablesRaw = params.get("variables");
    if (variablesRaw) {
      const parsedVars = tryJSON(variablesRaw);
      result.variablesText = parsedVars
        ? JSON.stringify(parsedVars)
        : variablesRaw;
    } else {
      const queriesRaw = params.get("queries");
      if (queriesRaw) {
        const parsedQueries = tryJSON(queriesRaw);
        result.variablesText = parsedQueries
          ? JSON.stringify(parsedQueries)
          : queriesRaw;
      }
    }
  } catch (_) {
    // ignore parse failures
  }

  return result;
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
  // Aggressively search for typing keywords in the raw body string
  // This covers JSON, URL-encoded, and multipart bodies
  const rawBody = body.toString();
  if (
    rawBody.includes("SendTypingIndicator") ||
    rawBody.includes("typing_indicator") ||
    rawBody.includes("typing") && (rawBody.includes("true") || rawBody.includes("1")) // stricter check for generic "typing"
  ) {
    return true;
  }
  
  // Keep the structured checks just in case
  const json = tryJSON(body);
  if (json) {
    if (json.name === "SendTypingIndicator" || json.mutation?.includes("SendTypingIndicator")) return true;
    if (json.variables?.is_typing === true || json.variables?.typing === true) return true;
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
  /typing_indicator/i,
  /presence.*typing/i,
  /st=1/i, // common field for typing state in some AJAX calls
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
  const expTypingOverlay = store.get("expTypingOverlay");
  
  const filter = {
    urls: [
      "https://*.messenger.com/*",
      "https://*.facebook.com/*",
      "https://edge-chat.messenger.com/*",
      "https://edge-chat.facebook.com/*",
      "wss://*.messenger.com/*",
      "wss://*.facebook.com/*",
      "wss://edge-chat.messenger.com/*",
      "wss://edge-chat.facebook.com/*",
      "http://localhost:3103/*",
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
      
      // Silently block local probes from Facebook scripts
      if (url.includes("localhost:3103")) {
         return callback({ cancel: true });
      }
      
      // Check read receipts blocking
      if (blockReadReceipts && shouldBlockReadReceipt(url, body)) {
        console.log(`\x1b[31m[Unleashed] [BLOCKED] READ RECEIPT:\x1b[0m ${url.slice(0, 150)}`);
        return callback({ cancel: true });
      }
      
      // Check typing indicator blocking (skip WebSockets; handled in preload)
      if (blockTypingIndicator && details.resourceType !== "websocket" && shouldBlockTyping(url, body)) {
        console.log(`\x1b[33m[Unleashed] [BLOCKED] TYPING INDICATOR:\x1b[0m ${url.slice(0, 150)}`);
        return callback({ cancel: true });
      }
      
      // DEBUG: Log any active traffic to see what we missed
      if (!url.includes("blocked_") && !url.includes("ping")) {
         if (url.includes("graphql")) {
            // console.log(`\x1b[36m[Unleashed] [GraphQL] ${url} | Body len: ${body.length}\x1b[0m`);
            if (body.includes("typing")) console.log(`\x1b[35m[Unleashed] [MISSED TYPING] In GraphQL: ${url}\x1b[0m`);
         }
         else if (url.includes("bnzai") || url.includes("typing")) {
            // console.log(`\x1b[90m[Unleashed] [Banzai/Typing] ${url.slice(0, 100)}\x1b[0m`);
         }
      }

      return callback({});
    };
    
    console.log(`\x1b[35m[Unleashed] [BLOCKER] Active | Read: ${blockReadReceipts} | Typing: ${blockTypingIndicator}\x1b[0m`);
    session.defaultSession.webRequest.onBeforeRequest(filter, requestBlockerHandler);
  }
}

function installLocalProbeBlocker() {
  if (localProbeBlockerInstalled) return;
  localProbeBlockerInstalled = true;
  try {
    session.defaultSession.webRequest.onBeforeRequest(
      { urls: ["http://localhost:3103/*"] },
      (_, callback) => callback({ cancel: true })
    );
  } catch (_) {}
}

function getAllFramesForWebContents(contents) {
  if (!contents || contents.isDestroyed()) return [];
  const mainFrame = contents.mainFrame;
  if (!mainFrame) return [];
  return Array.isArray(mainFrame.framesInSubtree)
    ? mainFrame.framesInSubtree
    : [mainFrame];
}

function buildWebSocketProxyInstallScript() {
  return `
    (() => {
      if (!window || window.__unleashedWsProxyInstalled || !window.WebSocket) return;
      window.__unleashedWsProxyInstalled = true;

      const OriginalWebSocket = window.WebSocket;
      const decoder = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8') : null;
      const decodePayload = (data) => {
        if (!data) return '';
        if (typeof data === 'string') return data;
        try {
          if (data instanceof ArrayBuffer) {
            const bytes = new Uint8Array(data);
            return decoder ? decoder.decode(bytes) : '';
          }
          if (ArrayBuffer.isView(data)) {
            const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
            return decoder ? decoder.decode(bytes) : '';
          }
        } catch (_) {}
        return '';
      };
      const shouldBlockTypingPayload = (text) => {
        if (!text) return false;
        return text.toLowerCase().includes('is_typing');
      };
      const shouldBlockActiveStatusPayload = (text) => {
        if (!text) return false;
        if (text.includes('USER_ACTIVITY_UPDATE_SUBSCRIBE')) return true;
        if (text.includes('USER_ACTIVITY_UPDATE')) return true;
        const lower = text.toLowerCase();
        if (lower.includes('presence') && lower.includes('active')) return true;
        if (lower.includes('active_status')) return true;
        if (lower.includes('last_active')) return true;
        if (lower.includes('online_status')) return true;
        return false;
      };
      const shouldBlockReadReceiptPayload = (text) => {
        if (!text) return false;
        const lower = text.toLowerCase();
        if (lower.includes('markread') || lower.includes('mark_read')) return true;
        if (lower.includes('markseen') || lower.includes('mark_seen')) return true;
        if (lower.includes('read_receipt')) return true;
        if (lower.includes('delivery_receipt')) return true;
        if (lower.includes('seen_timestamp')) return true;
        if (text.includes('MarkThreadSeen')) return true;
        if (text.includes('ThreadMarkRead')) return true;
        return false;
      };

      function WebSocketProxy(url, protocols) {
        const ws = protocols ? new OriginalWebSocket(url, protocols) : new OriginalWebSocket(url);
        const originalSend = ws.send;

        ws.send = function (data) {
          const blockTypingIndicator = !!window.__unleashedBlockTypingIndicator;
          const blockActiveStatus = !!window.__unleashedBlockActiveStatus;
          const blockReadReceipts = !!window.__unleashedBlockReadReceipts;
          const debugWebSocketBlocker = !!window.__unleashedDebugWsBlocker;
          const debugWebSocketBlockerDecode = !!window.__unleashedDebugWsBlockerDecode;
          const debugWebSocketTypingTrace = !!window.__unleashedDebugWsTypingTrace;

          if (blockTypingIndicator || blockActiveStatus || blockReadReceipts || debugWebSocketTypingTrace) {
            const decoded = decodePayload(data);
            if (decoded) {
              const isTypingPayload = shouldBlockTypingPayload(decoded);
              const blockTyping = blockTypingIndicator && isTypingPayload;
              const blockActive = blockActiveStatus && shouldBlockActiveStatusPayload(decoded);
              const blockRead = blockReadReceipts && shouldBlockReadReceiptPayload(decoded);

              if (debugWebSocketTypingTrace && isTypingPayload) {
                let preview = '';
                if (debugWebSocketBlockerDecode) {
                  preview = ' payload=' + decoded.slice(0, 220);
                }
                console.log('[Unleashed] [WS-TYPING] ' + url + ' blocked=' + blockTypingIndicator + preview);
              }

              if (blockTyping || blockActive || blockRead) {
                if (debugWebSocketBlocker) {
                  const reason = blockTyping ? 'typing' : blockActive ? 'active-status' : 'read-receipt';
                  let preview = '';
                  if (debugWebSocketBlockerDecode) {
                    preview = ' payload=' + decoded.slice(0, 220);
                  }
                  console.log('[Unleashed] [WS-BLOCKED] ' + reason + ' ' + url + preview);
                }
                return;
              }
            }
          }
          return originalSend.call(ws, data);
        };

        return ws;
      }

      WebSocketProxy.prototype = OriginalWebSocket.prototype;
      WebSocketProxy.CONNECTING = OriginalWebSocket.CONNECTING;
      WebSocketProxy.OPEN = OriginalWebSocket.OPEN;
      WebSocketProxy.CLOSING = OriginalWebSocket.CLOSING;
      WebSocketProxy.CLOSED = OriginalWebSocket.CLOSED;

      window.WebSocket = WebSocketProxy;
    })();
  `;
}

function syncWebSocketProxyFlags() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const blockTypingIndicator = !!store.get("blockTypingIndicator");
  const blockActiveStatus = !!store.get("blockActiveStatus");
  const blockReadReceipts = !!store.get("blockReadReceipts");
  const debugWebSocketBlocker =
    process.env.DEBUG_REQUEST_BLOCKER_WS === "1" ||
    process.env.DEBUG_REQUEST_BLOCKER_WS_ALL === "1" ||
    process.env.DEBUG_REQUEST_BLOCKER_WS_DECODE === "1";
  const debugWebSocketBlockerDecode = process.env.DEBUG_REQUEST_BLOCKER_WS_DECODE === "1";
  const debugWebSocketTypingTrace = process.env.DEBUG_REQUEST_BLOCKER_WS_TRACE_TYPING === "1";

  const script = `
    (() => {
      window.__unleashedBlockTypingIndicator = ${blockTypingIndicator ? "true" : "false"};
      window.__unleashedBlockActiveStatus = ${blockActiveStatus ? "true" : "false"};
      window.__unleashedBlockReadReceipts = ${blockReadReceipts ? "true" : "false"};
      window.__unleashedDebugWsBlocker = ${debugWebSocketBlocker ? "true" : "false"};
      window.__unleashedDebugWsBlockerDecode = ${debugWebSocketBlockerDecode ? "true" : "false"};
      window.__unleashedDebugWsTypingTrace = ${debugWebSocketTypingTrace ? "true" : "false"};
    })();
  `;

  for (const frame of getAllFramesForWebContents(mainWindow.webContents)) {
    if (!frame || frame.detached) continue;
    frame.executeJavaScript(script, true).catch(() => {});
  }
}

function ensureWebSocketProxyInstalled() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const installScript = buildWebSocketProxyInstallScript();
  for (const frame of getAllFramesForWebContents(mainWindow.webContents)) {
    if (!frame || frame.detached) continue;
    frame.executeJavaScript(installScript, true).catch(() => {});
  }
  syncWebSocketProxyFlags();
}

// Legacy function kept for compatibility, now delegates to unified handler
function updateTypingBlocker(enabled) {
  store.set("blockTypingIndicator", enabled);
  updateRequestBlocker();
}

function isSafeCSS(css) {
  const dangerous =
    /<script|javascript:|expression\s*\(|@import\s+url|behavior\s*:/i;
  return !dangerous.test(css);
}
// get platform-appropriate icon path
function getIconPath() {
  const iconName =
    process.platform === "win32"
      ? "icon.ico"
      : process.platform === "darwin"
      ? "icon.icns"
      : "icon.png";
  const iconPath = path.join(app.getAppPath(), iconName);
  if (fs.existsSync(iconPath)) return iconPath;
  // fallback to any available icon
  for (const ext of ["png", "ico", "icns"]) {
    const fallback = path.join(app.getAppPath(), `icon.${ext}`);
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

function applyTheme(theme) {
  if (!mainWindow) return;

  store.set("theme", theme);
  updateMenu();

  // Instant apply instead of full reload
  applyThemeCSS(theme);
}

function toggleAndroidBubbles() {
  const current = store.get("androidBubbles");
  store.set("androidBubbles", !current);
  applyAndroidBubbles();
  updateMenu();
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
  store.set("quietHoursApplied", false);
  updateMenu();
}

function parseTimeInput(value) {
  if (!value || typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;

  const match = trimmed.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!match) return null;

  let hours = parseInt(match[1], 10);
  let minutes = parseInt(match[2] || "0", 10);
  const meridiem = match[3];

  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  if (minutes < 0 || minutes > 59) return null;

  if (meridiem) {
    if (hours < 1 || hours > 12) return null;
    if (meridiem === "pm" && hours !== 12) hours += 12;
    if (meridiem === "am" && hours === 12) hours = 0;
  } else if (hours > 23) {
    return null;
  }

  return hours * 60 + minutes;
}

function formatTimeLabel(minutes) {
  if (!Number.isFinite(minutes)) return "Not set";
  const safeMinutes = Math.max(0, Math.min(23 * 60 + 59, minutes));
  const hours24 = Math.floor(safeMinutes / 60);
  const mins = safeMinutes % 60;
  const suffix = hours24 >= 12 ? "PM" : "AM";
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
  return `${hours12}:${String(mins).padStart(2, "0")} ${suffix}`;
}

function getQuietHoursRangeLabel() {
  const start = parseTimeInput(store.get("quietHoursStart"));
  const end = parseTimeInput(store.get("quietHoursEnd"));
  if (start === null || end === null) return "Not set";
  return `${formatTimeLabel(start)} → ${formatTimeLabel(end)}`;
}

function isWithinQuietHours(nowMinutes, startMinutes, endMinutes) {
  if (startMinutes === endMinutes) return true;
  if (startMinutes < endMinutes) {
    return nowMinutes >= startMinutes && nowMinutes < endMinutes;
  }
  return nowMinutes >= startMinutes || nowMinutes < endMinutes;
}

function applyQuietHours() {
  const enabled = store.get("quietHoursEnabled");
  const applied = store.get("quietHoursApplied");
  if (!enabled) {
    if (applied && store.get("doNotDisturb")) {
      store.set("doNotDisturb", false);
      updateMenu();
    }
    if (applied) store.set("quietHoursApplied", false);
    return;
  }

  const start = parseTimeInput(store.get("quietHoursStart"));
  const end = parseTimeInput(store.get("quietHoursEnd"));
  if (start === null || end === null) return;

  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const shouldEnable = isWithinQuietHours(nowMinutes, start, end);
  const dnd = store.get("doNotDisturb");

  if (shouldEnable && !dnd) {
    store.set("doNotDisturb", true);
    store.set("quietHoursApplied", true);
    updateMenu();
  } else if (!shouldEnable && applied && dnd) {
    store.set("doNotDisturb", false);
    store.set("quietHoursApplied", false);
    updateMenu();
  }
}

function startQuietHoursMonitor() {
  if (quietHoursTimer) {
    clearInterval(quietHoursTimer);
  }
  quietHoursTimer = setInterval(applyQuietHours, 60 * 1000);
  applyQuietHours();
}

function toggleQuietHours() {
  const next = !store.get("quietHoursEnabled");
  store.set("quietHoursEnabled", next);
  applyQuietHours();
  updateMenu();
}

async function editQuietHours({ reopenSettings = false } = {}) {
  if (!mainWindow) return;

  const currentStart = store.get("quietHoursStart");
  const currentEnd = store.get("quietHoursEnd");

  const startValue = await openInputDialog({
    title: "Quiet Hours Start",
    message: "Enter a start time (e.g. 22:00 or 10:00 PM):",
    defaultValue: currentStart,
  });

  if (startValue === null) return;
  const parsedStart = parseTimeInput(startValue);
  if (parsedStart === null) {
    dialog.showErrorBox(
      "Invalid Time",
      "Start time must be a valid time like 22:00 or 10:00 PM."
    );
    return;
  }

  const endValue = await openInputDialog({
    title: "Quiet Hours End",
    message: "Enter an end time (e.g. 07:00 or 7:00 AM):",
    defaultValue: currentEnd,
  });

  if (endValue === null) return;
  const parsedEnd = parseTimeInput(endValue);
  if (parsedEnd === null) {
    dialog.showErrorBox(
      "Invalid Time",
      "End time must be a valid time like 07:00 or 7:00 AM."
    );
    return;
  }

  const normalizeTime = (minutes) => {
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;
  };

  store.set("quietHoursStart", normalizeTime(parsedStart));
  store.set("quietHoursEnd", normalizeTime(parsedEnd));
  applyQuietHours();
  updateMenu();

  if (mainWindow) {
    mainWindow.webContents.send("show-toast", {
      message: `Quiet Hours set to ${getQuietHoursRangeLabel()}.`,
      tone: "success",
    });
  }

  if (reopenSettings) {
    openSettingsUI();
  }
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
      { cssKey: "focus-mode" } as any
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

function formatQuickRepliesInput(quickReplies) {
  return (quickReplies || [])
    .map((qr) => `${qr.key}: ${qr.text}`)
    .join("\n");
}

function parseQuickRepliesInput(value) {
  const lines = (value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const seen = new Set();
  const replies = [];

  for (const line of lines) {
    let match = line.match(/^([a-zA-Z0-9])\s*[:\-\|]\s*(.+)$/);
    if (!match) {
      match = line.match(/^([a-zA-Z0-9])\s+(.+)$/);
    }
    if (!match) continue;

    const key = match[1].toUpperCase();
    const text = match[2].trim();
    if (!text) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    replies.push({ key, text });
  }

  return replies;
}

async function editQuickReplies({ reopenSettings = false } = {}) {
  if (!mainWindow) return;
  const existing = store.get("quickReplies") || [];
  const value = await openInputDialog({
    title: "Quick Replies",
    message: "One per line. Format: KEY: message (e.g. 1: On my way!)",
    defaultValue: formatQuickRepliesInput(existing),
    multiline: true,
  });

  if (value === null) return;

  const parsed = parseQuickRepliesInput(value);
  if (!parsed.length) {
    dialog.showErrorBox(
      "Quick Replies",
      "No valid quick replies were found. Use the format: KEY: message"
    );
    return;
  }

  store.set("quickReplies", parsed);
  refreshGlobalShortcuts();
  updateMenu();

  if (mainWindow) {
    mainWindow.webContents.send("show-toast", {
      message: `Saved ${parsed.length} quick repl${parsed.length === 1 ? "y" : "ies"}.`,
      tone: "success",
    });
  }

  if (reopenSettings) {
    openSettingsUI();
  }
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

  try {
    // prefer the pre-sized tray PNG, fall back to platform-specific icon
    let iconPath = path.join(app.getAppPath(), "trayIcon.png");
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

  // sync websocket proxy flags for WebSocket-based read receipts
  syncWebSocketProxyFlags();

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

    if (mainWindow) {
      mainWindow.webContents.send("show-toast", {
        message: `Keyword alerts updated (${list.length}).`,
        tone: "success",
      });
    }
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
  if (mainWindow) {
    mainWindow.webContents.send("show-toast", {
      message: `Keyword alerts updated (${list.length}).`,
      tone: "success",
    });
  }
});

function pushRendererConfig() {
  if (!mainWindow) return;
  const config = {
    keywordAlerts: store.get("keywordAlerts"),
    keywordAlertsEnabled: store.get("keywordAlertsEnabled"),
    clipboardSanitize: store.get("clipboardSanitize"),
    scheduleDelayMs: store.get("scheduleDelayMs"),
    blockTypingIndicator: store.get("blockTypingIndicator"),
    androidBubbles: store.get("androidBubbles"),
    autoReplyMessage: store.get("autoReplyMessage"),
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
  syncWebSocketProxyFlags();

  if (!newValue) {
    mainWindow.webContents.reload();
  }

  updateMenu();
}

function toggleBlockActiveStatus() {
  const current = store.get("blockActiveStatus");
  const newValue = !current;
  store.set("blockActiveStatus", newValue);

  if (!mainWindow) return;

  // notify preload to update active status blocking
  mainWindow.webContents.send("set-block-active-status", newValue);
  syncWebSocketProxyFlags();

  if (!newValue) {
    mainWindow.webContents.reload();
  }

  updateMenu();
}

function toggleExpTypingOverlay() {
  const current = store.get("expTypingOverlay");
  const newValue = !current;
  store.set("expTypingOverlay", newValue);

  if (!mainWindow) return;
  mainWindow.webContents.send("set-exp-typing-overlay", newValue);
  updateMenu();
}

function toggleUnsendDetection() {
  const current = store.get("unsendDetection");
  const newValue = !current;
  store.set("unsendDetection", newValue);

  if (!mainWindow) return;
  mainWindow.webContents.send("set-unsend-detection", newValue);
  updateMenu();

  if (newValue) {
    mainWindow.webContents.send("show-toast", {
      message: "Unsend detection enabled. You'll be notified when messages are removed.",
      tone: "success",
    });
  }
}

function toggleAutoReply() {
  const current = store.get("autoReplyEnabled");
  const newValue = !current;
  store.set("autoReplyEnabled", newValue);

  if (!mainWindow) return;
  mainWindow.webContents.send("set-auto-reply", newValue);
  updateMenu();

  if (newValue) {
    mainWindow.webContents.send("show-toast", {
      message: "Auto-reply enabled. Incoming messages will receive your away message.",
      tone: "success",
    });
  }
}

async function editAutoReplyMessage() {
  if (!mainWindow) return;
  const existing = store.get("autoReplyMessage");

  const value = await openInputDialog({
    title: "Auto-Reply Message",
    message: "Enter your away message:",
    defaultValue: existing,
    multiline: true,
  });

  if (value !== null) {
    store.set("autoReplyMessage", value);
    mainWindow.webContents.send("set-auto-reply-message", value);
    pushRendererConfig();
    updateMenu();

    mainWindow.webContents.send("show-toast", {
      message: "Auto-reply message updated.",
      tone: "success",
    });
  }
}

async function exportConversation() {
  if (!mainWindow) return;

  // ask preload to scrape conversation
  mainWindow.webContents.send("export-conversation-request");
}

// handle conversation export data from preload
ipcMain.on("export-conversation-data", async (event, data) => {
  if (!mainWindow) return;

  const { chatName, messages } = data;
  if (!messages || messages.length === 0) {
    dialog.showMessageBox(mainWindow, {
      type: "info",
      title: "Export Conversation",
      message: "No messages found in the current conversation to export.",
    });
    return;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeName = (chatName || "conversation").replace(/[^a-z0-9]/gi, "_");
  const defaultPath = `${safeName}_${timestamp}.txt`;

  const { filePath } = await dialog.showSaveDialog(mainWindow, {
    title: "Export Conversation",
    defaultPath,
    filters: [
      { name: "Text Files", extensions: ["txt"] },
      { name: "Markdown", extensions: ["md"] },
      { name: "JSON", extensions: ["json"] },
    ],
  });

  if (!filePath) return;

  try {
    let content: string;
    const ext = path.extname(filePath).toLowerCase();

    if (ext === ".json") {
      content = JSON.stringify({ chatName, exportedAt: new Date().toISOString(), messages }, null, 2);
    } else if (ext === ".md") {
      content = `# ${chatName}\n\nExported: ${new Date().toLocaleString()}\n\n---\n\n`;
      content += messages.map((m) => `**${m.sender}** (${m.time}):\n${m.text}\n`).join("\n");
    } else {
      content = `Conversation: ${chatName}\nExported: ${new Date().toLocaleString()}\n${"=".repeat(50)}\n\n`;
      content += messages.map((m) => `[${m.time}] ${m.sender}: ${m.text}`).join("\n\n");
    }

    fs.writeFileSync(filePath, content, "utf8");

    mainWindow.webContents.send("show-toast", {
      message: `Exported ${messages.length} messages to ${path.basename(filePath)}`,
      tone: "success",
    });
  } catch (err) {
    dialog.showErrorBox("Export Failed", err instanceof Error ? err.message : String(err));
  }
});

function setWindowOpacity(opacity) {
  store.set("windowOpacity", opacity);
  if (mainWindow) {
    mainWindow.setOpacity(opacity);
  }
  updateMenu();
}

function setFontSize(size: number) {
  store.set("fontSize", size);
  applyFontSize();
  updateMenu();
}

function applyFontSize() {
  if (!mainWindow) return;
  const size = store.get("fontSize");
  const css = `
    html, body {
      font-size: ${size}% !important;
    }
    div[dir="auto"] {
      font-size: ${size <= 100 ? '1em' : `${size / 100}em`} !important;
    }
  `;
  mainWindow.webContents.removeInsertedCSS("font-size").catch(() => {});
  if (size !== 100) {
    mainWindow.webContents.insertCSS(css, { cssKey: "font-size" } as any).catch(() => {});
  }
}

function toggleSystemThemeSync() {
  const current = store.get("systemThemeSync");
  const newValue = !current;
  store.set("systemThemeSync", newValue);

  if (newValue) {
    applySystemTheme();
  }
  updateMenu();
}

function applySystemTheme() {
  if (!store.get("systemThemeSync")) return;

  const isDark = nativeTheme.shouldUseDarkColors;

  // apply appropriate theme based on system
  if (isDark) {
    // keep current dark theme or apply oled
    const currentTheme = store.get("theme");
    if (currentTheme === "default") {
      applyTheme("oled");
    }
  } else {
    // for light mode, use default (messenger's built-in light theme)
    applyTheme("default");
  }
}

function toggleLinkPreviewBlocking() {
  const current = store.get("linkPreviewBlocking");
  const newValue = !current;
  store.set("linkPreviewBlocking", newValue);

  if (!mainWindow) return;
  mainWindow.webContents.send("set-link-preview-blocking", newValue);
  updateMenu();

  if (newValue) {
    mainWindow.webContents.send("show-toast", {
      message: "Link previews will be blocked for privacy.",
      tone: "success",
    });
  }
}

function toggleScreenshotProtection() {
  const current = store.get("screenshotProtection");
  const newValue = !current;
  store.set("screenshotProtection", newValue);

  if (!mainWindow) return;

  // use content protection API on supported platforms
  mainWindow.setContentProtection(newValue);

  updateMenu();

  mainWindow.webContents.send("show-toast", {
    message: newValue
      ? "Screenshot protection enabled. App content hidden from screen capture."
      : "Screenshot protection disabled.",
    tone: newValue ? "success" : "info",
  });
}

function showConversationStats() {
  if (!mainWindow) return;
  mainWindow.webContents.send("show-conversation-stats");
}

function searchInConversation() {
  if (!mainWindow) return;
  mainWindow.webContents.send("show-conversation-search");
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
      .insertCSS(modernCSS, { cssKey: "modern-look" } as any)
      .catch(() => {});
  } else {
    // If we're not also in glass mode, restore the current theme colors
    if (!store.get("floatingGlass")) {
      applyThemeCSS(store.get("theme"));
    }
  }
}

function applyUICleanup() {
  if (!mainWindow) return;
  const cleanupCSS = `
    /* Hide Greptile / Reviewer cards */
    div[aria-label="Reviewer"],
    div[aria-label*="Greptile"],
    div[class*="greptile"] {
      display: none !important;
      height: 0 !important;
      width: 0 !important;
      overflow: hidden !important;
      visibility: hidden !important;
    }

    /* Hide Promoted / Sponsored content */
    div[aria-label="Sponsored"],
    div[aria-label="Promoted"] {
      display: none !important;
    }
  `;
  mainWindow.webContents.insertCSS(cleanupCSS, { cssKey: "ui-cleanup" } as any).catch(() => {});
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
      .insertCSS(glassCSS, { cssKey: "floating-glass" } as any)
      .catch(() => {});
      
    // Force default theme to avoid clashing
    applyThemeCSS("default");
  } else {
    // Restore normal theme settings
    applyThemeCSS(store.get("theme"));
  }
}

// Function to open the Settings UI
function openSettingsUI() {
  if (!mainWindow) return;
  
  // Send the full config so the Settings UI knows what's enabled
  const fullConfig = {
    version: app.getVersion(),
    shortcuts: store.get("shortcuts"),
    blockReadReceipts: store.get("blockReadReceipts"),
    blockActiveStatus: store.get("blockActiveStatus"),
    blockTypingIndicator: store.get("blockTypingIndicator"),
    expTypingOverlay: store.get("expTypingOverlay"),
    clipboardSanitize: store.get("clipboardSanitize"),
    keywordAlertsEnabled: store.get("keywordAlertsEnabled"),
    doNotDisturb: store.get("doNotDisturb"),
    modernLook: store.get("modernLook"),
    floatingGlass: store.get("floatingGlass"),
    androidBubbles: store.get("androidBubbles"),
    experimentalEnabled: store.get("experimentalEnabled"),
    theme: store.get("theme"),
    windowOpacity: store.get("windowOpacity"),
    alwaysOnTop: store.get("alwaysOnTop"),
    menuBarMode: store.get("menuBarMode"),
    launchAtLogin: store.get("launchAtLogin"),
    spellCheck: store.get("spellCheck"),
    scheduleDelayMs: store.get("scheduleDelayMs"),
    quietHoursEnabled: store.get("quietHoursEnabled"),
    quietHoursStart: store.get("quietHoursStart"),
    quietHoursEnd: store.get("quietHoursEnd"),
    quietHoursLabel: getQuietHoursRangeLabel(),
    quickReplies: store.get("quickReplies"),
  }

  mainWindow.webContents.send("open-settings-modal", fullConfig);
}


ipcMain.on("update-setting", (event, { key, value }) => {
  const experimentalKeys = new Set(["androidBubbles", "expTypingOverlay"]);
  if (key === "experimentalEnabled") return;
  if (experimentalKeys.has(key) && !store.get("experimentalEnabled")) {
    if (mainWindow) {
      mainWindow.webContents.send("show-toast", {
        message: "Enable Experimental Options to use this feature.",
        tone: "warning",
      });
    }
    return;
  }

  store.set(key, value);
  
  // Handle specific side effects
  switch (key) {
    case "blockReadReceipts":
      store.set("blockReadReceipts", value);
      updateRequestBlocker();
      mainWindow.webContents.send("set-block-read-receipts", value);
      break;
    case "blockActiveStatus":
      mainWindow.webContents.send("set-block-active-status", value);
      syncWebSocketProxyFlags();
      break;
    case "blockTypingIndicator":
      updateRequestBlocker();
      mainWindow.webContents.send("set-block-typing-indicator", value);
      syncWebSocketProxyFlags();
      break;
    case "expTypingOverlay":
      mainWindow.webContents.send("set-exp-typing-overlay", value);
      break;
    case "quietHoursEnabled":
      store.set("quietHoursEnabled", value);
      applyQuietHours();
      break;
    case "keywordAlertsEnabled":
      store.set("keywordAlertsEnabled", value);
      pushRendererConfig();
      break;
    case "doNotDisturb":
      store.set("doNotDisturb", value);
      store.set("quietHoursApplied", false);
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
    case "androidBubbles":
      applyAndroidBubbles();
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
    case "shortcuts":
      refreshGlobalShortcuts();
      break;
  }
  
  updateMenu();
});

ipcMain.on("set-experimental-access", async (event, { enabled }) => {
  if (!mainWindow) return;
  if (!enabled) {
    store.set("experimentalEnabled", false);
    openSettingsUI();
    return;
  }

  const value = await openInputDialog({
    title: "Enable Experimental Options",
    message:
      'Experimental features may be unstable, break ToS, or make the app unusable. Type "I acknowledge" to continue.',
    defaultValue: "",
    multiline: false,
  });

  if (!value) return;
  if (value.trim().toLowerCase() === "i acknowledge") {
    store.set("experimentalEnabled", true);
    openSettingsUI();
  } else {
    dialog.showErrorBox(
      "Experimental Options",
      'Confirmation failed. Type "I acknowledge" to enable experimental options.'
    );
  }
});

ipcMain.on("edit-custom-css", () => {
  editCustomCSS();
});

ipcMain.on("edit-keywords", () => {
  editKeywordAlerts();
});

ipcMain.on("edit-quick-replies", () => {
  editQuickReplies({ reopenSettings: true });
});

ipcMain.on("edit-quiet-hours", () => {
  editQuietHours({ reopenSettings: true });
});

ipcMain.on("open-settings", () => {
  openSettingsUI();
});

ipcMain.on("pick-theme", async () => {
  if (!mainWindow) return;
  const allowExperimental = store.get("experimentalEnabled");
  const options = allowExperimental
    ? THEME_OPTIONS
    : THEME_OPTIONS.filter((option) => option.id !== "alternative");
  const choice = await openSelectionDialog({
    title: "Choose Theme",
    message: "Select a theme for Messenger Unleashed.",
    options,
  });
  if (choice) {
    applyTheme(choice);
  }
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

ipcMain.on("update-shortcut", (event, { action, accelerator }) => {
  const shortcuts = store.get("shortcuts") || {};
  shortcuts[action] = accelerator;
  store.set("shortcuts", shortcuts);
  refreshGlobalShortcuts();
  mainWindow.webContents.send("update-config", { shortcuts });
});

ipcMain.on("toggle-chameleon", () => {
  toggleChameleonMode();
});

let chameleonMode = false;
function toggleChameleonMode() {
  chameleonMode = !chameleonMode;
  if (!mainWindow) return;
  mainWindow.webContents.send("set-chameleon-mode", chameleonMode);
  if (chameleonMode) {
    if (process.platform === "darwin" && app.dock) app.dock.setBadge("");
  } else {
    updateUnreadBadge(unreadCount);
  }
}

function applyCustomCSS() {
  if (!mainWindow) return;
  const css = store.get("customCSS");
  // We now delegate CSS application to the preload bridge so it can be responsive to chat backgrounds
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
    dialog.showErrorBox("Export Failed", err instanceof Error ? err.message : String(err));
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
    dialog.showErrorBox("Import Failed", err instanceof Error ? err.message : String(err));
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
  const expTypingOverlay = store.get("expTypingOverlay");
  const windowOpacity = store.get("windowOpacity");
  const customCSS = store.get("customCSS");
  const androidBubbles = store.get("androidBubbles");
  const experimentalEnabled = store.get("experimentalEnabled");
  const quietHoursEnabled = store.get("quietHoursEnabled");
  const quietHoursStart = store.get("quietHoursStart");
  const quietHoursEnd = store.get("quietHoursEnd");
  const quietHoursStartLabel = formatTimeLabel(parseTimeInput(quietHoursStart));
  const quietHoursEndLabel = formatTimeLabel(parseTimeInput(quietHoursEnd));

  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: "about" },
        {
          label: "Check for Updates...",
          click: () => checkForUpdates({ silent: false }),
        },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit", accelerator: "CmdOrCtrl+Q" },
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
            {
              label: "[EXP] Block Active Status",
              type: "checkbox",
              checked: store.get("blockActiveStatus"),
              click: toggleBlockActiveStatus,
            },
            {
              label: "[EXP] Typing Overlay (Better Typing Block)",
              type: "checkbox",
              checked: expTypingOverlay,
              click: toggleExpTypingOverlay,
              visible: experimentalEnabled,
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
            { type: "separator" },
            {
              label: "[EXP] Unsend Detection",
              type: "checkbox",
              checked: store.get("unsendDetection"),
              click: toggleUnsendDetection,
            },
            {
              label: "[EXP] Block Link Previews",
              type: "checkbox",
              checked: store.get("linkPreviewBlocking"),
              click: toggleLinkPreviewBlocking,
            },
            {
              label: "[EXP] Screenshot Protection",
              type: "checkbox",
              checked: store.get("screenshotProtection"),
              click: toggleScreenshotProtection,
            },
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
                {
                  label: "[EXP] Alternative Look",
                  type: "radio",
                  checked: theme === "alternative",
                  click: () => applyTheme("alternative"),
                  visible: experimentalEnabled,
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
              label: "[EXP] Android Bubbles",
              type: "checkbox",
              checked: androidBubbles,
              click: toggleAndroidBubbles,
              visible: experimentalEnabled,
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
              label: "[EXP] Font Size",
              submenu: [80, 90, 100, 110, 120, 130, 150].map((size) => ({
                label: size === 100 ? "100% (Default)" : `${size}%`,
                type: "radio",
                checked: store.get("fontSize") === size,
                click: () => setFontSize(size),
              })),
            },
            {
              label: "[EXP] Sync with System Theme",
              type: "checkbox",
              checked: store.get("systemThemeSync"),
              click: toggleSystemThemeSync,
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
              submenu: [
                ...quickReplies.map((qr) => ({
                  label: `[${qr.key}] ${qr.text}`,
                  accelerator: `CmdOrCtrl+Shift+${qr.key}`,
                  click: () => sendQuickReply(qr.text),
                })),
                { type: "separator" },
                { label: "Edit Quick Replies...", click: () => editQuickReplies() },
              ],
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
            {
              label: `Quiet Hours (${getQuietHoursRangeLabel()})`,
              submenu: [
                {
                  label: "Enable",
                  type: "checkbox",
                  checked: quietHoursEnabled,
                  click: toggleQuietHours,
                },
                {
                  label: `Start: ${quietHoursStartLabel}`,
                  enabled: false,
                },
                {
                  label: `End: ${quietHoursEndLabel}`,
                  enabled: false,
                },
                { type: "separator" },
                { label: "Set Quiet Hours...", click: () => editQuietHours() },
              ],
            },
            { type: "separator" },
            {
              label: "[EXP] Auto-Reply (Away Mode)",
              submenu: [
                {
                  label: "Enable",
                  type: "checkbox",
                  checked: store.get("autoReplyEnabled"),
                  click: toggleAutoReply,
                },
                { label: "Edit Message...", click: editAutoReplyMessage },
              ],
            },
            {
              label: "[EXP] Export Conversation...",
              accelerator: "CmdOrCtrl+E",
              click: exportConversation,
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
            {
              label: "[EXP] Search in Conversation",
              accelerator: "CmdOrCtrl+F",
              click: searchInConversation,
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
            { type: "separator" },
            {
              label: "[EXP] Conversation Statistics",
              click: showConversationStats,
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

function ensureMainWindowVisible() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    if (!mainWindow.isVisible()) {
      mainWindow.show();
    }
    mainWindow.focus();
    hideChatHead();
    return;
  }
  if (!appState.isAppQuiting) {
    createWindow();
  }
}

function restoreMainWindowAfterClose(closedWindow) {
  if (appState.isAppQuiting) return;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (closedWindow === mainWindow) return;

  const otherVisible = BrowserWindow.getAllWindows().some(
    (win) => win !== mainWindow && win.isVisible()
  );

  if (!otherVisible && !mainWindow.isVisible()) {
    ensureMainWindowVisible();
  }
}

function isTrustedDisplayOrigin(origin) {
  if (!origin || typeof origin !== "string") return false;
  try {
    const url = new URL(origin);
    const host = url.hostname.toLowerCase();
    return (
      host === "www.messenger.com" ||
      host.endsWith(".messenger.com") ||
      host === "www.facebook.com" ||
      host.endsWith(".facebook.com")
    );
  } catch (_) {
    return false;
  }
}

function extractRequestOrigin(request) {
  return (
    request?.origin ||
    request?.securityOrigin ||
    request?.requestingOrigin ||
    request?.embeddingOrigin ||
    request?.frame?.url ||
    ""
  );
}

async function pickDisplaySource() {
  const sources = await desktopCapturer.getSources({
    types: ["screen", "window"],
    thumbnailSize: { width: 320, height: 200 },
    fetchWindowIcons: true,
  });

  if (!sources.length) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const message =
        process.platform === "darwin"
          ? "No screens are available. On macOS, enable Screen Recording permission for Messenger Unleashed in System Settings > Privacy & Security > Screen Recording, then relaunch the app."
          : "No screens are available for capture. Please retry and ensure screen sharing is allowed by your system.";
      dialog.showMessageBox(mainWindow, {
        type: "info",
        title: "Screen Sharing Unavailable",
        message,
      });
    }
    return null;
  }

  const options = sources.map((source) => ({
    id: source.id,
    label: source.name || "Untitled",
    detail: source.id.startsWith("screen:") ? "Screen" : "Window",
  }));

  const choice = await openSelectionDialog({
    title: "Share your screen",
    message: "Choose a screen or window to share with Messenger.",
    options,
  });

  if (!choice) return null;
  return sources.find((source) => source.id === choice) || null;
}

function createWindow() {
  const bounds = store.get("windowBounds");
  const debugWebSocketFrames = process.env.DEBUG_REQUEST_BLOCKER_WS === "1";
  const debugWebSocketFramesAll = process.env.DEBUG_REQUEST_BLOCKER_WS_ALL === "1";
  const debugWebSocketFramesDecode = process.env.DEBUG_REQUEST_BLOCKER_WS_DECODE === "1";

  mainWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    minWidth: 400,
    minHeight: 300,
    title: "Messenger Unleashed",
    alwaysOnTop: store.get("alwaysOnTop"),
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: store.get("spellCheck"),
    },
  });
  appState.mainWindow = mainWindow;

  mainWindow.webContents.setUserAgent(USER_AGENT);
  mainWindow.webContents.setMaxListeners(20);
  const webSocketUrls = new Map();

  const opacity = store.get("windowOpacity");
  if (opacity < 1.0) {
    mainWindow.setOpacity(opacity);
  }

  session.defaultSession.setPermissionRequestHandler(
    (webContents, permission, callback) => {
      const allowedPermissions = [
        "media",
        "display-capture",
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
        "display-capture",
        "mediaKeySystem",
        "geolocation",
        "notifications",
        "fullscreen",
        "pointerLock",
      ];
      return allowedPermissions.includes(permission);
    }
  );

  session.defaultSession.setDisplayMediaRequestHandler(
    async (request, callback) => {
      const origin = extractRequestOrigin(request);
      if (!isTrustedDisplayOrigin(origin)) {
        callback({ video: null });
        return;
      }

      try {
        const source = await pickDisplaySource();
        if (!source) {
          callback({ video: null });
          return;
        }
        callback({ video: source });
      } catch (error) {
        console.error("[Unleashed] Display media request failed:", error);
        callback({ video: null });
      }
    },
    { useSystemPicker: process.platform === "darwin" }
  );

  installLocalProbeBlocker();
  // apply request blockers before loading content (read receipts + typing indicator)
  updateRequestBlocker();

  // context menu for saving media
  mainWindow.webContents.on("context-menu", (event, params) => {
    const { mediaType, srcURL, linkURL } = params;

    // build context menu items
    const menuItems: MenuItemConstructorOptions[] = [];

    if (mediaType === "image" && srcURL) {
      menuItems.push({
        label: "Save Image...",
        click: async () => {
          try {
            const url = new URL(srcURL);
            const pathname = url.pathname.split('?')[0].split('#')[0];
            const ext = path.extname(pathname) || ".jpg";
            const filename = `messenger_image_${Date.now()}${ext}`;

            const { filePath } = await dialog.showSaveDialog(mainWindow, {
              title: "Save Image",
              defaultPath: filename,
              filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "gif", "webp"] }],
            });

            if (filePath) {
              const response = await session.defaultSession.fetch(srcURL);
              const buffer = Buffer.from(await response.arrayBuffer());
              fs.writeFileSync(filePath, buffer);
              mainWindow.webContents.send("show-toast", {
                message: `Image saved to ${path.basename(filePath)}`,
                tone: "success",
              });
            }
          } catch (err) {
            dialog.showErrorBox("Save Failed", err instanceof Error ? err.message : String(err));
          }
        },
      });
      menuItems.push({
        label: "Copy Image URL",
        click: () => {
          clipboard.writeText(srcURL);
          mainWindow.webContents.send("show-toast", { message: "Image URL copied", tone: "info" });
        },
      });
    }

    if (mediaType === "video" && srcURL) {
      menuItems.push({
        label: "Save Video...",
        click: async () => {
          try {
            const url = new URL(srcURL);
            const ext = path.extname(url.pathname) || ".mp4";
            const filename = `messenger_video_${Date.now()}${ext}`;

            const { filePath } = await dialog.showSaveDialog(mainWindow, {
              title: "Save Video",
              defaultPath: filename,
              filters: [{ name: "Videos", extensions: ["mp4", "webm", "mov"] }],
            });

            if (filePath) {
              const response = await session.defaultSession.fetch(srcURL);
              const buffer = Buffer.from(await response.arrayBuffer());
              fs.writeFileSync(filePath, buffer);
              mainWindow.webContents.send("show-toast", {
                message: `Video saved to ${path.basename(filePath)}`,
                tone: "success",
              });
            }
          } catch (err) {
            dialog.showErrorBox("Save Failed", err instanceof Error ? err.message : String(err));
          }
        },
      });
    }

    if (linkURL && !linkURL.match(/^(javascript|data|vbscript|file):/i)) {
      menuItems.push({
        label: "Open Link in Browser",
        click: () => shell.openExternal(linkURL),
      });
      menuItems.push({
        label: "Copy Link",
        click: () => {
          clipboard.writeText(linkURL);
          mainWindow.webContents.send("show-toast", { message: "Link copied", tone: "info" });
        },
      });
    }

    // add standard edit actions
    if (params.isEditable) {
      menuItems.push({ type: "separator" });
      menuItems.push({ role: "cut" });
      menuItems.push({ role: "copy" });
      menuItems.push({ role: "paste" });
      menuItems.push({ role: "selectAll" });
    } else if (params.selectionText) {
      menuItems.push({ type: "separator" });
      menuItems.push({ role: "copy" });
    }

    if (menuItems.length > 0) {
      const contextMenu = Menu.buildFromTemplate(menuItems);
      contextMenu.popup();
    }
  });

  if (debugWebSocketFrames || debugWebSocketFramesAll) {
    try {
      if (!mainWindow.webContents.debugger.isAttached()) {
        mainWindow.webContents.debugger.attach("1.3");
      }
      mainWindow.webContents.debugger.sendCommand("Network.enable");
      mainWindow.webContents.debugger.on("message", (event, method, params) => {
        if (method === "Network.webSocketCreated" && params && params.requestId) {
          webSocketUrls.set(params.requestId, params.url || "");
          return;
        }
        if (method === "Network.webSocketClosed" && params && params.requestId) {
          webSocketUrls.delete(params.requestId);
          return;
        }
        if (method !== "Network.webSocketFrameSent" && method !== "Network.webSocketFrameReceived") return;

        const response = params && params.response ? params.response : {};
        const payload = typeof response.payloadData === "string" ? response.payloadData : "";
        const opcode = response.opcode;
        const isText = opcode === 1;
        let decodedText = "";
        if (!isText && debugWebSocketFramesDecode && payload) {
          try {
            const decoded = Buffer.from(payload, "base64").toString("utf8");
            if (decoded && /[\x20-\x7E]/.test(decoded)) {
              decodedText = decoded;
            }
          } catch (_) {}
        }
        const searchable = (isText ? payload : decodedText).toLowerCase();
        const hasTyping = searchable.includes("typing");
        const hasPresence = searchable.includes("presence");
        const hasActive = searchable.includes("active");
        const hasRead = searchable.includes("read");
        const shouldLog =
          debugWebSocketFramesAll || hasTyping || hasPresence || hasActive || hasRead;

        if (shouldLog) {
          const direction = method === "Network.webSocketFrameSent" ? "WS-SEND" : "WS-RECV";
          const url = webSocketUrls.get(params.requestId) || "";
          let preview = ` payloadLen=${payload.length}`;
          if (isText && payload.length) {
            preview = ` payload=${payload.slice(0, 300)}`;
          } else if (decodedText) {
            preview = ` payloadDecoded=${decodedText.slice(0, 300)}`;
          }
          console.log(
            `[Unleashed] [${direction}]${url ? ` ${url}` : ""} opcode=${opcode} typing=${hasTyping} presence=${hasPresence} active=${hasActive} read=${hasRead}${preview}`
          );
        }
      });
    } catch (error) {
      console.log(`[Unleashed] [WS-DEBUG] Failed to attach debugger: ${error.message}`);
    }
  }

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
        { cssKey: "focus-mode" } as any
      );
    }

    applyCustomCSS();
    applyAndroidBubbles();
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
    mainWindow.webContents.send(
      "set-exp-typing-overlay",
      store.get("expTypingOverlay")
    );
    mainWindow.webContents.send(
      "set-unsend-detection",
      store.get("unsendDetection")
    );
    mainWindow.webContents.send(
      "set-link-preview-blocking",
      store.get("linkPreviewBlocking")
    );

    ensureWebSocketProxyInstalled();

    applyModernLook();
    applyFloatingGlass();
    applyUICleanup();
    applyFontSize();

    // apply screenshot protection if enabled
    if (store.get("screenshotProtection")) {
      mainWindow.setContentProtection(true);
    }
  });

  mainWindow.webContents.on("did-frame-finish-load", () => {
    ensureWebSocketProxyInstalled();
  });

  mainWindow.on("closed", () => {
    try {
      if (mainWindow && mainWindow.webContents && mainWindow.webContents.debugger.isAttached()) {
        mainWindow.webContents.debugger.detach();
      }
    } catch (_) {}
  });

  mainWindow.on("minimize", () => {
    showChatHeadIfAvailable();
  });

  mainWindow.on("restore", () => {
    hideChatHead();
  });

  mainWindow.on("show", () => {
    hideChatHead();
  });

  mainWindow.on("hide", () => {
    showChatHeadIfAvailable();
  });

  mainWindow.on("resize", () => {
    const { width, height } = mainWindow.getBounds();
    store.set("windowBounds", { width, height });
  });

  mainWindow.on("close", (event) => {
    if (!appState.isAppQuiting) {
      event.preventDefault();
      mainWindow.hide();
      showChatHeadIfAvailable();
    }
    return false;
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
    appState.mainWindow = null;
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

  // Suppress Permissions Policy: unload violations
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders = { ...details.responseHeaders };
    responseHeaders["Permissions-Policy"] = ["unload=*"];
    callback({ responseHeaders });
  });
}

app.on("ready", () => {
  refreshGlobalShortcuts();

  // listen for system theme changes
  nativeTheme.on("updated", () => {
    if (store.get("systemThemeSync")) {
      applySystemTheme();
    }
  });

  // apply system theme on startup if enabled
  if (store.get("systemThemeSync")) {
    applySystemTheme();
  }
});

app.on("browser-window-created", (event, window) => {
  window.on("closed", () => {
    restoreMainWindowAfterClose(window);
  });
});

function registerGlobalShortcuts() {
  globalShortcut.unregisterAll();

  const shortcuts = store.get("shortcuts") || {};

  if (shortcuts.toggleAlwaysOnTop) globalShortcut.register(shortcuts.toggleAlwaysOnTop, toggleAlwaysOnTop);
  if (shortcuts.toggleDoNotDisturb) globalShortcut.register(shortcuts.toggleDoNotDisturb, toggleDoNotDisturb);
  if (shortcuts.toggleFocusMode) globalShortcut.register(shortcuts.toggleFocusMode, toggleFocusMode);
  if (shortcuts.createPipWindow) globalShortcut.register(shortcuts.createPipWindow, createPipWindow);
  if (shortcuts.focusSearch) globalShortcut.register(shortcuts.focusSearch, focusSearch);
  if (shortcuts.scheduleSendNow) globalShortcut.register(shortcuts.scheduleSendNow, scheduleSendNow);
  
  if (shortcuts.bossKey) globalShortcut.register(shortcuts.bossKey, toggleChameleonMode);

  globalShortcut.register("CmdOrCtrl+Up", () => navigateConversation("up"));
  globalShortcut.register("CmdOrCtrl+Down", () => navigateConversation("down"));

  const quickReplies = store.get("quickReplies");
  (quickReplies || []).forEach((qr) => {
    if (!qr || !qr.key || typeof qr.key !== "string") return;
    const key = qr.key.trim().toUpperCase();
    if (!/^[A-Z0-9]$/.test(key)) return;
    globalShortcut.register(`CmdOrCtrl+Shift+${key}`, () =>
      sendQuickReply(qr.text)
    );
  });

  shortcutsRegistered = true;
  shortcutsDirty = false;
}

function refreshGlobalShortcuts() {
  shortcutsDirty = true;
  if (isAnyWindowFocused()) {
    registerGlobalShortcuts();
  }
}

function isAnyWindowFocused() {
  return BrowserWindow.getAllWindows().some((win) => win.isFocused());
}

function maybeDisableGlobalShortcuts() {
  setTimeout(() => {
    if (!isAnyWindowFocused()) {
      if (shortcutsRegistered) {
        globalShortcut.unregisterAll();
        shortcutsRegistered = false;
      }
    }
  }, 120);
}

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
  startQuietHoursMonitor();
  checkForUpdates();

  app.on("activate", () => {
    ensureMainWindowVisible();
  });
});

app.on("browser-window-focus", () => {
  if (!shortcutsRegistered || shortcutsDirty) {
    registerGlobalShortcuts();
  }
});

app.on("browser-window-blur", () => {
  maybeDisableGlobalShortcuts();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  appState.isAppQuiting = true;
  if (quietHoursTimer) {
    clearInterval(quietHoursTimer);
    quietHoursTimer = null;
  }
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});
