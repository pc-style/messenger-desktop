const { contextBridge, ipcRenderer } = require('electron')

// channel passed via additionalArguments to isolate per dialog instance
const arg = process.argv.find(a => a.startsWith('--dialog-channel='))
const channel = arg ? arg.replace('--dialog-channel=', '') : null

function sendResult(value) {
  if (!channel) return
  ipcRenderer.send(channel, value)
}

contextBridge.exposeInMainWorld('dialogAPI', {
  submit: (value) => sendResult(value),
  cancel: () => sendResult(null)
})
