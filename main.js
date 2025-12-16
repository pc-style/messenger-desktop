const { app, BrowserWindow, session, Menu, ipcMain, Notification, dialog, nativeImage } = require('electron')
const path = require('path')
const fs = require('fs')
const Store = require('electron-store')

const store = new Store({
  defaults: {
    alwaysOnTop: false,
    theme: 'default', // default, oled, compact, nord, dracula, solarized, highcontrast
    doNotDisturb: false,
    windowBounds: { width: 1200, height: 800 },
    launchAtLogin: false,
    focusMode: false,
    quickReplies: [
      { key: '1', text: 'On my way!' },
      { key: '2', text: 'Be right back' },
      { key: '3', text: 'Sounds good!' }
    ],
    menuBarMode: false,
    blockReadReceipts: false,
    spellCheck: true,
    keywordAlerts: ['urgent', 'asap'],
    keywordAlertsEnabled: true,
    clipboardSanitize: true,
    scheduleDelayMs: 30000,
    blockTypingIndicator: false,
    windowOpacity: 1.0,
    customCSS: ''
  }
})

// chrome user agent for webrtc compatibility
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

let mainWindow = null
let pipWindow = null
let tray = null
let unreadCount = 0

// handle native notifications from renderer
ipcMain.on('show-notification', (event, data) => {
  if (store.get('doNotDisturb')) return

  const notification = new Notification({
    title: data.title || 'Messenger',
    body: data.body || '',
    silent: data.silent || false,
    icon: path.join(__dirname, 'icon.icns')
  })

  notification.on('click', () => {
    if (mainWindow) {
      mainWindow.show()
      mainWindow.focus()
    }
    event.sender.send('notification-clicked')
  })

  notification.show()
})

function getThemeCSS(theme) {
  const themesPath = path.join(__dirname, 'themes.css')
  const allCSS = fs.readFileSync(themesPath, 'utf8')

  if (theme === 'default') return ''

  // extract the relevant theme section
  const themeRegex = new RegExp(`\\/\\* ${theme} \\*\\/([\\s\\S]*?)(?=\\/\\* \\w+ \\*\\/|$)`)
  const match = allCSS.match(themeRegex)
  return match ? match[1] : ''
}

function applyThemeCSS(theme) {
  // applies theme CSS without reloading - used after page load
  if (!mainWindow) return

  const css = getThemeCSS(theme)
  mainWindow.webContents.removeInsertedCSS('theme').catch(() => {})

  if (css) {
    mainWindow.webContents.insertCSS(css, { cssKey: 'theme' }).catch(() => {})
  }
}

function applyTheme(theme) {
  if (!mainWindow) return

  store.set('theme', theme)
  updateMenu()

  // reload to fully apply the theme since CSS injection doesn't catch all elements
  mainWindow.webContents.reloadIgnoringCache()
}

function toggleAlwaysOnTop() {
  const current = store.get('alwaysOnTop')
  store.set('alwaysOnTop', !current)
  mainWindow.setAlwaysOnTop(!current)
  updateMenu()
}

function toggleDoNotDisturb() {
  const current = store.get('doNotDisturb')
  store.set('doNotDisturb', !current)
  updateMenu()
}

function toggleLaunchAtLogin() {
  const current = store.get('launchAtLogin')
  const newValue = !current

  const canSetLogin =
    process.platform !== 'darwin' ||
    (app.isInApplicationsFolder && app.isInApplicationsFolder())

  if (canSetLogin) {
    try {
      app.setLoginItemSettings({
        openAtLogin: newValue,
        openAsHidden: false
      })
    } catch (err) {
      console.warn('Failed to set login item', err)
    }
  } else {
    console.warn('Skipping login item update (app not in /Applications or unsupported platform state)')
  }

  store.set('launchAtLogin', newValue)
  updateMenu()
}

function toggleFocusMode() {
  const current = store.get('focusMode')
  const newValue = !current
  store.set('focusMode', newValue)

  if (!mainWindow) return

  if (newValue) {
    mainWindow.webContents.insertCSS(`
      div[aria-label="Chats"],
      div[role="navigation"] { display: none !important; }
      div[role="main"] { width: 100% !important; max-width: 100% !important; }
    `, { cssKey: 'focus-mode' })
  } else {
    // reload to properly restore sidebar since CSS removal doesn't always work
    mainWindow.webContents.reloadIgnoringCache()
  }

  updateMenu()
}

