import { contextBridge, ipcRenderer } from "electron"

// channel passed via additionalArguments to isolate per dialog instance
const arg = process.argv.find((a) => a.startsWith("--dialog-channel="))
const channel = arg ? arg.replace("--dialog-channel=", "") : null

function sendResult(value: any) {
  if (!channel) return
  ipcRenderer.send(channel, value)
}

contextBridge.exposeInMainWorld("dialogAPI", {
  submit: (value: any) => sendResult(value),
  cancel: () => sendResult(null),
})
