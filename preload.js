const { ipcRenderer, contextBridge } = require('electron')

// expose notification bridge to renderer
contextBridge.exposeInMainWorld('electronNotify', {
  send: (title, options) => {
    ipcRenderer.send('show-notification', { title, ...options })
  }
})

// inject notification override after page loads
window.addEventListener('DOMContentLoaded', () => {
  const script = document.createElement('script')
  script.textContent = `
    (function() {
      const OriginalNotification = window.Notification;

      // route notifications through Electron only (prevents duplicate system toasts)
      function ElectronNotification(title, options) {
        if (window.electronNotify) {
          window.electronNotify.send(title, options);
        }
        // return a minimal stub to satisfy caller expectations
        return {
          close: () => {},
          onclick: null,
          onclose: null,
          onerror: null,
          onshow: null
        };
      }

      ElectronNotification.permission = 'granted';
      ElectronNotification.requestPermission = function() {
        return Promise.resolve('granted');
      };

      ElectronNotification.prototype = OriginalNotification ? OriginalNotification.prototype : {};
      window.Notification = ElectronNotification;
    })();
  `
  document.head.appendChild(script)
})

// focus window when notification is clicked
ipcRenderer.on('notification-clicked', () => {
  window.focus()
})

// schedule send trigger from main process
ipcRenderer.on('schedule-send', (_, delayMs) => {
  window.dispatchEvent(new CustomEvent('unleashed-schedule-send', { detail: { delayMs } }))
})

// config updates (keyword alerts, sanitizer, delays)
ipcRenderer.on('update-config', (_, config) => {
  window.dispatchEvent(new CustomEvent('unleashed-config', { detail: config }))
})
