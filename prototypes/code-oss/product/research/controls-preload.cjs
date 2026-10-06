const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('researchControls', {
    action: (action, value) => ipcRenderer.invoke('research:controls', { action, value }),
    onState: callback => ipcRenderer.on('research:state', (_event, state) => callback(state)),
    onFocusAddress: callback => ipcRenderer.on('research:focus-address', () => callback()),
});
