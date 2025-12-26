import { BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appState } from "./state.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DIALOG_PRELOAD = path.join(__dirname, "../preload/dialog.js");

function escapeHTML(value: string) {
  return (value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export async function openInputDialog({
  title,
  message,
  defaultValue = "",
  multiline = false,
}: {
  title?: string;
  message?: string;
  defaultValue?: string;
  multiline?: boolean;
}) {
  return new Promise<string | null>((resolve) => {
    const channel = `dialog-result-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}`;

    const inputWindow = new BrowserWindow({
      width: 420,
      height: multiline ? 320 : 220,
      parent: appState.mainWindow || undefined,
      modal: !!appState.mainWindow,
      show: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      autoHideMenuBar: true,
      webPreferences: {
        preload: DIALOG_PRELOAD,
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
      resolve((value as string | null) ?? null);
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

export async function openSelectionDialog({
  title,
  message,
  options = [],
}: {
  title?: string;
  message?: string;
  options?: Array<{ id: string; label: string; detail?: string }>;
}) {
  if (!options.length) return null;

  return new Promise<string | null>((resolve) => {
    const channel = `dialog-result-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}`;

    const estimatedHeight = Math.min(620, 220 + options.length * 36);
    const selectionWindow = new BrowserWindow({
      width: 520,
      height: estimatedHeight,
      parent: appState.mainWindow || undefined,
      modal: !!appState.mainWindow,
      show: false,
      resizable: true,
      minimizable: false,
      maximizable: false,
      autoHideMenuBar: true,
      webPreferences: {
        preload: DIALOG_PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        additionalArguments: [`--dialog-channel=${channel}`],
      },
    });

    const listMarkup = options
      .map((option) => {
        const label = escapeHTML(option.label || "Untitled");
        const detail = option.detail
          ? `<span class="detail">${escapeHTML(option.detail)}</span>`
          : "";
        return `
          <button class="option" data-id="${escapeHTML(option.id)}">
            <span class="label">${label}</span>
            ${detail}
          </button>
        `;
      })
      .join("");

    const html = `<!DOCTYPE html>
      <html>
      <head>
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline';" />
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; padding: 16px; background: #1e1e1e; color: #f0f0f0; }
          h3 { margin: 0 0 8px 0; font-size: 16px; }
          p { margin: 0 0 12px 0; font-size: 13px; color: #b0b0b0; }
          .options { display: flex; flex-direction: column; gap: 8px; max-height: 420px; overflow-y: auto; padding-right: 4px; }
          .option { text-align: left; border: 1px solid #3a3a3a; background: #252525; color: #f0f0f0; padding: 10px 12px; border-radius: 8px; cursor: pointer; display: flex; flex-direction: column; gap: 4px; }
          .option:hover { border-color: #0084ff; background: #2c2c2c; }
          .label { font-size: 13px; font-weight: 600; }
          .detail { font-size: 11px; color: #9a9a9a; }
          .buttons { margin-top: 14px; text-align: right; }
          button.cancel { padding: 8px 14px; border: none; border-radius: 6px; cursor: pointer; font-size: 13px; background: #444; color: #fff; }
        </style>
      </head>
      <body>
        <h3>${escapeHTML(title || "Select Source")}</h3>
        <p>${escapeHTML(message || "Choose a screen or window to share.")}</p>
        <div class="options">${listMarkup}</div>
        <div class="buttons">
          <button class="cancel" onclick="window.dialogAPI.cancel()">Cancel</button>
        </div>
        <script>
          document.querySelectorAll('.option').forEach((btn) => {
            btn.addEventListener('click', () => window.dialogAPI.submit(btn.dataset.id))
          })
          document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') window.dialogAPI.cancel()
          })
        </script>
      </body>
      </html>`;

    ipcMain.once(channel, (_, value) => {
      if (!selectionWindow.isDestroyed()) selectionWindow.close();
      resolve((value as string | null) ?? null);
    });

    selectionWindow.on("closed", () => {
      resolve(null);
    });

    selectionWindow.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
    );

    selectionWindow.once("ready-to-show", () => {
      selectionWindow.show();
    });
  });
}
