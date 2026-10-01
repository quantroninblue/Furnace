import { contextBridge, ipcRenderer } from "electron";
import type { BrowserAPI } from "../shared/browser";
const api: BrowserAPI = {
  state: () => ipcRenderer.invoke("browser:state"),
  navigate: value => ipcRenderer.invoke("browser:navigate", value),
  action: value => ipcRenderer.invoke("browser:action", value),
  onState: callback => { const listener = (_event: unknown, state: Parameters<typeof callback>[0]) => callback(state); ipcRenderer.on("browser:state", listener); return () => ipcRenderer.removeListener("browser:state", listener); },
  onFocusAddress: callback => { ipcRenderer.on("browser:focus-address", callback); return () => ipcRenderer.removeListener("browser:focus-address", callback); },
};
contextBridge.exposeInMainWorld("browserControls", api);
