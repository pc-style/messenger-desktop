const { ipcRenderer, contextBridge, webFrame } = require('electron')

// state managed in preload (isolated from page)
let config = {
  keywordAlerts: [],
  keywordAlertsEnabled: false,
  clipboardSanitize: false,
  scheduleDelayMs: 30000,
  blockTypingIndicator: false,
  shortcuts: {}
}

let blockReadReceipts = false
let blockActiveStatus = false
let blockTypingIndicator = false
let visibilityPatched = false
const debugWebSocketBlocker =
  process.env.DEBUG_REQUEST_BLOCKER_WS === '1' ||
  process.env.DEBUG_REQUEST_BLOCKER_WS_ALL === '1' ||
  process.env.DEBUG_REQUEST_BLOCKER_WS_DECODE === '1'
const debugWebSocketBlockerDecode = process.env.DEBUG_REQUEST_BLOCKER_WS_DECODE === '1'
const debugWebSocketTypingTrace = process.env.DEBUG_REQUEST_BLOCKER_WS_TRACE_TYPING === '1'
let expTypingOverlayEnabled = process.env.EXP_BLOCK_TYPING_OVERLAY === '1'
const isMainFrame = typeof process !== 'undefined' ? process.isMainFrame : true

const textDecoder = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8') : null

function decodeWebSocketPayload(data) {
  if (!data) return ''
  if (typeof data === 'string') return data
  try {
    if (data instanceof ArrayBuffer) {
      const bytes = new Uint8Array(data)
      return textDecoder ? textDecoder.decode(bytes) : Buffer.from(bytes).toString('utf8')
    }
    if (ArrayBuffer.isView(data)) {
      const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      return textDecoder ? textDecoder.decode(bytes) : Buffer.from(bytes).toString('utf8')
    }
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(data)) {
      return data.toString('utf8')
    }
  } catch (_) {}
  return ''
}

function shouldBlockTypingPayload(text) {
  if (!text) return false
  return text.toLowerCase().includes('is_typing')
}

function shouldBlockActiveStatusPayload(text) {
  if (!text) return false
  if (text.includes('USER_ACTIVITY_UPDATE_SUBSCRIBE')) return true
  if (text.includes('USER_ACTIVITY_UPDATE')) return true
  const lower = text.toLowerCase()
  if (lower.includes('presence') && lower.includes('active')) return true
  if (lower.includes('active_status')) return true
  return false
}

function installWebSocketInterceptor() {
  if (typeof window === 'undefined' || !window.WebSocket) return
  const OriginalWebSocket = window.WebSocket

  function WebSocketProxy(url, protocols) {
    const ws = protocols ? new OriginalWebSocket(url, protocols) : new OriginalWebSocket(url)
    const originalSend = ws.send

    ws.send = function (data) {
      if (blockTypingIndicator || blockActiveStatus || debugWebSocketTypingTrace) {
        const decoded = decodeWebSocketPayload(data)
        if (decoded) {
          const isTypingPayload = shouldBlockTypingPayload(decoded)
          const blockTyping = blockTypingIndicator && isTypingPayload
          const blockActive = blockActiveStatus && shouldBlockActiveStatusPayload(decoded)
          if (debugWebSocketTypingTrace && isTypingPayload) {
            let preview = ''
            if (debugWebSocketBlockerDecode) {
              preview = ` payload=${decoded.slice(0, 220)}`
            }
            console.log(`[Unleashed] [WS-TYPING] ${url} blocked=${blockTypingIndicator}${preview}`)
          }
          if (blockTyping || blockActive) {
            if (debugWebSocketBlocker) {
              const reason = blockTyping ? 'typing' : 'active-status'
              let preview = ''
              if (debugWebSocketBlockerDecode && decoded) {
                preview = ` payload=${decoded.slice(0, 220)}`
              }
              console.log(`[Unleashed] [WS-BLOCKED] ${reason} ${url}${preview}`)
            }
            return
          }
        }
      }
      return originalSend.call(ws, data)
    }

    return ws
  }

  WebSocketProxy.prototype = OriginalWebSocket.prototype
  WebSocketProxy.CONNECTING = OriginalWebSocket.CONNECTING
  WebSocketProxy.OPEN = OriginalWebSocket.OPEN
  WebSocketProxy.CLOSING = OriginalWebSocket.CLOSING
  WebSocketProxy.CLOSED = OriginalWebSocket.CLOSED

  window.WebSocket = WebSocketProxy
}

installWebSocketInterceptor()

const ICONS = {
  lock: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" style="display:inline-block; vertical-align:middle;"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z"/></svg>',
  ghost: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" style="display:inline-block; vertical-align:middle;"><path d="M12 2c-4.418 0-8 3.582-8 8v10l3-2 3 2 2-2 2 2 3-2 3 2V10c0-4.418-3.582-8-8-8zm-3 9c-.828 0-1.5-.672-1.5-1.5S8.172 8 9 8s1.5.672 1.5 1.5S9.828 11 9 11zm6 0c-.828 0-1.5-.672-1.5-1.5S14.172 8 15 8s1.5.672 1.5 1.5S15.828 11 15 11z"/></svg>',
  close: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" style="display:inline-block; vertical-align:middle;"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>',
  check: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" style="display:inline-block; vertical-align:middle;"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>',
  cross: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" style="display:inline-block; vertical-align:middle;"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>'
}

// expose minimal, safe API to renderer
contextBridge.exposeInMainWorld('electronAPI', {
  // notification bridge
  showNotification: (title, options) => {
    ipcRenderer.send('show-notification', { title, ...options })
  },

  // input dialogs (for keyword/CSS editing)
  submitKeywordInput: (value) => {
    ipcRenderer.send('keyword-input-result', value)
  },

  submitCSSInput: (value) => {
    ipcRenderer.send('css-input-result', value)
  }
})

// IPC handlers for main process communication
ipcRenderer.on('notification-clicked', () => {
  window.focus()
})

ipcRenderer.on('schedule-send', (_, delayMs) => {
  scheduleSend(delayMs)
})

ipcRenderer.on('update-config', (_, newConfig) => {
  config = { ...config, ...newConfig }
})

