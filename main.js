const { app, BrowserWindow, session, Menu, ipcMain, Notification, dialog } = require('electron')
const path = require('path')
const fs = require('fs')
const Store = require('electron-store')

const store = new Store({
  defaults: {
    alwaysOnTop: false,
    theme: 'default', // default, oled, compact
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
    spellCheck: true
  }
})

// chrome user agent for webrtc compatibility
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

let mainWindow = null
let pipWindow = null
let tray = null

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

function applyTheme(theme) {
  if (!mainWindow) return

  const css = getThemeCSS(theme)
  mainWindow.webContents.removeInsertedCSS('theme').catch(() => {})

  if (css) {
    mainWindow.webContents.insertCSS(css, { cssKey: 'theme' }).catch(() => {})
  }

  store.set('theme', theme)
  updateMenu()
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

  app.setLoginItemSettings({
    openAtLogin: newValue,
    openAsHidden: false
  })

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
    mainWindow.webContents.removeInsertedCSS('focus-mode').catch(() => {})
  }

  updateMenu()
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
    createTray()
    if (mainWindow) {
      mainWindow.setSkipTaskbar(true)
    }
  } else {
    if (tray) {
      tray.destroy()
      tray = null
    }
    if (mainWindow) {
      mainWindow.setSkipTaskbar(false)
      mainWindow.show()
    }
  }

  updateMenu()
}

function createTray() {
  if (tray) return

  const { Tray } = require('electron')

  // use template icon for macOS
  const iconPath = process.platform === 'darwin'
    ? path.join(__dirname, 'icon.icns')
    : path.join(__dirname, 'icon.icns')

  tray = new Tray(iconPath)
  tray.setToolTip('Messenger Unleashed')

  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.hide()
      } else {
        mainWindow.show()
        mainWindow.focus()
      }
    }
  })

  tray.on('right-click', () => {
    if (mainWindow) {
      mainWindow.show()
      mainWindow.focus()
    }
  })
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

function toggleSpellCheck() {
  const current = store.get('spellCheck')
  const newValue = !current
  store.set('spellCheck', newValue)

  // show dialog that restart is needed
  const { dialog } = require('electron')
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'Restart Required',
    message: 'Please restart the app for spell check changes to take effect.',
    buttons: ['OK']
  })

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
            {
              label: 'OLED Dark',
              type: 'radio',
              checked: theme === 'oled',
              click: () => applyTheme('oled')
            },
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
          label: 'Spell Check',
          type: 'checkbox',
          checked: spellCheck,
          click: toggleSpellCheck
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

  // apply saved theme and focus mode after page loads
  mainWindow.webContents.on('did-finish-load', () => {
    const theme = store.get('theme')
    if (theme !== 'default') {
      applyTheme(theme)
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
    createTray()
    mainWindow.setSkipTaskbar(true)
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

  // quick reply shortcuts
  const quickReplies = store.get('quickReplies')
  quickReplies.forEach(qr => {
    globalShortcut.register(`CmdOrCtrl+Shift+${qr.key}`, () => sendQuickReply(qr.text))
  })
})

app.whenReady().then(() => {
  // sync login item with stored preference
  const launchAtLogin = store.get('launchAtLogin')
  app.setLoginItemSettings({
    openAtLogin: launchAtLogin,
    openAsHidden: false
  })

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