function reloadMessenger() {
  if (!mainWindow) return
  mainWindow.webContents.reloadIgnoringCache()
}

function sendQuickReply(text) {
  if (!mainWindow) return
  mainWindow.webContents.executeJavaScript(`
    (function() {
      const input = document.querySelector('[contenteditable="true"][role="textbox"]')
      if (!input) return false
      input.focus()
      document.execCommand('insertText', false, ${JSON.stringify(text)})
      const event = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true })
      input.dispatchEvent(event)
      return true
    })()
  `)
}

function toggleMenuBarMode() {
  const current = store.get('menuBarMode')
  const newValue = !current
  store.set('menuBarMode', newValue)

  if (newValue) {
    const success = createTray()
    if (success && mainWindow) {
      mainWindow.setSkipTaskbar(true)
      // hide window and dock when entering menu bar mode
      mainWindow.hide()
      if (process.platform === 'darwin' && app.dock) app.dock.hide()
    }
    if (!success) {
      store.set('menuBarMode', false)
      dialog.showErrorBox('Menu Bar Mode', 'Failed to create tray icon.')
    }
  } else {
    if (tray) {
      tray.destroy()
      tray = null
    }
    if (mainWindow) {
      mainWindow.setSkipTaskbar(false)
      mainWindow.show()
      mainWindow.focus()
    }
    if (process.platform === 'darwin' && app.dock) app.dock.show()
  }

  updateMenu()
}

function createTray() {
  if (tray) return true

  const { Tray } = require('electron')

  try {
    // prefer the pre-sized tray PNG, fall back to other icons
    let iconPath = path.join(__dirname, 'trayIcon.png')
    if (!fs.existsSync(iconPath)) {
      iconPath = path.join(__dirname, 'icon.png')
    }
    if (!fs.existsSync(iconPath)) {
      iconPath = path.join(__dirname, 'icon.ico')
    }
    if (!fs.existsSync(iconPath)) {
      iconPath = path.join(__dirname, 'icon.icns')
    }

    if (!fs.existsSync(iconPath)) {
      console.error('No icon file found for tray')
      return false
    }

    const trayIcon = nativeImage.createFromPath(iconPath)
    if (trayIcon.isEmpty()) {
      console.error('Failed to load tray icon from:', iconPath)
      return false
    }

    // resize to appropriate size for menu bar (16x16 on macOS, 16x16 on Windows)
    const resized = trayIcon.resize({ width: 16, height: 16 })
    if (process.platform === 'darwin') resized.setTemplateImage(true)

    tray = new Tray(resized)
    tray.setToolTip('Messenger Unleashed')
    if (tray.setTitle) tray.setTitle(unreadCount > 0 ? ` ${unreadCount}` : '')

    tray.on('click', () => {
      if (mainWindow) {
        if (mainWindow.isVisible()) {
          mainWindow.hide()
          if (process.platform === 'darwin' && app.dock) app.dock.hide()
        } else {
          mainWindow.show()
          mainWindow.focus()
          if (process.platform === 'darwin' && app.dock) app.dock.show()
        }
      }
    })

    tray.on('right-click', () => {
      if (mainWindow) {
        mainWindow.show()
        mainWindow.focus()
        if (process.platform === 'darwin' && app.dock) app.dock.show()
      }
    })

    return true
  } catch (err) {
    console.error('Failed to create tray:', err)
    return false
  }
}

function toggleBlockReadReceipts() {
  const current = store.get('blockReadReceipts')
  const newValue = !current
  store.set('blockReadReceipts', newValue)

  if (!mainWindow) return

  if (newValue) {
    // block visibility API to prevent read receipts
    mainWindow.webContents.executeJavaScript(`
      (function() {
        Object.defineProperty(document, 'hidden', { value: true, writable: false })
        Object.defineProperty(document, 'visibilityState', { value: 'hidden', writable: false })
        document.dispatchEvent(new Event('visibilitychange'))
      })()
    `)
  } else {
    // reload to restore normal behavior
    mainWindow.webContents.reload()
  }

  updateMenu()
}