ipcRenderer.on('set-block-read-receipts', (_, enabled) => {
  blockReadReceipts = enabled
  updateVisibilityState()
})

ipcRenderer.on('set-block-active-status', (_, enabled) => {
  blockActiveStatus = enabled
  updateVisibilityState()
})

// Unified visibility logic
function updateVisibilityState() {
  // We force hidden if Active Status is blocked OR Read Receipts are blocked
  // (Read receipts usually require visibility to trigger, so this is a safety net)
  if (blockActiveStatus || blockReadReceipts) {
    applyVisibilityOverride()
  } else {
    restoreVisibilityOverride()
  }
}

// [EXP] Overlay input to avoid native typing signals (opt-in via env)
let typingOverlayInterval = null
let typingOverlayState = { input: null, overlay: null }

function cleanupTypingOverlay() {
  if (typingOverlayState.overlay) typingOverlayState.overlay.remove()
  if (typingOverlayState.input) {
    typingOverlayState.input.style.opacity = ''
    typingOverlayState.input.style.pointerEvents = ''
    typingOverlayState.input.style.caretColor = ''
  }
  typingOverlayState = { input: null, overlay: null }
}

function installTypingOverlay() {
  if (!isMainFrame || !expTypingOverlayEnabled) return
  const input =
    document.querySelector('div[role="textbox"][contenteditable="true"]') ||
    document.querySelector('div[contenteditable="true"]') ||
    document.querySelector('div[aria-label="Message"]')
  if (!input) {
    cleanupTypingOverlay()
    return
  }

  if (typingOverlayState.input && typingOverlayState.input !== input) {
    cleanupTypingOverlay()
  }

  if (!typingOverlayState.overlay) {
    const overlay = document.createElement('div')
    overlay.id = 'unleashed-typing-overlay'
    overlay.setAttribute('contenteditable', 'true')
    overlay.setAttribute('role', 'textbox')
    overlay.setAttribute('aria-label', 'Message')
    overlay.style.cssText = `
      position: absolute;
      inset: 0;
      z-index: 99999;
      background: transparent;
      outline: none;
      white-space: pre-wrap;
      overflow-wrap: break-word;
    `

    overlay.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.shiftKey) return
      event.preventDefault()
      event.stopPropagation()

      const text = overlay.innerText || ''
      if (!text.trim()) return
      if (!typingOverlayState.input) return

      const target = typingOverlayState.input
      target.focus()
      document.execCommand('selectAll', false, null)
      document.execCommand('insertText', false, text)
      target.dispatchEvent(new Event('input', { bubbles: true }))

      const enterEvent = new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        bubbles: true,
        cancelable: true
      })
      target.dispatchEvent(enterEvent)

      overlay.innerHTML = ''
      overlay.focus()
    }, true)

    const container = input.closest('div[role="none"]') || input.parentElement
    if (container) {
      container.style.position = 'relative'
      container.appendChild(overlay)
    }

    const style = window.getComputedStyle(input)
    overlay.style.fontFamily = style.fontFamily
    overlay.style.fontSize = style.fontSize
    overlay.style.fontWeight = style.fontWeight
    overlay.style.lineHeight = style.lineHeight
    overlay.style.color = style.color
    overlay.style.letterSpacing = style.letterSpacing
    overlay.style.padding = style.padding
    overlay.style.textAlign = style.textAlign

    input.style.opacity = '0'
    input.style.pointerEvents = 'none'
    input.style.caretColor = 'transparent'

    typingOverlayState = { input, overlay }
  }
}

function updateTypingOverlayState() {
  const shouldEnable = expTypingOverlayEnabled && blockTypingIndicator
  if (shouldEnable && !typingOverlayInterval) {
    typingOverlayInterval = setInterval(installTypingOverlay, 1000)
    installTypingOverlay()
    return
  }
  if (!shouldEnable && typingOverlayInterval) {
    clearInterval(typingOverlayInterval)
    typingOverlayInterval = null
    cleanupTypingOverlay()
  }
}

// typing indicator blocking handled here for WebSocket payloads; keep flag for UI reflection
ipcRenderer.on('set-block-typing-indicator', (_, enabled) => {
  blockTypingIndicator = enabled
  updateTypingOverlayState()
})

ipcRenderer.on('set-exp-typing-overlay', (_, enabled) => {
  expTypingOverlayEnabled = enabled || process.env.EXP_BLOCK_TYPING_OVERLAY === '1'
  updateTypingOverlayState()
})

ipcRenderer.on('show-keyword-input', (_, currentValue) => {
  showInputModal('Edit Keyword Alerts', 'Enter keywords (comma separated):', currentValue, (result) => {
    if (result !== null) {
      ipcRenderer.send('keyword-input-result', result)
    }
  })
})

ipcRenderer.on('show-css-input', (_, currentValue) => {
  showInputModal('Custom CSS', 'Enter CSS rules:', currentValue, (result) => {
    if (result !== null) {
      ipcRenderer.send('css-input-result', result)
    }
  }, true) // use textarea for CSS
})

ipcRenderer.on('set-chameleon-mode', (_, enabled) => {
  toggleChameleonMode(enabled)
})

