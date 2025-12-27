// @ts-nocheck
import { ipcRenderer, contextBridge, webFrame } from "electron"
import { ICONS } from "./icons.js"
import { setupSettingsModal } from "./settings-modal.js"
import { setupSettingsEntry } from "./settings-entry.js"

declare global {
  interface Window {
    electronAPI?: any
  }
}

// state managed in preload (isolated from page)
let config = {
  keywordAlerts: [],
  keywordAlertsEnabled: false,
  clipboardSanitize: false,
  scheduleDelayMs: 30000,
  blockTypingIndicator: false,
  androidBubbles: false,
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
setupSettingsModal()

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

ipcRenderer.on('show-toast', (_, payload) => {
  if (typeof payload === 'string') {
    showToast(payload)
    return
  }
  const message = payload?.message
  if (!message) return
  showToast(message, payload)
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
  if (typingOverlayState.interval) clearInterval(typingOverlayState.interval)
  if (typingOverlayState.input) {
    typingOverlayState.input.style.opacity = ''
    typingOverlayState.input.style.pointerEvents = ''
    typingOverlayState.input.style.caretColor = ''
    typingOverlayState.input.style.userSelect = ''
  }
  typingOverlayState = { input: null, overlay: null, interval: null }
}

function installTypingOverlay() {
  if (!isMainFrame || !expTypingOverlayEnabled || !blockTypingIndicator) return
  
  const input =
    document.querySelector('div[role="textbox"][contenteditable="true"]') ||
    document.querySelector('div[aria-label="Message"]') ||
    document.querySelector('div[contenteditable="true"]')
    
  if (!input) {
    cleanupTypingOverlay()
    return
  }

  // Handle cross-navigation
  if (typingOverlayState.input && typingOverlayState.input !== input) {
    cleanupTypingOverlay()
  }

  if (!typingOverlayState.overlay) {
    const parent = input.parentElement
    if (!parent) return

    const overlay = document.createElement('div')
    overlay.id = 'unleashed-typing-overlay'
    overlay.setAttribute('contenteditable', 'true')
    overlay.setAttribute('role', 'textbox')
    overlay.setAttribute('aria-label', 'Type privately...')
    
    const inputStyle = window.getComputedStyle(input)
    
    // Position tracking
    const updateOverlayPosition = () => {
      if (!input || !overlay) return
      const rect = input.getBoundingClientRect()
      overlay.style.top = `${rect.top}px`
      overlay.style.left = `${rect.left}px`
      overlay.style.width = `${rect.width}px`
      overlay.style.height = `${rect.height}px`
    }

    overlay.style.cssText = `
      position: fixed;
      z-index: 2147483647;
      background: ${inputStyle.backgroundColor !== 'rgba(0, 0, 0, 0)' ? inputStyle.backgroundColor : '#242526'};
      color: ${inputStyle.color || '#fff'};
      font-family: ${inputStyle.fontFamily};
      font-size: ${inputStyle.fontSize};
      padding: ${inputStyle.padding};
      border-radius: ${inputStyle.borderRadius};
      outline: none;
      white-space: pre-wrap;
      overflow-wrap: break-word;
      box-sizing: border-box;
      border: 1px solid rgba(255,255,255,0.1);
      display: block;
    `
    updateOverlayPosition()
    document.body.appendChild(overlay)
    
    const posInterval = setInterval(updateOverlayPosition, 300)

    overlay.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        event.stopPropagation()

        const text = overlay.innerText.trim()
        if (!text) return

        // --- TUNNEL SEND ---
        // Restore input temporarily
        input.style.opacity = '1'
        input.style.pointerEvents = 'auto'
        input.style.visibility = 'visible'
        input.focus()

        // Clear and Insert logic (Draft.js safe)
        const selection = window.getSelection()
        const range = document.createRange()
        selection.removeAllRanges()
        range.selectNodeContents(input)
        selection.addRange(range)
        document.execCommand('delete', false, null)
        document.execCommand('insertText', false, text)
        
        // Dispatch Input event for React
        input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }))

        setTimeout(() => {
          // Attempt button click first (most reliable)
          const sendBtn = document.querySelector('div[aria-label="Press Enter to send"], div[aria-label="Send"], svg[aria-label="Send messenger"]')?.closest('div[role="button"]')
          if (sendBtn) {
            sendBtn.click()
          } else {
            // Fallback: keyboard events
            const options = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }
            input.dispatchEvent(new KeyboardEvent('keydown', options))
          }

          // Return to stealth mode
          setTimeout(() => {
            overlay.innerHTML = ''
            input.style.opacity = '0'
            input.style.pointerEvents = 'none'
            input.style.visibility = 'hidden'
            overlay.focus()
          }, 50)
        }, 10)
      }
    }, true)

    // Aggressive suppression of original input
    input.style.opacity = '0'
    input.style.pointerEvents = 'none'
    input.style.visibility = 'hidden'
    input.setAttribute('tabindex', '-1')
    
    // Block focus theft
    input.addEventListener('focus', (e) => {
      if (expTypingOverlayEnabled && blockTypingIndicator && document.activeElement !== overlay) {
        overlay.focus()
      }
    }, true)

    typingOverlayState = { input, overlay, interval: posInterval }
    overlay.focus()
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

