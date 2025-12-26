import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("chatHeadAPI", {
  onUpdate: (handler: (info: { src?: string } | null) => void) => {
    ipcRenderer.on("update-head", (_, info) => {
      handler(info || null);
    });
  },
  notifyClick: () => {
    ipcRenderer.send("chat-head-clicked");
  },
});