function toggleChameleonMode(enabled) {
  let overlay = document.getElementById('chameleon-overlay')
  
  if (!enabled) {
    if (overlay) overlay.style.display = 'none'
    return
  }
  
  if (!overlay) {
    overlay = document.createElement('div')
    overlay.id = 'chameleon-overlay'
    // Fake Excel Spreadsheet Look
    overlay.innerHTML = `
      <div style="display:flex; flex-direction:column; width:100%; height:100%; font-family: Calibri, Arial, sans-serif; background: #fff; color: #000;">
        <div style="background:#217346; height:30px; display:flex; align-items:center; padding:0 10px;">
          <div style="color:white; font-size:13px; font-weight:bold;">Book1 - Excel</div>
        </div>
        <div style="background:#f3f2f1; border-bottom:1px solid #e1dfdd; height:40px; display:flex; align-items:center; padding:0 10px;">
           <div style="margin-right:20px; font-size:14px;">File</div>
           <div style="margin-right:20px; font-size:14px;">Home</div>
           <div style="margin-right:20px; font-size:14px;">Insert</div>
           <div style="margin-right:20px; font-size:14px;">Page Layout</div>
           <div style="margin-right:20px; font-size:14px;">Formulas</div>
           <div style="margin-right:20px; font-size:14px;">Data</div>
        </div>
        <div style="background:#f3f2f1; height:30px; border-bottom:1px solid #dadbdc; display:flex; align-items:center; padding-left:40px; font-size:12px; color:#444;">
          A1 &nbsp;&nbsp; ${ICONS.cross} &nbsp; ${ICONS.check} &nbsp; <span style="background:white; border:1px solid #ccc; padding:2px 10px; width:300px;">Q3 Financial Projections</span>
        </div>
        <div style="display:grid; grid-template-columns: 40px repeat(10, 1fr); flex:1; overflow:hidden;">
          <div style="background:#f3f2f1; border-right:1px solid #dadbdc; border-bottom:1px solid #dadbdc;"></div>
          ${['A','B','C','D','E','F','G','H','I','J'].map(c => `
             <div style="background:#f3f2f1; border-right:1px solid #dadbdc; border-bottom:1px solid #dadbdc; display:flex; align-items:center; justify-content:center; color:#666; font-size:12px;">${c}</div>
          `).join('')}
          ${Array.from({length: 40}).map((_, i) => `
             <div style="background:#f3f2f1; border-right:1px solid #dadbdc; border-bottom:1px solid #e1dfdd; display:flex; align-items:center; justify-content:center; color:#666; font-size:12px;">${i+1}</div>
             ${['','','','','','','','','',''].map(() => `
               <div style="border-right:1px solid #e1dfdd; border-bottom:1px solid #e1dfdd; padding:2px;"></div>
             `).join('')}
          `).join('')}
        </div>
        <div style="height:25px; background:#f3f2f1; border-top:1px solid #e1dfdd; display:flex; align-items:center; padding-left:10px;">
           <div style="background:white; padding:2px 10px; border:1px solid #ccc; font-size:12px;">Sheet1</div>
        </div>
      </div>
    `
    overlay.style.cssText = `
      position: fixed; top: 0; left: 0; right: 0; bottom: 0;
      background: white; z-index: 2147483647;
      display: none;
    `
    document.body.appendChild(overlay)
  }
  
  overlay.style.display = 'block'
}

// safe input modal (runs in preload context, not page context)
function showInputModal(title, message, defaultValue, callback, useTextarea = false) {
  // ... existing code ...
  const overlay = document.createElement('div')
  overlay.id = 'unleashed-input-overlay'
  overlay.style.cssText = `
    position: fixed; top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0,0,0,0.7); z-index: 999999;
    display: flex; align-items: center; justify-content: center;
    backdrop-filter: blur(5px);
  `

  const modal = document.createElement('div')
  modal.style.cssText = `
    background: #1e1e1e; padding: 24px; border-radius: 16px;
    min-width: 400px; max-width: 600px; color: #fff;
    font-family: -apple-system, BlinkMacSystemFont, sans-serif;
    border: 1px solid rgba(255,255,255,0.1);
    box-shadow: 0 10px 40px rgba(0,0,0,0.5);
  `

  const titleEl = document.createElement('h3')
  titleEl.textContent = title
  titleEl.style.cssText = 'margin: 0 0 10px 0; font-size: 18px; font-weight: 700;'

  const messageEl = document.createElement('p')
  messageEl.textContent = message
  messageEl.style.cssText = 'margin: 0 0 16px 0; font-size: 14px; color: #aaa;'

  const input = document.createElement(useTextarea ? 'textarea' : 'input')
  input.value = defaultValue || ''
  input.style.cssText = `
    width: 100%; padding: 12px; box-sizing: border-box;
    background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); color: #fff;
    border-radius: 8px; font-size: 14px; outline: none;
    ${useTextarea ? 'height: 150px; resize: vertical;' : ''}
  `

  const buttons = document.createElement('div')
  buttons.style.cssText = 'text-align: right; margin-top: 24px;'

  const cancelBtn = document.createElement('button')
  cancelBtn.textContent = 'Cancel'
  cancelBtn.style.cssText = 'padding: 10px 20px; margin-left: 8px; background: rgba(255,255,255,0.05); color: #fff; border: none; border-radius: 8px; cursor: pointer; font-weight: 600;'

  const okBtn = document.createElement('button')
  okBtn.textContent = 'OK'
  okBtn.style.cssText = 'padding: 10px 20px; margin-left: 8px; background: #0084ff; color: #fff; border: none; border-radius: 8px; cursor: pointer; font-weight: 600;'

  const close = (result) => {
    overlay.remove()
    callback(result)
  }

  cancelBtn.onclick = () => close(null)
  okBtn.onclick = () => close(input.value)
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close(null)
    if (e.key === 'Enter' && !useTextarea) close(input.value)
  })

  buttons.appendChild(cancelBtn)
  buttons.appendChild(okBtn)
  modal.appendChild(titleEl)
  modal.appendChild(messageEl)
  modal.appendChild(input)
  modal.appendChild(buttons)
  overlay.appendChild(modal)
  document.body.appendChild(overlay)
  input.focus()
  input.select()
}