function ensureToastContainer() {
  let container = document.getElementById('unleashed-toast-container')
  if (container) return container

  container = document.createElement('div')
  container.id = 'unleashed-toast-container'
  container.style.cssText = `
    position: fixed; bottom: 20px; right: 20px; z-index: 2147483646;
    display: flex; flex-direction: column; gap: 8px; align-items: flex-end;
    pointer-events: none; max-width: 60vw;
  `
  document.body.appendChild(container)
  return container
}

function showToast(message, options = {}) {
  const container = ensureToastContainer()
  if (!container) return

  const tone = options.tone || 'info'
  const duration = typeof options.duration === 'number' ? options.duration : 3200

  const accent = tone === 'success' ? '#30d158' : tone === 'warning' ? '#ffd60a' : '#0084ff'
  const toast = document.createElement('div')
  toast.textContent = message
  toast.style.cssText = `
    background: rgba(18, 18, 18, 0.92); color: #fff;
    padding: 10px 14px; border-radius: 10px; font-size: 12px; font-weight: 600;
    box-shadow: 0 12px 30px rgba(0,0,0,0.35);
    border-left: 3px solid ${accent};
    transform: translateY(6px); opacity: 0;
    transition: opacity 0.2s ease, transform 0.2s ease;
  `

  container.appendChild(toast)
  requestAnimationFrame(() => {
    toast.style.opacity = '1'
    toast.style.transform = 'translateY(0)'
  })

  const remove = () => {
    toast.style.opacity = '0'
    toast.style.transform = 'translateY(6px)'
    setTimeout(() => toast.remove(), 200)
  }

  setTimeout(remove, Math.max(1200, duration))
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
  setupSettingsEntry()
  setupInvisibleInk() // Steganography
  setInterval(scrapeActiveChat, 2000)
})

function scrapeActiveChat() {
  const activeLink =
    document.querySelector('div[role="navigation"] a[aria-current="page"]') ||
    document.querySelector('div[aria-label="Chats"] a[aria-current="page"]')

  const avatarSrc =
    getAvatarSrc(activeLink) ||
    getAvatarSrc(document.querySelector('div[role="banner"]')) ||
    getAvatarSrc(document.querySelector('header'))

  if (!avatarSrc) return

  ipcRenderer.send('update-active-chat', { src: avatarSrc })
}