function focusSearch() {
  if (!mainWindow) return
  mainWindow.webContents.executeJavaScript(`
    (function() {
      const search = document.querySelector('input[aria-label="Search Messenger"], input[placeholder*="Search"], input[type="search"]');
      if (!search) return false;
      search.focus();
      if (search.select) search.select();
      return true;
    })()
  `).catch(() => {})
}

function setScheduleDelay(delayMs) {
  store.set('scheduleDelayMs', delayMs)
  pushRendererConfig()
  updateMenu()
}

function scheduleSendNow() {
  if (!mainWindow) return
  const delay = store.get('scheduleDelayMs')
  mainWindow.webContents.send('schedule-send', delay)
}

function toggleClipboardSanitize() {
  const next = !store.get('clipboardSanitize')
  store.set('clipboardSanitize', next)
  pushRendererConfig()
  updateMenu()
}

function toggleKeywordAlerts() {
  const next = !store.get('keywordAlertsEnabled')
  store.set('keywordAlertsEnabled', next)
  pushRendererConfig()
  updateMenu()
}

function editKeywordAlerts() {
  if (!mainWindow) return
  const existing = store.get('keywordAlerts').join(', ')
  mainWindow.webContents.executeJavaScript(`prompt('Keyword alerts (comma separated)', ${JSON.stringify(existing)})`)
    .then(result => {
      if (typeof result !== 'string') return
      const list = result.split(',').map(k => k.trim()).filter(Boolean)
      store.set('keywordAlerts', list)
      pushRendererConfig()
      updateMenu()
    })
    .catch(() => {})
}

function pushRendererConfig() {
  if (!mainWindow) return
  const config = {
    keywordAlerts: store.get('keywordAlerts'),
    keywordAlertsEnabled: store.get('keywordAlertsEnabled'),
    clipboardSanitize: store.get('clipboardSanitize'),
    scheduleDelayMs: store.get('scheduleDelayMs')
  }

  mainWindow.webContents.send('update-config', config)

  // bootstrap renderer helper only once; subsequent calls just refresh config
  mainWindow.webContents.executeJavaScript(`
    (function() {
      const cfg = ${JSON.stringify(config)};
      window.__unleashedConfig = cfg;
      if (window.__unleashedBootstrapped) return;
      window.__unleashedBootstrapped = true;

      window.addEventListener('unleashed-config', (e) => {
        window.__unleashedConfig = e.detail || {};
      });

      // keyword alerts
      (function setupKeywordAlerts() {
        const seenNodes = new WeakSet();
        const getKeywords = () => (window.__unleashedConfig?.keywordAlerts || []).map(k => k.toLowerCase().trim()).filter(Boolean);
        const enabled = () => !!window.__unleashedConfig?.keywordAlertsEnabled;
        const notifyHit = (text) => {
          if (!enabled()) return;
          const kws = getKeywords();
          if (!kws.length) return;
          const lower = text.toLowerCase();
          const hit = kws.find(k => lower.includes(k));
          if (!hit) return;
          if (window.electronNotify) {
            window.electronNotify.send('Keyword alert: ' + hit, { body: text.slice(0, 140) });
          }
        };

        const observer = new MutationObserver((mutations) => {
          mutations.forEach(m => {
            m.addedNodes.forEach(node => {
              if (!(node instanceof HTMLElement)) return;
              if (seenNodes.has(node)) return;
              seenNodes.add(node);
              const text = node.innerText || '';
              if (text) notifyHit(text);
            });
          });
        });

        observer.observe(document.body, { childList: true, subtree: true });
      })();

      // clipboard sanitizer
      document.addEventListener('paste', (event) => {
        if (!window.__unleashedConfig?.clipboardSanitize) return;
        const text = event.clipboardData?.getData('text/plain');
        if (!text) return;
        try {
          const url = new URL(text);
          const params = ['utm_source','utm_medium','utm_campaign','utm_term','utm_content','utm_id','fbclid','gclid','yclid','mc_cid','mc_eid','ref','ref_src'];
          params.forEach(p => url.searchParams.delete(p));
          event.preventDefault();
          document.execCommand('insertText', false, url.toString());
        } catch (_) {
          // not a URL; leave default paste
        }
      }, true);

      // scheduled send
      window.addEventListener('unleashed-schedule-send', (e) => {
        const delay = e.detail?.delayMs ?? window.__unleashedConfig?.scheduleDelayMs ?? 0;
        const input = document.querySelector('[contenteditable="true"][role="textbox"]');
        if (!input) return;
        const saved = input.innerHTML;
        const banner = document.createElement('div');
        banner.textContent = 'Scheduled send in ' + Math.round(delay / 1000) + 's';
        Object.assign(banner.style, {
          position: 'fixed',
          bottom: '20px',
          right: '20px',
          padding: '10px 14px',
          background: 'rgba(0,0,0,0.8)',
          color: '#fff',
          borderRadius: '8px',
          zIndex: '999999',
          fontSize: '13px'
        });
        document.body.appendChild(banner);
        setTimeout(() => banner.remove(), delay + 6000);

        setTimeout(() => {
          input.focus();
          input.innerHTML = saved;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          const eventEnter = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true });
          input.dispatchEvent(eventEnter);
        }, delay);
      });
    })();
  `).catch(() => {})
}