function showSettingsModal(config) {
  const existing = document.getElementById('unleashed-settings-overlay')
  if (existing) existing.remove()

  const updateTheme = () => {
    const isDarkMode = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    const bgColor = isDarkMode ? 'rgba(28, 28, 30, 0.8)' : 'rgba(255, 255, 255, 0.8)';
    const textColor = isDarkMode ? '#fff' : '#000';
    const subTextColor = isDarkMode ? '#aaa' : '#666';
    const borderColor = isDarkMode ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.1)';
    const sectionBorderColor = isDarkMode ? 'rgba(255, 255, 255, 0.05)' : 'rgba(0, 0, 0, 0.05)';
    const btnBg = isDarkMode ? 'rgba(255, 255, 255, 0.05)' : 'rgba(0, 0, 0, 0.05)';
    const accentColor = '#0084ff';

    modal.style.background = bgColor;
    modal.style.color = textColor;
    modal.style.borderColor = borderColor;

    // Update styles in head
    style.textContent = `
      @keyframes settingsFadeIn {
        from { opacity: 0; transform: scale(0.98) translateY(10px); }
        to { opacity: 1; transform: scale(1) translateY(0); }
      }
      .settings-section { padding: 20px; border-bottom: 1px solid ${sectionBorderColor}; }
      .settings-section h4 { margin: 0 0 15px 0; color: ${subTextColor}; text-transform: uppercase; font-size: 11px; letter-spacing: 0.5px; font-weight: 600; }
      .settings-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
      .settings-row:last-child { margin-bottom: 0; }
      .settings-label { font-size: 14px; font-weight: 500; }
      .settings-desc { font-size: 12px; color: ${subTextColor}; margin-top: 2px; }
      .toggle { 
        position: relative; width: 44px; height: 24px; 
        background: ${isDarkMode ? '#3a3a3c' : '#e9e9ea'}; border-radius: 12px; cursor: pointer;
        transition: background 0.2s cubic-bezier(0.4, 0, 0.2, 1);
      }
      .toggle.active { background: #30d158; }
      .toggle-knob {
        position: absolute; top: 2px; left: 2px; width: 20px; height: 20px;
        background: #fff; border-radius: 50%; transition: left 0.2s cubic-bezier(0.4, 0, 0.2, 1);
        box-shadow: 0 2px 4px rgba(0,0,0,0.1);
      }
      .toggle.active .toggle-knob { left: 22px; }
      .settings-btn {
        background: ${btnBg}; border: none; color: ${textColor};
        padding: 8px 14px; border-radius: 10px; font-size: 13px; cursor: pointer;
        transition: all 0.2s; font-weight: 500;
      }
      .settings-btn:hover { background: ${isDarkMode ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)'}; }
      .settings-btn.primary { background: ${accentColor}; color: white; }
      .settings-btn.primary:hover { background: #0077e6; }
      .close-area { padding: 16px 24px; display: flex; justify-content: space-between; align-items: center; background: rgba(0,0,0,0.02); }
      
      /* Scrollbar styling */
      .settings-scroll::-webkit-scrollbar { width: 8px; }
      .settings-scroll::-webkit-scrollbar-track { background: transparent; }
      .settings-scroll::-webkit-scrollbar-thumb { background: ${isDarkMode ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)'}; border-radius: 4px; }
    `;

    mainTitle.style.color = textColor;
    subTitle.style.color = subTextColor;
    closeBtn.style.color = subTextColor;
    footerHint.style.color = subTextColor;
  };

  const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
  mediaQuery.addEventListener('change', updateTheme);

  const isDarkMode = mediaQuery.matches;
  const bgColor = isDarkMode ? 'rgba(28, 28, 30, 0.8)' : 'rgba(255, 255, 255, 0.8)';
  const textColor = isDarkMode ? '#fff' : '#000';
  const subTextColor = isDarkMode ? '#aaa' : '#666';
  const borderColor = isDarkMode ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.1)';
  const sectionBorderColor = isDarkMode ? 'rgba(255, 255, 255, 0.05)' : 'rgba(0, 0, 0, 0.05)';
  const btnBg = isDarkMode ? 'rgba(255, 255, 255, 0.05)' : 'rgba(0, 0, 0, 0.05)';
  const accentColor = '#0084ff';

  const overlay = document.createElement('div')
  overlay.id = 'unleashed-settings-overlay'
  overlay.style.cssText = `
    position: fixed; top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0,0,0,0.4); z-index: 1000000;
    display: flex; align-items: center; justify-content: center;
    backdrop-filter: blur(20px) saturate(180%);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  `

  const modal = document.createElement('div')
  modal.style.cssText = `
    background: ${bgColor};
    width: 600px; max-height: 85vh;
    border-radius: 24px;
    border: 1px solid ${borderColor};
    box-shadow: 0 30px 60px rgba(0,0,0,0.3);
    display: flex; flex-direction: column;
    overflow: hidden; color: ${textColor};
    animation: settingsFadeIn 0.4s cubic-bezier(0.16, 1, 0.3, 1) forwards;
  `

  const style = document.createElement('style')
  document.head.appendChild(style)

  const header = document.createElement('div')
  header.style.cssText = `padding: 24px 24px 16px 24px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid ${sectionBorderColor};`
  
  const titleGroup = document.createElement('div')
  const mainTitle = document.createElement('h2')
  mainTitle.textContent = 'Messenger Unleashed'
  mainTitle.style.cssText = `margin: 0; font-size: 20px; font-weight: 700; color: ${textColor};`
  
  const subTitle = document.createElement('div')
  subTitle.textContent = `v${config.version || '1.1.11'} — Settings`
  subTitle.style.cssText = `font-size: 12px; color: ${subTextColor}; font-weight: 500; margin-top: 2px;`
  
  titleGroup.append(mainTitle, subTitle)
  
  const closeBtn = document.createElement('div')
  closeBtn.innerHTML = ICONS.close
  closeBtn.style.cssText = `font-size: 24px; cursor: pointer; color: ${subTextColor}; width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; border-radius: 50%; transition: background 0.2s;`
  closeBtn.onmouseenter = () => closeBtn.style.background = btnBg;
  closeBtn.onmouseleave = () => closeBtn.style.background = 'transparent';
  closeBtn.onclick = () => {
    mediaQuery.removeEventListener('change', updateTheme);
    overlay.remove();
  }
  
  header.append(titleGroup, closeBtn)

  const scrollArea = document.createElement('div')
  scrollArea.className = 'settings-scroll'
  scrollArea.style.cssText = 'flex: 1; overflow-y: auto; padding: 4px 0;'

  const createToggleRow = (label, desc, key, initialValue) => {
    const row = document.createElement('div')
    row.className = 'settings-row'
    
    const info = document.createElement('div')
    const l = document.createElement('div')
    l.className = 'settings-label'
    l.textContent = label
    const d = document.createElement('div')
    d.className = 'settings-desc'
    d.textContent = desc
    info.append(l, d)
    
    const toggle = document.createElement('div')
    toggle.className = `toggle ${initialValue ? 'active' : ''}`
    const knob = document.createElement('div')
    knob.className = 'toggle-knob'
    toggle.appendChild(knob)
    
    toggle.onclick = () => {
      const active = toggle.classList.toggle('active')
      ipcRenderer.send('update-setting', { key, value: active })
    }
    
    row.append(info, toggle)
    return row
  }

  // Privacy Section
  const privacySection = document.createElement('div')
  privacySection.className = 'settings-section'
  const privacyTitle = document.createElement('h4')
  privacyTitle.innerHTML = `${ICONS.lock} Privacy & Stealth`
  privacySection.append(privacyTitle)
  privacySection.append(createToggleRow('Block Read Receipts', 'Others won\'t know when you read messages.', 'blockReadReceipts', config.blockReadReceipts))
  privacySection.append(createToggleRow('Block Active Status', 'Appear offline but still see others.', 'blockActiveStatus', config.blockActiveStatus))
  privacySection.append(createToggleRow('Block Typing Indicator', 'Hide "typing..." while you compose.', 'blockTypingIndicator', config.blockTypingIndicator))
  privacySection.append(createToggleRow('[EXP] Typing Overlay (Better Typing Block)', 'Experimental: hides typing by using a proxy input overlay.', 'expTypingOverlay', config.expTypingOverlay))
  privacySection.append(createToggleRow('Clipboard Sanitizer', 'Remove tracking data from pasted URLs.', 'clipboardSanitize', config.clipboardSanitize))
  
  // Appearance Section
  const appearanceSection = document.createElement('div')
  appearanceSection.className = 'settings-section'
  const appearanceTitle = document.createElement('h4')
  appearanceTitle.innerHTML = `${ICONS.ghost} Appearance`
  appearanceSection.append(appearanceTitle)
  appearanceSection.append(createToggleRow('Modern Look (Floating)', 'A lighter, floating UI design.', 'modernLook', config.modernLook))
  appearanceSection.append(createToggleRow('Floating Glass (Theme Override)', 'Premium glassmorphism aesthetics.', 'floatingGlass', config.floatingGlass))
  
  // Customization controls
  const customRow = document.createElement('div')
  customRow.className = 'settings-row'
  customRow.style.marginTop = '12px'
  
  const cssBtn = document.createElement('button')
  cssBtn.className = 'settings-btn'
  cssBtn.textContent = 'Edit Custom CSS'
  cssBtn.onclick = () => { overlay.remove(); ipcRenderer.send('edit-custom-css') }
  
  const themeBtn = document.createElement('button')
  themeBtn.className = 'settings-btn primary'
  themeBtn.textContent = 'Theme Creator'
  themeBtn.onclick = () => window.open('https://mstheme.pcstyle.dev', '_blank')
  
  customRow.append(cssBtn, themeBtn)
  appearanceSection.append(customRow)

  // System Section
  const systemSection = document.createElement('div')
  systemSection.className = 'settings-section'
  const systemTitle = document.createElement('h4')
  systemTitle.textContent = 'System & Tools'
  systemSection.append(systemTitle)
  systemSection.append(createToggleRow('Always on Top', 'Keep Messenger above other windows.', 'alwaysOnTop', config.alwaysOnTop))
  systemSection.append(createToggleRow('Launch at Login', 'Start the app automatically.', 'launchAtLogin', config.launchAtLogin))
  systemSection.append(createToggleRow('Spell Check', 'Check spelling as you type.', 'spellCheck', config.spellCheck))

  // Shortcuts Section
  const shortcutSection = document.createElement('div')
  shortcutSection.className = 'settings-section'
  const shortcutTitle = document.createElement('h4')
  shortcutTitle.textContent = 'Keyboard Shortcuts'
  shortcutSection.append(shortcutTitle)
  
  const shortcutsDesc = document.createElement('div')
  shortcutsDesc.textContent = 'Click on a shortcut to record a new one. Press Escape to cancel.'
  shortcutsDesc.style.cssText = `font-size: 12px; color: ${subTextColor}; margin-bottom: 12px;`
  shortcutSection.append(shortcutsDesc)

  const shortcutList = document.createElement('div')
  
  const friendlyNames = {
    "toggleAlwaysOnTop": "Always on Top",
    "toggleDoNotDisturb": "Do Not Disturb",
    "toggleFocusMode": "Focus Mode",
    "createPipWindow": "Picture-in-Picture",
    "focusSearch": "Search",
    "scheduleSendNow": "Send Scheduled",
    "bossKey": "Boss Key (Chameleon)"
  }

  const renderShortcuts = () => {
    shortcutList.innerHTML = ''
    const currentShortcuts = config.shortcuts || {}
    Object.entries(currentShortcuts).forEach(([action, accelerator]) => {
      const row = document.createElement('div')
      row.className = 'settings-row'
      
      const label = document.createElement('div')
      label.className = 'settings-label'
      label.textContent = friendlyNames[action] || action
      
      const keyDisplay = document.createElement('button')
      keyDisplay.className = 'settings-btn'
      keyDisplay.textContent = accelerator || 'Not Set'
      keyDisplay.style.fontFamily = 'Menlo, Monaco, monospace'
      keyDisplay.style.minWidth = '80px'
      
      keyDisplay.onclick = () => {
        keyDisplay.textContent = 'Recording...'
        keyDisplay.classList.add('primary')
        
        const handler = (e) => {
          e.preventDefault()
          if (e.key === 'Escape') {
             keyDisplay.textContent = accelerator
             keyDisplay.classList.remove('primary')
             document.removeEventListener('keydown', handler)
             return
          }
          
          let keys = []
          if (e.metaKey) keys.push('CmdOrCtrl')
          if (e.ctrlKey && !e.metaKey) keys.push('CmdOrCtrl') // map Win Ctrl to same
          if (e.altKey) keys.push('Alt')
          if (e.shiftKey) keys.push('Shift')
          
          // ignore standalone modifiers
          if (['Meta','Control','Alt','Shift'].includes(e.key)) return
          
          let char = e.key.toUpperCase()
          // basic mapping for electron accelerator
          if (char === ' ') char = 'Space'
          if (char === 'ENTER') char = 'Enter'
          if (char === 'ARROWUP') char = 'Up'
          if (char === 'ARROWDOWN') char = 'Down'
          
          keys.push(char)
          const newAccelerator = keys.join('+')
          
          ipcRenderer.send('update-shortcut', { action, accelerator: newAccelerator })
          
          // Optimistically update
          config.shortcuts[action] = newAccelerator
          renderShortcuts()
          
          document.removeEventListener('keydown', handler)
        }
        document.addEventListener('keydown', handler)
      }
      
      row.append(label, keyDisplay)
      shortcutList.append(row)
    })
  }
  
  renderShortcuts()
  shortcutSection.append(shortcutList)

  scrollArea.append(privacySection, appearanceSection, systemSection, shortcutSection)

  const footer = document.createElement('div')
  footer.className = 'close-area'
  
  const footerHint = document.createElement('div')
  footerHint.textContent = 'Some changes may require a reload.'
  footerHint.style.cssText = `font-size: 11px; color: ${subTextColor};`
  
  const doneBtn = document.createElement('button')
  doneBtn.textContent = 'Done'
  doneBtn.className = 'settings-btn primary'
  doneBtn.style.padding = '10px 24px'
  doneBtn.onclick = () => overlay.remove()
  
  footer.append(footerHint, doneBtn)

  modal.append(header, scrollArea, footer)
  overlay.appendChild(modal)
  document.body.appendChild(overlay)
  
  // Update theme once everything is created to ensure references (mainTitle etc) exist
  updateTheme();

  overlay.onclick = (e) => { 
    if (e.target === overlay) {
      mediaQuery.removeEventListener('change', updateTheme);
      overlay.remove();
    }
  }
}