function getAvatarSrc(container) {
  if (!container) return null
  const img =
    container.querySelector('img') ||
    container.querySelector('svg image') ||
    container.querySelector('svg mask image') ||
    container.querySelector('image')
  if (!img) return null
  return (
    img.src ||
    img.getAttribute('href') ||
    img.getAttribute('xlink:href') ||
    null
  )
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

// --- Unsend Detection ---
// tracks messages to detect when someone unsends a message

const messageCache = new Map()
let unsendDetectionEnabled = false
let unsendObserver: MutationObserver | null = null
let unsendScanInterval: ReturnType<typeof setInterval> | null = null

function generateMessageId(parent: Element, el: Element): string {
  // prefer stable messenger-specific IDs
  const msgId = parent.getAttribute('data-message-id') || parent.getAttribute('data-testid')
  if (msgId) return msgId

  // fallback: timestamp + position-based ID (more stable than text content)
  const timeEl = parent.querySelector('time')
  const timestamp = timeEl?.getAttribute('datetime') || ''
  const rowIndex = parent.getAttribute('data-row-index') || ''
  if (timestamp) return `${timestamp}-${rowIndex}`

  // last resort: text-based hash
  const text = (el as HTMLElement).innerText || ''
  return `text-${text.length}-${text.slice(0, 50).replace(/\s/g, '')}`
}

function setupUnsendDetection() {
  // prevent duplicate observers
  if (unsendObserver) return

  const scanMessages = () => {
    const messageElements = document.querySelectorAll('div[dir="auto"]')
    messageElements.forEach((el) => {
      const parent = el.closest('div[role="row"]') || el.closest('div[data-testid]')
      if (!parent) return

      const id = generateMessageId(parent, el)
      if (!id) return

      const text = (el as HTMLElement).innerText?.trim()
      if (text && text.length > 0 && !messageCache.has(id)) {
        messageCache.set(id, {
          text,
          timestamp: Date.now()
        })
      }
    })

    // cleanup old messages (older than 1 hour)
    const oneHourAgo = Date.now() - 3600000
    const maxSize = 500
    for (const [key, value] of messageCache.entries()) {
      if (value.timestamp < oneHourAgo) {
        messageCache.delete(key)
      }
    }
    // limit cache size by removing oldest entries
    if (messageCache.size > maxSize) {
      const entries = Array.from(messageCache.entries())
      entries.sort((a, b) => a[1].timestamp - b[1].timestamp)
      const toRemove = messageCache.size - maxSize
      entries.slice(0, toRemove).forEach(([k]) => messageCache.delete(k))
    }
  }

  unsendObserver = new MutationObserver((mutations) => {
    if (!unsendDetectionEnabled) return

    mutations.forEach((mutation) => {
      mutation.removedNodes.forEach((node) => {
        if (!(node instanceof HTMLElement)) return

        const isMessageContainer = node.querySelector?.('div[dir="auto"]') ||
          node.matches?.('div[role="row"]') ||
          node.matches?.('div[data-testid*="message"]')

        if (isMessageContainer) {
          // use the already-found element if it's a div[dir="auto"], otherwise query
          const textEl = (node.matches?.('div[dir="auto"]') ? node : node.querySelector?.('div[dir="auto"]')) as HTMLElement | null
          const text = textEl?.innerText?.trim()

          if (text && text.length > 2) {
            console.log('[Unleashed] Message unsent detected:', text.slice(0, 100))

            if (window.electronAPI?.showNotification) {
              window.electronAPI.showNotification('Message Unsent', {
                body: `"${text.slice(0, 80)}${text.length > 80 ? '...' : ''}"`,
                silent: false
              })
            }

            showToast(`📩 Unsent: "${text.slice(0, 40)}${text.length > 40 ? '...' : ''}"`, {
              tone: 'warning',
              duration: 5000
            })
          }
        }
      })
    })

    scanMessages()
  })

  const messageArea = document.querySelector('div[aria-label="Messages"]') || document.body
  unsendObserver.observe(messageArea, { childList: true, subtree: true })

  scanMessages()
  unsendScanInterval = setInterval(scanMessages, 5000)
}

ipcRenderer.on('set-unsend-detection', (_, enabled) => {
  unsendDetectionEnabled = enabled
  if (enabled && document.body) {
    setupUnsendDetection()
  } else {
    // cleanup when disabled
    if (unsendObserver) {
      unsendObserver.disconnect()
      unsendObserver = null
    }
    if (unsendScanInterval) {
      clearInterval(unsendScanInterval)
      unsendScanInterval = null
    }
    messageCache.clear()
  }
})

// --- Auto-Reply (Away Mode) ---
let autoReplyEnabled = false
let autoReplyMessage = "I'm currently away. I'll get back to you soon!"
const repliedChats = new Map<string, number>() // chatId -> timestamp
let autoReplyObserver: MutationObserver | null = null
const pendingAutoReplies = new Map<string, ReturnType<typeof setTimeout>>() // track pending timeouts
const MAX_REPLIED_CHATS = 100

function sendAutoReply() {
  const input = document.querySelector('div[role="textbox"][contenteditable="true"]') ||
    document.querySelector('div[aria-label="Message"]') ||
    document.querySelector('div[contenteditable="true"]')

  if (!input) return false

  input.focus()

  const selection = window.getSelection()
  const range = document.createRange()
  selection?.removeAllRanges()
  range.selectNodeContents(input)
  selection?.addRange(range)
  document.execCommand('delete', false, null)
  document.execCommand('insertText', false, autoReplyMessage)

  input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: autoReplyMessage }))

  setTimeout(() => {
    const enterEvent = new KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      bubbles: true,
      cancelable: true
    })
    input.dispatchEvent(enterEvent)
  }, 100)

  return true
}

