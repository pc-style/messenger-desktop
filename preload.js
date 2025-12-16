const { ipcRenderer, contextBridge, webFrame } = require('electron')

// state managed in preload (isolated from page)
let config = {
  keywordAlerts: [],
  keywordAlertsEnabled: false,
  clipboardSanitize: false,
  scheduleDelayMs: 30000,
  blockTypingIndicator: false
}

let blockReadReceipts = false
let blockTypingIndicator = false
let visibilityPatched = false

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
  if (enabled) {
    applyVisibilityOverride()
  } else {
    restoreVisibilityOverride()
  }
})

// typing indicator blocking now handled in main via webRequest; keep flag for potential UI reflection
ipcRenderer.on('set-block-typing-indicator', (_, enabled) => {
  blockTypingIndicator = enabled
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

// safe input modal (runs in preload context, not page context)
function showInputModal(title, message, defaultValue, callback, useTextarea = false) {
  // create modal in isolated context
  const overlay = document.createElement('div')
  overlay.style.cssText = `
    position: fixed; top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0,0,0,0.7); z-index: 999999;
    display: flex; align-items: center; justify-content: center;
  `

  const modal = document.createElement('div')
  modal.style.cssText = `
    background: #1e1e1e; padding: 20px; border-radius: 8px;
    min-width: 400px; max-width: 600px; color: #fff;
    font-family: -apple-system, BlinkMacSystemFont, sans-serif;
  `

  const titleEl = document.createElement('h3')
  titleEl.textContent = title
  titleEl.style.cssText = 'margin: 0 0 10px 0; font-size: 16px;'

  const messageEl = document.createElement('p')
  messageEl.textContent = message
  messageEl.style.cssText = 'margin: 0 0 10px 0; font-size: 13px; color: #aaa;'

  const input = document.createElement(useTextarea ? 'textarea' : 'input')
  input.value = defaultValue || ''
  input.style.cssText = `
    width: 100%; padding: 8px; box-sizing: border-box;
    background: #333; border: 1px solid #555; color: #fff;
    border-radius: 4px; font-size: 13px;
    ${useTextarea ? 'height: 150px; resize: vertical;' : ''}
  `

  const buttons = document.createElement('div')
  buttons.style.cssText = 'text-align: right; margin-top: 15px;'

  const cancelBtn = document.createElement('button')
  cancelBtn.textContent = 'Cancel'
  cancelBtn.style.cssText = 'padding: 8px 16px; margin-left: 8px; background: #444; color: #fff; border: none; border-radius: 4px; cursor: pointer;'

  const okBtn = document.createElement('button')
  okBtn.textContent = 'OK'
  okBtn.style.cssText = 'padding: 8px 16px; margin-left: 8px; background: #0084ff; color: #fff; border: none; border-radius: 4px; cursor: pointer;'

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

      // block visibilitychange events generated by the page
      const blockEvent = (e) => { e.stopImmediatePropagation(); };
      document.addEventListener('visibilitychange', blockEvent, true);

      window.__restoreVisibilityOverride = function restoreVisibilityOverride() {
        if (originals.hidden) Object.defineProperty(document, 'hidden', originals.hidden);
        if (originals.visibilityState) Object.defineProperty(document, 'visibilityState', originals.visibilityState);
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

// initialize when DOM is ready
window.addEventListener('DOMContentLoaded', () => {
  setupNotificationOverride()
  setupClipboardSanitizer()
  setupKeywordAlerts()
})