ipcRenderer.on('open-settings-modal', (_, config) => {
  showSettingsModal(config)
})


// visibility API override with safe, configurable getters
function applyVisibilityOverride() {
  if (visibilityPatched) return
  visibilityPatched = true
  const code = `
    (function() {
      if (document.__visibilityOverrideInstalled) return;
      document.__visibilityOverrideInstalled = true;

      const hiddenDesc = Object.getOwnPropertyDescriptor(document, 'hidden') || Object.getOwnPropertyDescriptor(Document.prototype, 'hidden');
      const visDesc = Object.getOwnPropertyDescriptor(document, 'visibilityState') || Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');

      if ((hiddenDesc && hiddenDesc.configurable === false) || (visDesc && visDesc.configurable === false)) {
        console.warn('Visibility override skipped: non-configurable');
        return;
      }

      const originals = { hidden: hiddenDesc, visibilityState: visDesc };

      Object.defineProperty(document, 'hidden', {
        configurable: true,
        enumerable: hiddenDesc ? hiddenDesc.enumerable : true,
        get() { return true; }
      });

      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        enumerable: visDesc ? visDesc.enumerable : true,
        get() { return 'hidden'; }
      });
      
      // Also force hasFocus to false to kill typing indicators that ignore visibility
      const originalHasFocus = document.hasFocus;
      document.hasFocus = function() { return false; };

      // block visibilitychange events generated by the page
      const blockEvent = (e) => { e.stopImmediatePropagation(); };
      document.addEventListener('visibilitychange', blockEvent, true);

      window.__restoreVisibilityOverride = function restoreVisibilityOverride() {
        if (originals.hidden) Object.defineProperty(document, 'hidden', originals.hidden);
        if (originals.visibilityState) Object.defineProperty(document, 'visibilityState', originals.visibilityState);
        if (originalHasFocus) document.hasFocus = originalHasFocus;
        document.removeEventListener('visibilitychange', blockEvent, true);
        delete window.__restoreVisibilityOverride;
        document.__visibilityOverrideInstalled = false;
      };
    })();
  `
  webFrame.executeJavaScript(code).catch(() => {})
}