function cleanupRepliedChats() {
  // remove entries older than 24 hours and limit size
  const dayAgo = Date.now() - 86400000
  for (const [key, timestamp] of repliedChats.entries()) {
    if (timestamp < dayAgo) repliedChats.delete(key)
  }
  // limit size by removing oldest entries
  if (repliedChats.size > MAX_REPLIED_CHATS) {
    const entries = Array.from(repliedChats.entries())
    entries.sort((a, b) => a[1] - b[1])
    entries.slice(0, entries.length - MAX_REPLIED_CHATS).forEach(([k]) => repliedChats.delete(k))
  }
}

function setupAutoReply() {
  // prevent duplicate observers
  if (autoReplyObserver) return

  autoReplyObserver = new MutationObserver((mutations) => {
    if (!autoReplyEnabled) return

    mutations.forEach((mutation) => {
      mutation.addedNodes.forEach((node) => {
        if (!(node instanceof HTMLElement)) return

        const isIncoming = node.matches?.('div[data-testid*="incoming"]') ||
          node.querySelector?.('div[data-testid*="incoming"]')

        // verify it's not our own message (check for outgoing indicators)
        const isOutgoing = node.matches?.('[data-testid*="outgoing"]') ||
          node.querySelector?.('[data-testid*="outgoing"]') ||
          node.closest?.('[class*="outgoing"]')

        if (isIncoming && !isOutgoing) {
          const chatLink = document.querySelector('a[aria-current="page"]')
          const chatId = chatLink?.getAttribute('href') || 'unknown'

          if (!repliedChats.has(chatId)) {
            const replyTimestamp = Date.now()
            repliedChats.set(chatId, replyTimestamp)
            cleanupRepliedChats()

            // schedule reply with cancellation support
            const timeoutId = setTimeout(() => {
              pendingAutoReplies.delete(chatId)
              if (autoReplyEnabled && repliedChats.get(chatId) === replyTimestamp) {
                const success = sendAutoReply()
                if (success) {
                  showToast('Auto-reply sent', { tone: 'info', duration: 2000 })
                }
              }
            }, 2000 + Math.random() * 3000)
            pendingAutoReplies.set(chatId, timeoutId)
          }
        }
      })
    })
  })

  const messageArea = document.querySelector('div[aria-label="Messages"]') || document.body
  autoReplyObserver.observe(messageArea, { childList: true, subtree: true })
}