function updateUnreadBadge(count) {
  unreadCount = count
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setBadge(count > 0 ? String(count) : '')
  }
  if (tray && tray.setTitle) {
    tray.setTitle(count > 0 ? ` ${count}` : '')
  }
}

function toggleSpellCheck() {
  const current = store.get('spellCheck')
  const newValue = !current
  store.set('spellCheck', newValue)

  // show dialog that restart is needed
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'Restart Required',
    message: 'Please restart the app for spell check changes to take effect.',
    buttons: ['OK']
  })

  updateMenu()
}

function toggleBlockTypingIndicator() {
  const current = store.get('blockTypingIndicator')
  const newValue = !current
  store.set('blockTypingIndicator', newValue)

  if (!mainWindow) return

  if (newValue) {
    // block typing indicator by intercepting input events
    mainWindow.webContents.executeJavaScript(`
      (function() {
        if (window.__typingBlockerInstalled) return;
        window.__typingBlockerInstalled = true;

        // intercept XMLHttpRequest to block typing indicator requests
        const origSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.send = function(body) {
          if (body && typeof body === 'string' && body.includes('typing')) {
            return; // block typing indicator requests
          }
          return origSend.apply(this, arguments);
        };

        // also block fetch requests for typing
        const origFetch = window.fetch;
        window.fetch = function(url, options) {
          if (options?.body && typeof options.body === 'string' && options.body.includes('typing')) {
            return Promise.resolve(new Response('{}'));
          }
          return origFetch.apply(this, arguments);
        };
      })()
    `)
  } else {
    mainWindow.webContents.reload()
  }

  updateMenu()
}

function setWindowOpacity(opacity) {
  store.set('windowOpacity', opacity)
  if (mainWindow) {
    mainWindow.setOpacity(opacity)
  }
  updateMenu()
}

function navigateConversation(direction) {
  if (!mainWindow) return
  mainWindow.webContents.executeJavaScript(`
    (function() {
      // find chat list items in sidebar - try multiple selectors for Messenger's DOM
      const chatList = document.querySelector('div[aria-label="Chats"]') ||
                       document.querySelector('div[role="navigation"]');
      if (!chatList) return;

      // get clickable chat rows - look for links or grid cells with aria-label
      const rows = Array.from(chatList.querySelectorAll('a[href*="/t/"], div[role="gridcell"][aria-label], div[role="row"] a'));
      if (!rows.length) return;

      // find currently selected/focused chat
      const active = document.querySelector('a[aria-current="page"]') ||
                     document.activeElement;
      let currentIdx = rows.findIndex(r => r.contains(active) || r === active || r.getAttribute('aria-current') === 'page');

      // if no current selection, start from beginning or end based on direction
      if (currentIdx === -1) {
        currentIdx = ${direction === 'up' ? 'rows.length' : '-1'};
      }

      const nextIdx = ${direction === 'up' ? 'Math.max(0, currentIdx - 1)' : 'Math.min(rows.length - 1, currentIdx + 1)'};
      const target = rows[nextIdx];
      if (target) {
        target.click();
        target.focus();
      }
    })()
  `).catch(() => {})
}