function restoreVisibilityOverride() {
  if (!visibilityPatched) return
  visibilityPatched = false
  webFrame.executeJavaScript('window.__restoreVisibilityOverride && window.__restoreVisibilityOverride();').catch(() => {})
}

// notification override (without script tag injection)
function setupNotificationOverride() {
  const code = `
    (function() {
      if (window.__notificationOverrideInstalled) return;
      window.__notificationOverrideInstalled = true;

      const OriginalNotification = window.Notification;

      function ElectronNotification(title, options) {
        try { window.electronAPI?.showNotification?.(title, options); } catch (_) {}
        return {
          close: function() {},
          onclick: null,
          onclose: null,
          onerror: null,
          onshow: null
        };
      }

      ElectronNotification.permission = 'granted';
      ElectronNotification.requestPermission = function() { return Promise.resolve('granted'); };

      if (OriginalNotification) {
        ElectronNotification.prototype = Object.create(OriginalNotification.prototype);
      }

      window.Notification = ElectronNotification;
    })();
  `
  webFrame.executeJavaScript(code).catch(() => {})
}

// clipboard sanitizer using modern API
function setupClipboardSanitizer() {
  document.addEventListener('paste', (event) => {
    if (!config.clipboardSanitize) return

    const text = event.clipboardData?.getData('text/plain')
    if (!text) return

    try {
      const url = new URL(text)
      const trackingParams = [
        'utm_source', 'utm_medium', 'utm_campaign', 'utm_term',
        'utm_content', 'utm_id', 'fbclid', 'gclid', 'yclid',
        'mc_cid', 'mc_eid', 'ref', 'ref_src'
      ]
      trackingParams.forEach(p => url.searchParams.delete(p))

      const cleanUrl = url.toString()
      if (cleanUrl !== text) {
        event.preventDefault()

        const target = event.target
        if (target.isContentEditable) {
          const selection = window.getSelection()
          const range = selection.rangeCount ? selection.getRangeAt(0) : document.createRange()
          if (!selection.rangeCount) {
            range.selectNodeContents(target)
            range.collapse(false)
          }
          range.deleteContents()
          const textNode = document.createTextNode(cleanUrl)
          range.insertNode(textNode)
          range.setStartAfter(textNode)
          range.setEndAfter(textNode)
          selection.removeAllRanges()
          selection.addRange(range)
          target.dispatchEvent(new InputEvent('input', {
            bubbles: true,
            inputType: 'insertFromPaste',
            data: cleanUrl
          }))
        } else if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
          const { selectionStart, selectionEnd, value } = target
          const start = selectionStart ?? value.length
          const end = selectionEnd ?? value.length
          if (typeof target.setRangeText === 'function') {
            target.setRangeText(cleanUrl, start, end, 'end')
          } else {
            target.value = value.slice(0, start) + cleanUrl + value.slice(end)
            target.selectionStart = target.selectionEnd = start + cleanUrl.length
          }
          target.dispatchEvent(new InputEvent('input', {
            bubbles: true,
            inputType: 'insertFromPaste',
            data: cleanUrl
          }))
        }
      }
    } catch (_) {
      // not a URL, let default paste happen
    }
  }, true)
}

