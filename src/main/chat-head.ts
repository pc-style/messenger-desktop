import { BrowserWindow, ipcMain, screen } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appState, store } from "./state.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CHAT_HEAD_PRELOAD = path.join(__dirname, "../preload/chat-head.js");

let chatHeadWindow: BrowserWindow | null = null;
let activeChatInfo: { src?: string } | null = null;
const LAST_CHAT_HEAD_KEY = "lastChatHeadSrc";

export function initChatHeadIPC() {
  ipcMain.on("update-active-chat", (event, info) => {
    if (info && info.src) {
      activeChatInfo = info;
      store.set(LAST_CHAT_HEAD_KEY, info.src);
    }
    if (chatHeadWindow && !chatHeadWindow.isDestroyed()) {
      chatHeadWindow.webContents.send("update-head", info);
    }
  });

  ipcMain.on("chat-head-clicked", () => {
    if (appState.mainWindow) {
      if (appState.mainWindow.isMinimized()) appState.mainWindow.restore();
      appState.mainWindow.show();
      appState.mainWindow.focus();
    }
    if (chatHeadWindow) chatHeadWindow.hide();
  });
}

export function hideChatHead() {
  if (chatHeadWindow) {
    chatHeadWindow.hide();
  }
}

export function showChatHeadIfAvailable() {
  const fallbackSrc = store.get(LAST_CHAT_HEAD_KEY) as string | undefined;
  if ((activeChatInfo && activeChatInfo.src) || fallbackSrc) {
    createChatHead(activeChatInfo?.src || fallbackSrc);
    return;
  }
  createChatHead();
}

export function createChatHead(initialSrc?: string) {
  if (chatHeadWindow && !chatHeadWindow.isDestroyed()) {
    chatHeadWindow.show();
    chatHeadWindow.webContents.send("update-head", activeChatInfo || { src: initialSrc });
    return;
  }

  const primaryDisplay = screen.getPrimaryDisplay();
  const { width } = primaryDisplay.workAreaSize;

  chatHeadWindow = new BrowserWindow({
    width: 70,
    height: 70,
    x: width - 90,
    y: 100,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    hasShadow: false,
    skipTaskbar: true,
    webPreferences: {
      preload: CHAT_HEAD_PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const html = `
    <html>
      <body style="margin:0; padding:5px; overflow:hidden; background:transparent; -webkit-app-region: drag;">
        <div id="avatar" style="width:54px; height:54px; border-radius:50%; background-color:#333; background-size:cover; background-position:center; border:3px solid #7b61ff; box-shadow: 0 4px 12px rgba(0,0,0,0.5); cursor:pointer; transition: transform 0.1s; display:flex; align-items:center; justify-content:center; color:#fff; font-family: sans-serif; font-weight: 700; -webkit-app-region: no-drag;">M</div>
        <script>
          const avatar = document.getElementById('avatar');
          const setAvatar = (src) => {
            if (src) {
              avatar.style.backgroundImage = 'url(' + src + ')';
              avatar.textContent = '';
            } else {
              avatar.style.backgroundImage = 'none';
              avatar.textContent = 'M';
            }
          };
          avatar.onclick = () => window.chatHeadAPI?.notifyClick();
          avatar.onmouseenter = () => avatar.style.transform = 'scale(1.1)';
          avatar.onmouseleave = () => avatar.style.transform = 'scale(1.0)';
          window.chatHeadAPI?.onUpdate((info) => {
            setAvatar(info && info.src);
          });
          setAvatar(${JSON.stringify(initialSrc || "")});
        </script>
      </body>
    </html>
  `;

  chatHeadWindow.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));

  chatHeadWindow.webContents.on("did-finish-load", () => {
    if (activeChatInfo) {
      chatHeadWindow?.webContents.send("update-head", activeChatInfo);
    }
  });
}