function editCustomCSS() {
  if (!mainWindow) return
  const existing = store.get('customCSS')
  mainWindow.webContents.executeJavaScript(`prompt('Enter custom CSS (will be injected on page load):', ${JSON.stringify(existing)})`)
    .then(result => {
      if (typeof result !== 'string') return
      store.set('customCSS', result)
      applyCustomCSS()
      updateMenu()
    })
    .catch(() => {})
}

function applyCustomCSS() {
  if (!mainWindow) return
  const css = store.get('customCSS')
  mainWindow.webContents.removeInsertedCSS('custom-css').catch(() => {})
  if (css) {
    mainWindow.webContents.insertCSS(css, { cssKey: 'custom-css' }).catch(() => {})
  }
}

function clearCustomCSS() {
  store.set('customCSS', '')
  if (mainWindow) {
    mainWindow.webContents.removeInsertedCSS('custom-css').catch(() => {})
  }
  updateMenu()
}

async function exportCookies() {
  const { filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Export Session',
    defaultPath: 'messenger-session.json',
    filters: [{ name: 'JSON', extensions: ['json'] }]
  })

  if (!filePath) return

  try {
    const cookies = await session.defaultSession.cookies.get({ url: 'https://www.messenger.com' })
    const facebookCookies = await session.defaultSession.cookies.get({ url: 'https://www.facebook.com' })
    const allCookies = [...cookies, ...facebookCookies]

    fs.writeFileSync(filePath, JSON.stringify(allCookies, null, 2))
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Export Complete',
      message: `Exported ${allCookies.length} cookies`
    })
  } catch (err) {
    dialog.showErrorBox('Export Failed', err.message)
  }
}

async function importCookies() {
  const { filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Import Session',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile']
  })

  if (!filePaths || filePaths.length === 0) return

  try {
    const data = fs.readFileSync(filePaths[0], 'utf8')
    const cookies = JSON.parse(data)

    for (const cookie of cookies) {
      const url = `https://${cookie.domain.replace(/^\./, '')}${cookie.path}`
      await session.defaultSession.cookies.set({
        url,
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        expirationDate: cookie.expirationDate
      })
    }

    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Import Complete',
      message: `Imported ${cookies.length} cookies. Reloading...`
    })

    mainWindow.webContents.reload()
  } catch (err) {
    dialog.showErrorBox('Import Failed', err.message)
  }
}

async function clearSession() {
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: 'Clear Session',
    message: 'This will log you out. Continue?',
    buttons: ['Cancel', 'Clear']
  })

  if (response === 1) {
    await session.defaultSession.clearStorageData()
    mainWindow.webContents.reload()
  }
}

function createPipWindow() {
  if (pipWindow) {
    pipWindow.focus()
    return
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
      nodeIntegration: false
    }
  })

  pipWindow.loadURL('https://www.messenger.com')
  pipWindow.webContents.setUserAgent(USER_AGENT)

  // escape to close
  pipWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'Escape') {
      pipWindow.close()
    }
  })

  // inject close button after page loads
  pipWindow.webContents.on('did-finish-load', () => {
    pipWindow.webContents.executeJavaScript(`
      (function() {
        const closeBtn = document.createElement('div')
        closeBtn.innerHTML = '×'
        closeBtn.style.cssText = \`
          position: fixed; top: 8px; right: 8px;
          width: 24px; height: 24px;
          background: rgba(0,0,0,0.6); color: white;
          border-radius: 50%; display: flex;
          align-items: center; justify-content: center;
          cursor: pointer; z-index: 999999;
          font-size: 18px; font-weight: bold;
          transition: background 0.2s;
          -webkit-app-region: no-drag;
        \`
        closeBtn.onmouseover = () => closeBtn.style.background = 'rgba(255,0,0,0.8)'
        closeBtn.onmouseout = () => closeBtn.style.background = 'rgba(0,0,0,0.6)'
        closeBtn.onclick = () => window.close()
        document.body.appendChild(closeBtn)
      })()
    `)
  })

  pipWindow.on('closed', () => {
    pipWindow = null
  })
}