// keyword alerts setup
function setupKeywordAlerts() {
  const seenNodes = new WeakSet()

  const getKeywords = () => (config.keywordAlerts || [])
    .map(k => k.toLowerCase().trim())
    .filter(Boolean)

  const notifyHit = (text) => {
    if (!config.keywordAlertsEnabled) return
    const kws = getKeywords()
    if (!kws.length) return

    const lower = text.toLowerCase()
    const hit = kws.find(k => lower.includes(k))
    if (hit && window.electronAPI?.showNotification) {
      window.electronAPI.showNotification('Keyword alert: ' + hit, { body: text.slice(0, 140) })
    }
  }

  const observer = new MutationObserver((mutations) => {
    mutations.forEach(m => {
      m.addedNodes.forEach(node => {
        if (!(node instanceof HTMLElement)) return
        if (seenNodes.has(node)) return
        seenNodes.add(node)
        const text = node.innerText || ''
        if (text) notifyHit(text)
      })
    })
  })

  // start observing when DOM is ready
  if (document.body) {
    observer.observe(document.body, { childList: true, subtree: true })
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      observer.observe(document.body, { childList: true, subtree: true })
    })
  }
}

// scheduled send implementation
function scheduleSend(delayMs) {
  const input = document.querySelector('[contenteditable="true"][role="textbox"]')
  if (!input) return

  const saved = input.innerHTML

  // show banner
  const banner = document.createElement('div')
  banner.textContent = 'Scheduled send in ' + Math.round(delayMs / 1000) + 's'
  banner.style.cssText = `
    position: fixed; bottom: 20px; right: 20px;
    padding: 10px 14px; background: rgba(0,0,0,0.8);
    color: #fff; border-radius: 8px; z-index: 999999;
    font-size: 13px; font-family: -apple-system, sans-serif;
  `
  document.body.appendChild(banner)
  setTimeout(() => banner.remove(), delayMs + 6000)

  setTimeout(() => {
    input.focus()
    input.innerHTML = saved
    input.dispatchEvent(new Event('input', { bubbles: true }))

    const enterEvent = new KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      bubbles: true
    })
    input.dispatchEvent(enterEvent)
  }, delayMs)
}

// detect if Messenger has a custom background image/theme applied
function setupBackgroundDetection() {
  const checkBackground = () => {
    // Messenger usually applies background images to a div with aria-label="Messages" 
    // or sometimes to a container with specific background-image style.
    const messageArea = document.querySelector('div[aria-label="Messages"]');
    if (!messageArea) {
      document.body.classList.remove('unleashed-has-custom-bg');
      return;
    }

    // Check for inline style or computed style that indicates a background image
    const style = window.getComputedStyle(messageArea);
    const hasBgImage = style.backgroundImage && style.backgroundImage !== 'none' && !style.backgroundImage.includes('initial');
    
    // Also check for common class names or child elements Messenger uses for themes
    const themeElement = messageArea.querySelector('img[src*="theme"]');
    
    if (hasBgImage || themeElement) {
      document.body.classList.add('unleashed-has-custom-bg');
    } else {
      document.body.classList.remove('unleashed-has-custom-bg');
    }
  };

  // Use polling instead of MutationObserver to avoid performance impact
  // MutationObserver on document.body with getComputedStyle caused a freeze/OOM loop
  setInterval(checkBackground, 2000);
  
  // Initial check
  setTimeout(checkBackground, 1000);
}

let customStyleElement = null;

function applyCustomCSS(css) {
  const target = document.head || document.documentElement;
  if (!target) {
    // defer if DOM not ready
    setTimeout(() => applyCustomCSS(css), 100);
    return;
  }

  if (!customStyleElement) {
    customStyleElement = document.createElement('style');
    customStyleElement.id = 'unleashed-custom-css';
    target.appendChild(customStyleElement);
  }
  
  customStyleElement.textContent = css;
}

ipcRenderer.on('apply-custom-css', (_, css) => {
  applyCustomCSS(css);
});

// initialize when DOM is ready
window.addEventListener('DOMContentLoaded', () => {
  setupNotificationOverride()
  setupClipboardSanitizer()
  setupKeywordAlerts()
  setupBackgroundDetection()
  setupInvisibleInk() // Steganography
  setInterval(scrapeActiveChat, 2000)
})

function scrapeActiveChat() {
  const activeLink = document.querySelector('div[role="navigation"] a[aria-current="page"]') ||
                     document.querySelector('div[aria-label="Chats"] a[aria-current="page"]');
  if (!activeLink) return;

  // Try to find avatar image
  const img = activeLink.querySelector('img') || 
              activeLink.querySelector('svg mask image');
  
  if (!img) return;

  const src = img.src || img.getAttribute('xlink:href');
  if (!src) return;

  ipcRenderer.send('update-active-chat', { src });
}

// --- Invisible Ink (Steganography) ---
const INVISIBLE_ZERO = '\u200B'
const INVISIBLE_ONE = '\u200C'
const INVISIBLE_SPLIT = '\u200D'