ipcRenderer.on('set-auto-reply', (_, enabled) => {
  autoReplyEnabled = enabled
  if (enabled) {
    repliedChats.clear()
    setupAutoReply()
  } else {
    // cancel all pending auto-replies
    pendingAutoReplies.forEach(timeoutId => clearTimeout(timeoutId))
    pendingAutoReplies.clear()
    // cleanup observer when disabled
    if (autoReplyObserver) {
      autoReplyObserver.disconnect()
      autoReplyObserver = null
    }
  }
})

ipcRenderer.on('set-auto-reply-message', (_, message) => {
  if (typeof message === 'string') {
    autoReplyMessage = message
  }
})

// --- Link Preview Blocking ---
let linkPreviewBlocking = false

ipcRenderer.on('set-link-preview-blocking', (_, enabled) => {
  linkPreviewBlocking = enabled
  if (enabled) {
    const style = document.createElement('style')
    style.id = 'unleashed-link-preview-block'
    style.textContent = `
      div[role="link"],
      a[role="link"] > div[style*="border-radius"],
      div[data-testid*="link-preview"],
      div[data-testid*="url-preview"] {
        display: none !important;
      }
    `
    document.head.appendChild(style)
  } else {
    const existing = document.getElementById('unleashed-link-preview-block')
    if (existing) existing.remove()
  }
})

// --- Conversation Search ---
let searchOverlay: HTMLElement | null = null