function updateMenu() {
  const alwaysOnTop = store.get('alwaysOnTop')
  const theme = store.get('theme')
  const dnd = store.get('doNotDisturb')
  const launchAtLogin = store.get('launchAtLogin')
  const focusMode = store.get('focusMode')
  const quickReplies = store.get('quickReplies')
  const menuBarMode = store.get('menuBarMode')
  const blockReadReceipts = store.get('blockReadReceipts')
  const spellCheck = store.get('spellCheck')
  const scheduleDelayMs = store.get('scheduleDelayMs')
  const clipboardSanitize = store.get('clipboardSanitize')
  const keywordAlertsEnabled = store.get('keywordAlertsEnabled')
  const blockTypingIndicator = store.get('blockTypingIndicator')
  const windowOpacity = store.get('windowOpacity')
  const customCSS = store.get('customCSS')

  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' }
      ]
    },
    {
      label: 'Unleashed',
      submenu: [
        {
          label: 'Always on Top',
          type: 'checkbox',
          checked: alwaysOnTop,
          accelerator: 'CmdOrCtrl+Shift+T',
          click: toggleAlwaysOnTop
        },
        { type: 'separator' },
        {
          label: 'Theme',
          submenu: [
            {
              label: 'Default',
              type: 'radio',
              checked: theme === 'default',
              click: () => applyTheme('default')
            },
            { type: 'separator' },
            {
              label: 'OLED Dark',
              type: 'radio',
              checked: theme === 'oled',
              click: () => applyTheme('oled')
            },
            {
              label: 'Nord',
              type: 'radio',
              checked: theme === 'nord',
              click: () => applyTheme('nord')
            },
            {
              label: 'Dracula',
              type: 'radio',
              checked: theme === 'dracula',
              click: () => applyTheme('dracula')
            },
            {
              label: 'Solarized Dark',
              type: 'radio',
              checked: theme === 'solarized',
              click: () => applyTheme('solarized')
            },
            {
              label: 'High Contrast',
              type: 'radio',
              checked: theme === 'highcontrast',
              click: () => applyTheme('highcontrast')
            },
            { type: 'separator' },
            {
              label: 'Compact',
              type: 'radio',
              checked: theme === 'compact',
              click: () => applyTheme('compact')
            }
          ]
        },
        { type: 'separator' },
        {
          label: 'Focus Mode',
          type: 'checkbox',
          checked: focusMode,
          accelerator: 'CmdOrCtrl+Shift+F',
          click: toggleFocusMode
        },
        {
          label: 'Do Not Disturb',
          type: 'checkbox',
          checked: dnd,
          accelerator: 'CmdOrCtrl+Shift+D',
          click: toggleDoNotDisturb
        },
        { type: 'separator' },
        {
          label: 'Quick Replies',
          submenu: quickReplies.map(qr => ({
            label: `Send: ${qr.text}`,
            accelerator: `CmdOrCtrl+Shift+${qr.key}`,
            click: () => sendQuickReply(qr.text)
          }))
        },
        { type: 'separator' },
        {
          label: 'Focus Search',
          accelerator: 'CmdOrCtrl+K',
          click: focusSearch
        },
        {
          label: `Send in ${Math.round(scheduleDelayMs / 1000)}s`,
          accelerator: 'CmdOrCtrl+Alt+Enter',
          click: scheduleSendNow
        },
        {
          label: 'Schedule Delay',
          submenu: [
            { label: '5s', type: 'radio', checked: scheduleDelayMs === 5000, click: () => setScheduleDelay(5000) },
            { label: '30s', type: 'radio', checked: scheduleDelayMs === 30000, click: () => setScheduleDelay(30000) },
            { label: '2 min', type: 'radio', checked: scheduleDelayMs === 120000, click: () => setScheduleDelay(120000) }
          ]
        },
        { type: 'separator' },
        {
          label: 'Clipboard Sanitizer',
          type: 'checkbox',
          checked: clipboardSanitize,
          click: toggleClipboardSanitize
        },
        {
          label: 'Keyword Alerts',
          type: 'checkbox',
          checked: keywordAlertsEnabled,
          click: toggleKeywordAlerts
        },
        {
          label: 'Edit Keyword Alerts...',
          click: editKeywordAlerts
        },
        { type: 'separator' },
        {
          label: 'Picture in Picture',
          accelerator: 'CmdOrCtrl+Shift+P',
          click: createPipWindow
        },
        { type: 'separator' },
        {
          label: 'Menu Bar Mode',
          type: 'checkbox',
          checked: menuBarMode,
          click: toggleMenuBarMode
        },
        {
          label: 'Launch at Login',
          type: 'checkbox',
          checked: launchAtLogin,
          click: toggleLaunchAtLogin
        },
        { type: 'separator' },
        {
          label: 'Block Read Receipts',
          type: 'checkbox',
          checked: blockReadReceipts,
          click: toggleBlockReadReceipts
        },
        {
          label: 'Block Typing Indicator',
          type: 'checkbox',
          checked: blockTypingIndicator,
          click: toggleBlockTypingIndicator
        },
        {
          label: 'Spell Check',
          type: 'checkbox',
          checked: spellCheck,
          click: toggleSpellCheck
        },
        { type: 'separator' },
        {
          label: 'Window Opacity',
          submenu: [
            { label: '100%', type: 'radio', checked: windowOpacity === 1.0, click: () => setWindowOpacity(1.0) },
            { label: '90%', type: 'radio', checked: windowOpacity === 0.9, click: () => setWindowOpacity(0.9) },
            { label: '80%', type: 'radio', checked: windowOpacity === 0.8, click: () => setWindowOpacity(0.8) },
            { label: '70%', type: 'radio', checked: windowOpacity === 0.7, click: () => setWindowOpacity(0.7) },
            { label: '60%', type: 'radio', checked: windowOpacity === 0.6, click: () => setWindowOpacity(0.6) }
          ]
        },
        {
          label: 'Custom CSS',
          submenu: [
            {
              label: customCSS ? 'Edit Custom CSS...' : 'Add Custom CSS...',
              click: editCustomCSS
            },
            {
              label: 'Clear Custom CSS',
              enabled: !!customCSS,
              click: clearCustomCSS
            }
          ]
        },
        { type: 'separator' },
        {
          label: 'Previous Chat',
          accelerator: 'CmdOrCtrl+Up',
          click: () => navigateConversation('up')
        },
        {
          label: 'Next Chat',
          accelerator: 'CmdOrCtrl+Down',
          click: () => navigateConversation('down')
        },
        { type: 'separator' },
        {
          label: 'Session',
          submenu: [
            {
              label: 'Export Session...',
              click: exportCookies
            },
            {
              label: 'Import Session...',
              click: importCookies
            },
            { type: 'separator' },
            {
              label: 'Clear Session (Logout)',
              click: clearSession
            }
          ]
        }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' }
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function createWindow() {
  const bounds = store.get('windowBounds')

  mainWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    minWidth: 400,
    minHeight: 300,
    title: 'Messenger Unleashed',
    alwaysOnTop: store.get('alwaysOnTop'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: store.get('spellCheck')
    }
  })

  mainWindow.webContents.setUserAgent(USER_AGENT)

  // increase max listeners to avoid warnings during navigation
  mainWindow.webContents.setMaxListeners(20)

  // apply saved window opacity
  const opacity = store.get('windowOpacity')
  if (opacity < 1.0) {
    mainWindow.setOpacity(opacity)
  }

  // handle permission requests for webrtc and notifications
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowedPermissions = ['media', 'mediaKeySystem', 'geolocation', 'notifications', 'fullscreen', 'pointerLock']
    callback(allowedPermissions.includes(permission))
  })

  session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
    const allowedPermissions = ['media', 'mediaKeySystem', 'geolocation', 'notifications', 'fullscreen', 'pointerLock']
    return allowedPermissions.includes(permission)
  })

  mainWindow.loadURL('https://www.messenger.com')

  mainWindow.on('page-title-updated', (event, title) => {
    const match = title.match(/\\((\\d+)\\)/)
    const count = match ? parseInt(match[1], 10) : 0
    updateUnreadBadge(Number.isFinite(count) ? count : 0)
  })

  // apply saved theme and focus mode after page loads
  mainWindow.webContents.on('did-finish-load', () => {
    const theme = store.get('theme')
    if (theme !== 'default') {
      applyThemeCSS(theme)
    }

    // reapply focus mode if enabled
    if (store.get('focusMode')) {
      mainWindow.webContents.insertCSS(`
        div[aria-label="Chats"],
        div[role="navigation"] { display: none !important; }
        div[role="main"] { width: 100% !important; max-width: 100% !important; }
      `, { cssKey: 'focus-mode' })
    }

    // apply block read receipts if enabled
    if (store.get('blockReadReceipts')) {
      mainWindow.webContents.executeJavaScript(`
        (function() {
          Object.defineProperty(document, 'hidden', { value: true, writable: false })
          Object.defineProperty(document, 'visibilityState', { value: 'hidden', writable: false })
          document.dispatchEvent(new Event('visibilitychange'))
        })()
      `)
    }

    // apply block typing indicator if enabled
    if (store.get('blockTypingIndicator')) {
      mainWindow.webContents.executeJavaScript(`
        (function() {
          if (window.__typingBlockerInstalled) return;
          window.__typingBlockerInstalled = true;

          const origSend = XMLHttpRequest.prototype.send;
          XMLHttpRequest.prototype.send = function(body) {
            if (body && typeof body === 'string' && body.includes('typing')) {
              return;
            }
            return origSend.apply(this, arguments);
          };

          const origFetch = window.fetch;
          window.fetch = function(url, options) {
            if (options?.body && typeof options.body === 'string' && options.body.includes('typing')) {
              return Promise.resolve(new Response('{}'));
            }
            return origFetch.apply(this, arguments);
          };
        })()
      `)
    }

    // apply custom CSS if any
    applyCustomCSS()

    pushRendererConfig()
  })

  // save window size on resize
  mainWindow.on('resize', () => {
    const { width, height } = mainWindow.getBounds()
    store.set('windowBounds', { width, height })
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // initialize menu bar mode if enabled
  if (store.get('menuBarMode')) {
    const success = createTray()
    if (success) {
      mainWindow.setSkipTaskbar(true)
      // keep window and dock visible on startup so user isn't locked out
    } else {
      // tray failed, disable menu bar mode
      store.set('menuBarMode', false)
    }
  }

  updateMenu()
}

// keyboard shortcuts
app.on('ready', () => {
  const { globalShortcut } = require('electron')

  globalShortcut.register('CmdOrCtrl+Shift+T', toggleAlwaysOnTop)
  globalShortcut.register('CmdOrCtrl+Shift+D', toggleDoNotDisturb)
  globalShortcut.register('CmdOrCtrl+Shift+F', toggleFocusMode)
  globalShortcut.register('CmdOrCtrl+Shift+P', createPipWindow)
  globalShortcut.register('CmdOrCtrl+K', focusSearch)
  globalShortcut.register('CmdOrCtrl+Alt+Enter', scheduleSendNow)

  // conversation navigation
  globalShortcut.register('CmdOrCtrl+Up', () => navigateConversation('up'))
  globalShortcut.register('CmdOrCtrl+Down', () => navigateConversation('down'))

  // quick reply shortcuts
  const quickReplies = store.get('quickReplies')
  quickReplies.forEach(qr => {
    globalShortcut.register(`CmdOrCtrl+Shift+${qr.key}`, () => sendQuickReply(qr.text))
  })
})

app.whenReady().then(() => {
  // sync login item with stored preference
  const launchAtLogin = store.get('launchAtLogin')
  const canSetLogin =
    process.platform !== 'darwin' ||
    (app.isInApplicationsFolder && app.isInApplicationsFolder())
  if (canSetLogin) {
    try {
      app.setLoginItemSettings({
        openAtLogin: launchAtLogin,
        openAsHidden: false
      })
    } catch (err) {
      console.warn('Failed to set login item', err)
    }
  }

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('will-quit', () => {
  const { globalShortcut } = require('electron')
  globalShortcut.unregisterAll()
})
