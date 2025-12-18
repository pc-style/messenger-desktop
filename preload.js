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

  const overlay = document.createElement('div')
  overlay.id = 'unleashed-settings-overlay'
  overlay.style.cssText = `
    position: fixed; top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0,0,0,0.6); z-index: 1000000;
    display: flex; align-items: center; justify-content: center;
    backdrop-filter: blur(15px) saturate(160%);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  `

  const modal = document.createElement('div')
  modal.style.cssText = `
    background: rgba(28, 28, 30, 0.95);
    width: 600px; max-height: 85vh;
    border-radius: 24px;
    border: 1px solid rgba(255, 255, 255, 0.1);
    box-shadow: 0 30px 60px rgba(0,0,0,0.5);
    display: flex; flex-direction: column;
    overflow: hidden; color: #fff;
    animation: settingsFadeIn 0.4s cubic-bezier(0.16, 1, 0.3, 1) forwards;
  `

  const style = document.createElement('style')
  style.textContent = `
    @keyframes settingsFadeIn {
      from { opacity: 0; transform: scale(0.95) translateY(20px); }
      to { opacity: 1; transform: scale(1) translateY(0); }
    }
    .settings-section { padding: 20px; border-bottom: 1px solid rgba(255,255,255,0.05); }
    .settings-section h4 { margin: 0 0 15px 0; color: #aaa; text-transform: uppercase; font-size: 11px; letter-spacing: 1px; }
    .settings-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
    .settings-row:last-child { margin-bottom: 0; }
    .settings-label { font-size: 14px; font-weight: 500; }
    .settings-desc { font-size: 12px; color: #888; margin-top: 2px; }
    .toggle { 
      position: relative; width: 44px; height: 24px; 
      background: #3a3a3c; border-radius: 12px; cursor: pointer;
      transition: background 0.2s;
    }
    .toggle.active { background: #30d158; }
    .toggle-knob {
      position: absolute; top: 2px; left: 2px; width: 20px; height: 20px;
      background: #fff; border-radius: 50%; transition: left 0.2s;
      box-shadow: 0 2px 4px rgba(0,0,0,0.2);
    }
    .toggle.active .toggle-knob { left: 22px; }
    .settings-btn {
      background: rgba(255,255,255,0.05); border: none; color: #fff;
      padding: 6px 12px; border-radius: 8px; font-size: 12px; cursor: pointer;
      transition: background 0.2s; font-weight: 500;
    }
    .settings-btn:hover { background: rgba(255,255,255,0.1); }
    .close-area { padding: 16px 24px; display: flex; justify-content: space-between; align-items: center; background: rgba(255,255,255,0.02); }
  `
  document.head.appendChild(style)

  const header = document.createElement('div')
  header.style.cssText = 'padding: 24px 24px 16px 24px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid rgba(255,255,255,0.05);'
  
  const titleGroup = document.createElement('div')
  const mainTitle = document.createElement('h2')
  mainTitle.textContent = 'Messenger Unleashed'
  mainTitle.style.cssText = 'margin: 0; font-size: 20px; font-weight: 800; background: linear-gradient(135deg, #6366f1, #06b6d4); -webkit-background-clip: text; -webkit-text-fill-color: transparent;'
  
  const subTitle = document.createElement('div')
  subTitle.textContent = 'v1.1.2 — Settings'
  subTitle.style.cssText = 'font-size: 12px; color: #666; font-weight: 600; margin-top: 2px;'
  
  titleGroup.append(mainTitle, subTitle)
  
  const closeBtn = document.createElement('div')
  closeBtn.innerHTML = '&times;'
  closeBtn.style.cssText = 'font-size: 28px; cursor: pointer; color: #555; position: relative; top: -5px;'
  closeBtn.onclick = () => overlay.remove()
  
  header.append(titleGroup, closeBtn)

  const scrollArea = document.createElement('div')
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
  privacyTitle.textContent = 'Privacy & Stealth'
  privacySection.append(privacyTitle)
  privacySection.append(createToggleRow('Block Read Receipts', 'Others won\'t know when you read messages.', 'blockReadReceipts', config.blockReadReceipts))
  privacySection.append(createToggleRow('Block Typing Indicator', 'Hide "typing..." while you compose.', 'blockTypingIndicator', config.blockTypingIndicator))
  privacySection.append(createToggleRow('Clipboard Sanitizer', 'Remove tracking data from pasted URLs.', 'clipboardSanitize', config.clipboardSanitize))
  
  // Appearance Section
  const appearanceSection = document.createElement('div')
  appearanceSection.className = 'settings-section'
  const appearanceTitle = document.createElement('h4')
  appearanceTitle.textContent = 'Appearance'
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
  cssBtn.onclick = () => { overlay.remove(); ipcRenderer.emit('edit-custom-css') }
  
  const themeBtn = document.createElement('button')
  themeBtn.className = 'settings-btn'
  themeBtn.style.background = 'linear-gradient(135deg, #6366f1, #a855f7)'
  themeBtn.textContent = 'Open Theme Creator'
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

  scrollArea.append(privacySection, appearanceSection, systemSection)

  const footer = document.createElement('div')
  footer.className = 'close-area'
  
  const footerHint = document.createElement('div')
  footerHint.textContent = 'Some changes may require a reload.'
  footerHint.style.cssText = 'font-size: 11px; color: #444;'
  
  const doneBtn = document.createElement('button')
  doneBtn.textContent = 'Close'
  doneBtn.style.cssText = 'padding: 10px 24px; border-radius: 12px; background: #fff; color: #000; border: none; font-weight: 700; cursor: pointer;'
  doneBtn.onclick = () => overlay.remove()
  
  footer.append(footerHint, doneBtn)

  modal.append(header, scrollArea, footer)
  overlay.appendChild(modal)
  document.body.appendChild(overlay)
  
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove() }
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