ipcRenderer.on('show-conversation-search', () => {
  if (searchOverlay) {
    searchOverlay.style.display = 'flex'
    const input = searchOverlay.querySelector('input')
    if (input) (input as HTMLInputElement).focus()
    return
  }

  searchOverlay = document.createElement('div')
  searchOverlay.id = 'unleashed-search-overlay'
  searchOverlay.innerHTML = `
    <div style="
      position: fixed; top: 60px; right: 20px;
      background: rgba(30, 30, 35, 0.95);
      backdrop-filter: blur(10px);
      border-radius: 12px; padding: 12px 16px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.3);
      z-index: 999999; display: flex; gap: 8px; align-items: center;
      border: 1px solid rgba(255,255,255,0.1);
    ">
      <input type="text" placeholder="Search in conversation..." style="
        background: rgba(255,255,255,0.1); border: none;
        padding: 8px 12px; border-radius: 8px;
        color: white; font-size: 14px; width: 250px; outline: none;
      " />
      <span id="search-count" style="color: rgba(255,255,255,0.6); font-size: 12px; min-width: 60px;"></span>
      <button id="search-prev" style="background: rgba(255,255,255,0.1); border: none; padding: 6px 10px; border-radius: 6px; color: white; cursor: pointer;">▲</button>
      <button id="search-next" style="background: rgba(255,255,255,0.1); border: none; padding: 6px 10px; border-radius: 6px; color: white; cursor: pointer;">▼</button>
      <button id="search-close" style="background: rgba(255,255,255,0.1); border: none; padding: 6px 10px; border-radius: 6px; color: white; cursor: pointer;">✕</button>
    </div>
  `
  document.body.appendChild(searchOverlay)

  const input = searchOverlay.querySelector('input') as HTMLInputElement
  const countEl = searchOverlay.querySelector('#search-count') as HTMLElement
  let matches: HTMLElement[] = []
  let currentIndex = -1

  const clearHighlights = () => {
    const parents = new Set<Node>()
    document.querySelectorAll('.unleashed-highlight').forEach(el => {
      const parent = el.parentNode
      if (parent) {
        parent.replaceChild(document.createTextNode(el.textContent || ''), el)
        parents.add(parent)
      }
    })
    parents.forEach(p => p.normalize())
    matches = []
    currentIndex = -1
  }

  const doSearch = () => {
    clearHighlights()
    const query = input.value.trim().toLowerCase()
    if (!query) { countEl.textContent = ''; return }

    const messageArea = document.querySelector('div[aria-label="Messages"]')
    if (!messageArea) return

    const walker = document.createTreeWalker(messageArea, NodeFilter.SHOW_TEXT)
    const textNodes: Text[] = []
    while (walker.nextNode()) {
      const node = walker.currentNode as Text
      if (node.textContent?.toLowerCase().includes(query)) textNodes.push(node)
    }

    textNodes.forEach(node => {
      const text = node.textContent || ''
      const lowerText = text.toLowerCase()
      const parent = node.parentNode
      if (!parent) return

      // find all occurrences
      const frag = document.createDocumentFragment()
      let lastIdx = 0
      let idx = lowerText.indexOf(query)

      while (idx !== -1) {
        if (idx > lastIdx) frag.appendChild(document.createTextNode(text.slice(lastIdx, idx)))
        const span = document.createElement('span')
        span.className = 'unleashed-highlight'
        span.style.cssText = 'background: yellow; color: black; border-radius: 2px;'
        span.textContent = text.slice(idx, idx + query.length)
        frag.appendChild(span)
        matches.push(span)
        lastIdx = idx + query.length
        idx = lowerText.indexOf(query, lastIdx)
      }

      if (lastIdx < text.length) frag.appendChild(document.createTextNode(text.slice(lastIdx)))
      parent.replaceChild(frag, node)
    })

    countEl.textContent = matches.length ? `${matches.length} found` : 'No matches'
    if (matches.length) { currentIndex = 0; updateCurrent() }
  }

  const updateCurrent = () => {
    matches.forEach((el, i) => {
      el.style.background = i === currentIndex ? 'orange' : 'yellow'
    })
    if (matches[currentIndex]) {
      matches[currentIndex].scrollIntoView({ behavior: 'smooth', block: 'center' })
      countEl.textContent = `${currentIndex + 1}/${matches.length}`
    }
  }

  input.addEventListener('input', doSearch)
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      currentIndex = e.shiftKey ? (currentIndex - 1 + matches.length) % matches.length : (currentIndex + 1) % matches.length
      updateCurrent()
    }
    if (e.key === 'Escape') { clearHighlights(); searchOverlay!.style.display = 'none' }
  })

  searchOverlay.querySelector('#search-prev')?.addEventListener('click', () => {
    if (matches.length) { currentIndex = (currentIndex - 1 + matches.length) % matches.length; updateCurrent() }
  })
  searchOverlay.querySelector('#search-next')?.addEventListener('click', () => {
    if (matches.length) { currentIndex = (currentIndex + 1) % matches.length; updateCurrent() }
  })
  searchOverlay.querySelector('#search-close')?.addEventListener('click', () => {
    clearHighlights(); searchOverlay!.style.display = 'none'
  })

  input.focus()
})

