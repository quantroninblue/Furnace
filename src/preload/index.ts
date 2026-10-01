import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { WorkspaceAPI } from "../shared/types";

function subscribe<T>(channel: string, callback: (value: T) => void) {
  const listener = (_event: Electron.IpcRendererEvent, value: T) =>
    callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}
const api: WorkspaceAPI = {
  claude: {
    login: consoleAccount => ipcRenderer.invoke("claude:login", consoleAccount),
    stopLogin: () => ipcRenderer.invoke("claude:stop-login"),
    write: data => ipcRenderer.invoke("claude:write", data),
    resize: (cols, rows) => ipcRenderer.invoke("claude:resize", cols, rows),
    guide: () => ipcRenderer.invoke("claude:guide"),
    onLoginData: callback => subscribe("claude:login-data", callback),
    onLoginExit: callback => subscribe("claude:login-exit", callback),
  },
  chatgpt: {
    signIn: (accountId, remember) => ipcRenderer.invoke("chatgpt:sign-in", accountId, remember),
    cancel: () => ipcRenderer.invoke("chatgpt:cancel"),
    select: accountId => ipcRenderer.invoke("chatgpt:select", accountId),
    signOut: accountId => ipcRenderer.invoke("chatgpt:sign-out", accountId),
    acknowledge: () => ipcRenderer.invoke("chatgpt:acknowledge"),
    usage: () => ipcRenderer.invoke("chatgpt:usage"),
  },
  windowControls: {
    minimize: () => ipcRenderer.invoke("window:minimize"),
    toggleMaximize: () => ipcRenderer.invoke("window:toggle-maximize"),
    close: () => ipcRenderer.invoke("window:close"),
    isMaximized: () => ipcRenderer.invoke("window:is-maximized"),
    onMaximized: (callback) => subscribe("window:maximized", callback),
  },
  project: {
    open: () => ipcRenderer.invoke("project:open"),
    current: () => ipcRenderer.invoke("project:current"),
    list: (path) => ipcRenderer.invoke("project:list", path),
  },
  file: {
    read: (path) => ipcRenderer.invoke("file:read", path),
    save: (document) => ipcRenderer.invoke("file:save", document),
    applyProposal: (id, text) => ipcRenderer.invoke("file:apply-proposal", id, text),
    discardProposal: (id) => ipcRenderer.invoke("file:discard-proposal", id),
  },
  attachments: {
    choose: () => ipcRenderer.invoke("attachments:choose"),
    import: (paths) => ipcRenderer.invoke("attachments:import", paths),
    path: (file) => webUtils.getPathForFile(file),
  },
  session: {
    read: () => ipcRenderer.invoke("session:read"),
    start: () => ipcRenderer.invoke("session:start"),
    list: () => ipcRenderer.invoke("session:list"),
    resume: id => ipcRenderer.invoke("session:resume", id),
    write: (data, root) => ipcRenderer.invoke("session:write", data, root),
  },
  agents: {
    discover: () => ipcRenderer.invoke("agents:discover"),
    connect: (provider, key, remember) => ipcRenderer.invoke("agents:connect", provider, key, remember),
    disconnect: provider => ipcRenderer.invoke("agents:disconnect", provider),
    send: (request) => ipcRenderer.invoke("agents:send", request),
    stop: () => ipcRenderer.invoke("agents:stop"),
    onEvent: (callback) => subscribe("agents:event", callback),
  },
  terminal: {
    run: (request) => ipcRenderer.invoke("terminal:run", request),
    start: () => ipcRenderer.invoke("terminal:start"),
    write: (data) => ipcRenderer.invoke("terminal:write", data),
    resize: (cols, rows) => ipcRenderer.invoke("terminal:resize", cols, rows),
    onData: (callback) => subscribe("terminal:data", callback),
  },
  research: {
    open: (url, placement) => ipcRenderer.invoke("research:open", url, placement),
    bounds: value => ipcRenderer.invoke("research:browser-bounds", value),
    onBrowserState: callback => subscribe("research:browser-state", callback),
    onDock: callback => subscribe("research:browser-dock", callback),
    capture: () => ipcRenderer.invoke("research:capture-page"),
    onSelection: (callback) => subscribe("research:selection", callback),
  },
};
contextBridge.exposeInMainWorld("workspace", api);