function asciiToBinary(str) {
  return str.split('').map(char => {
    return char.charCodeAt(0).toString(2).padStart(8, '0')
  }).join('')
}

function binaryToAscii(bin) {
  return bin.match(/.{1,8}/g).map(byte => {
    return String.fromCharCode(parseInt(byte, 2))
  }).join('')
}

function encodeInvisible(text) {
  const binary = asciiToBinary(text)
  return INVISIBLE_SPLIT + binary.split('').map(b => b === '0' ? INVISIBLE_ZERO : INVISIBLE_ONE).join('') + INVISIBLE_SPLIT
}

function decodeInvisible(text) {
  // Extract invisible invisible sequence
  const pattern = new RegExp(`${INVISIBLE_SPLIT}([${INVISIBLE_ZERO}${INVISIBLE_ONE}]+)${INVISIBLE_SPLIT}`)
  const match = text.match(pattern)
  if (!match) return null
  
  const binary = match[1].split('').map(c => c === INVISIBLE_ZERO ? '0' : '1').join('')
  return binaryToAscii(binary)
}

function setupInvisibleInk() {
  let isInvisibleMode = false
  const innocentPhrases = [
    "Sounds good to me.", "I'll check it out.", "Okay, let me know.", 
    "Just finishing up here.", "That's interesting.", "Can we talk later?",
    "Hey, what's up?", "Got it.", "No worries.", "See you soon.",
    "Thanks for the update.", "I agree.", "On my way."
  ]

  // UI Injection
  const injectToggle = () => {
    const actions = document.querySelector('div[aria-label="Message actions"]') || 
                    document.querySelector('div[aria-label="Conversation actions"]')
    
    // Look for the input area container to attach
    const inputArea = document.querySelector('div[role="textbox"]') || 
                      document.querySelector('div[contenteditable="true"]') ||
                      document.querySelector('div[aria-label="Message"]')
                      
    if (!inputArea) return

    if (document.getElementById('invisible-ink-toggle')) return

    const btn = document.createElement('div')
    btn.id = 'invisible-ink-toggle'
    btn.innerHTML = ICONS.lock
    btn.title = "Invisible Ink Mode"
    btn.style.cssText = `
      position: absolute; bottom: 100%; right: 20px;
      width: 40px; height: 40px; background: rgba(0,0,0,0.5);
      border-radius: 50%; display: flex; align-items: center; justify-content: center;
      cursor: pointer; z-index: 100; margin-bottom: 5px;
      font-size: 16px; transition: all 0.2s;
      color: white;
    `
    btn.onclick = () => {
      isInvisibleMode = !isInvisibleMode
      const input = document.querySelector('div[role="textbox"]')
      
      if (isInvisibleMode) {
        btn.style.background = '#0084ff'
        btn.innerHTML = ICONS.ghost
        if (input) {
            input.setAttribute('data-placeholder-original', input.getAttribute('aria-label') || '')
            // visual feedback
            input.style.border = '2px solid #0084ff'
        }
      } else {
        btn.style.background = 'rgba(0,0,0,0.5)'
        btn.innerHTML = ICONS.lock
        if (input) input.style.border = 'none'
      }
    }
    
    // Attach near input
    const container = inputArea.closest('div[role="none"]') || inputArea.parentElement
    if (container) {
        container.style.position = 'relative'
        container.appendChild(btn)
    }
  }

  // Poll for UI
  setInterval(injectToggle, 2000)

  // Intercept Sending
  document.addEventListener('keydown', (e) => {
    if (!isInvisibleMode) return
    if (e.key === 'Enter' && !e.shiftKey) {
        const input = document.querySelector('div[role="textbox"]')
        if (!input) return
        
        const secret = input.innerText.trim()
        if (!secret) return
        
        e.preventDefault()
        e.stopPropagation()
        
        // Encode
        const innocent = innocentPhrases[Math.floor(Math.random() * innocentPhrases.length)]
        const payload = innocent + ' ' + encodeInvisible(secret)
        
        // Replace and Send
        
        // Using strict execCommand for Messenger compatibility
        document.execCommand('selectAll', false, null)
        document.execCommand('insertText', false, payload)
        
        // Let React state catch up then dispatch enter
        setTimeout(() => {
            const enter = new KeyboardEvent('keydown', {
                bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13
            })
            input.dispatchEvent(enter)
        }, 50)
        
        // Reset (optional, React usually clears it)
        isInvisibleMode = false
        const btn = document.getElementById('invisible-ink-toggle')
        if (btn) {
            btn.style.background = 'rgba(0,0,0,0.5)'
            btn.innerHTML = ICONS.lock
            input.style.border = 'none'
        }
    }
  }, true)

  // Decoder Observer
  const decodeObserver = new MutationObserver((mutations) => {
    document.querySelectorAll('div[dir="auto"]').forEach(el => {
        if (el.dataset.scanned) return
        const text = el.innerText
        if (text && text.includes(INVISIBLE_SPLIT)) {
            const secret = decodeInvisible(text)
            if (secret) {
                el.innerText = '' // clear
                
                const lock = document.createElement('span')
                lock.innerHTML = ICONS.lock + ' '
                lock.style.verticalAlign = 'middle'
                lock.style.marginRight = '4px'
                
                const secretSpan = document.createElement('span')
                secretSpan.textContent = secret
                secretSpan.style.color = '#ff4400'
                secretSpan.style.fontWeight = 'bold'
                secretSpan.style.backgroundColor = 'rgba(255,255,0,0.1)'
                secretSpan.style.padding = '2px 4px'
                secretSpan.style.borderRadius = '4px'

                const originalSpan = document.createElement('span')
                originalSpan.textContent = ` (${text.replace(INVISIBLE_SPLIT, '').substring(0, 10)}...)`
                originalSpan.style.fontSize = '10px'
                originalSpan.style.opacity = '0.5'
                
                el.appendChild(lock)
                el.appendChild(secretSpan)
                el.appendChild(originalSpan)
                el.dataset.scanned = 'true'
            }
        }
    })
  })
  
  decodeObserver.observe(document.body, { childList: true, subtree: true, characterData: true })
}