// --- Conversation Statistics ---
ipcRenderer.on('show-conversation-stats', () => {
  const messageArea = document.querySelector('div[aria-label="Messages"]')
  if (!messageArea) { showToast('No conversation open', { tone: 'warning' }); return }

  const header = document.querySelector('div[role="banner"]')
  const chatName = header?.querySelector('span')?.innerText || header?.querySelector('h1')?.innerText || 'Conversation'

  const messages = messageArea.querySelectorAll('div[role="row"], div[data-testid*="message"]')
  let total = 0, yours = 0, theirs = 0, chars = 0, media = 0

  messages.forEach((msg) => {
    const text = msg.querySelector('div[dir="auto"]')?.textContent?.trim()
    if (!text) return
    total++
    chars += text.length
    const isOut = msg.matches?.('[data-testid*="outgoing"]') || msg.querySelector?.('[data-testid*="outgoing"]')
    if (isOut) yours++; else theirs++
    if (msg.querySelector('img:not([alt=""]), video')) media++
  })

  const avgLen = total > 0 ? Math.round(chars / total) : 0
  const yourPct = total > 0 ? Math.round((yours / total) * 100) : 0

  const modal = document.createElement('div')
  modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;z-index:999999;'
  // escape HTML via DOM to prevent XSS
  const escapeHtml = (str: string) => { const d = document.createElement('div'); d.textContent = str; return d.innerHTML }
  const safeChatName = escapeHtml(chatName)
  modal.innerHTML = `
    <div style="background:linear-gradient(135deg,#1a1a2e,#16213e);border-radius:16px;padding:24px 32px;min-width:320px;box-shadow:0 20px 60px rgba(0,0,0,0.5);border:1px solid rgba(255,255,255,0.1);">
      <h2 style="margin:0 0 20px;color:white;font-size:18px;">📊 ${safeChatName}</h2>
      <div style="display:grid;gap:12px;">
        <div style="display:flex;justify-content:space-between;color:rgba(255,255,255,0.8);"><span>Total Messages</span><strong style="color:#6366f1">${total}</strong></div>
        <div style="display:flex;justify-content:space-between;color:rgba(255,255,255,0.8);"><span>Your Messages</span><strong style="color:#22c55e">${yours} (${yourPct}%)</strong></div>
        <div style="display:flex;justify-content:space-between;color:rgba(255,255,255,0.8);"><span>Their Messages</span><strong style="color:#f59e0b">${theirs} (${100 - yourPct}%)</strong></div>
        <div style="display:flex;justify-content:space-between;color:rgba(255,255,255,0.8);"><span>Avg Message Length</span><strong style="color:#06b6d4">${avgLen} chars</strong></div>
        <div style="display:flex;justify-content:space-between;color:rgba(255,255,255,0.8);"><span>Media Shared</span><strong style="color:#ec4899">${media}</strong></div>
      </div>
      <button id="close-stats" style="margin-top:20px;width:100%;padding:10px;background:rgba(255,255,255,0.1);border:none;border-radius:8px;color:white;cursor:pointer;font-size:14px;">Close</button>
    </div>
  `
  document.body.appendChild(modal)
  modal.addEventListener('click', (e) => {
    if (e.target === modal || (e.target as HTMLElement).id === 'close-stats') modal.remove()
  })
})

// --- Conversation Export ---
ipcRenderer.on('export-conversation-request', () => {
  const messages = []

  const header = document.querySelector('div[role="banner"]')
  const chatNameEl = header?.querySelector('span') || header?.querySelector('h1')
  const chatName = chatNameEl?.innerText || 'Conversation'

  // scrape all visible messages
  const messageArea = document.querySelector('div[aria-label="Messages"]')
  if (!messageArea) {
    ipcRenderer.send('export-conversation-data', { chatName, messages: [] })
    return
  }

  // find all message rows
  const rows = messageArea.querySelectorAll('div[role="row"], div[data-testid*="message"]')

  rows.forEach((row) => {
    const textEl = row.querySelector('div[dir="auto"]')
    const text = textEl?.innerText?.trim()
    if (!text) return

    // try to determine sender (incoming vs outgoing)
    const isOutgoing = row.matches?.('[data-testid*="outgoing"]') ||
      row.querySelector?.('[data-testid*="outgoing"]') ||
      row.closest?.('[data-testid*="outgoing"]')

    // try to find timestamp (use null if not found rather than fabricating one)
    const timeEl = row.querySelector('time') || row.querySelector('[datetime]')
    const time = timeEl?.getAttribute('datetime') || timeEl?.innerText || null

    messages.push({
      sender: isOutgoing ? 'You' : chatName,
      text,
      time,
      isOutgoing
    })
  })

  ipcRenderer.send('export-conversation-data', { chatName, messages })
})
