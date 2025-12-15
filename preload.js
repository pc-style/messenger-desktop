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

      window.Notification = function(title, options) {
        if (window.electronNotify) {
          window.electronNotify.send(title, options);
        }
        return new OriginalNotification(title, options);
      };

      window.Notification.permission = 'granted';
      window.Notification.requestPermission = function() {
        return Promise.resolve('granted');
      };
    })();
  `
  document.head.appendChild(script)
})

// focus window when notification is clicked
ipcRenderer.on('notification-clicked', () => {
  window.focus()
})
