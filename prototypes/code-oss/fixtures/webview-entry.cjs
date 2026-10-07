// Match Playwright's normal Electron loader when using our pinned executable.
require('../../../node_modules/playwright-core/lib/server/electron/loader.js');
// Loads one bundled webview surface in a sandboxed window, without Code OSS around it.
const { app, BrowserWindow } = require('electron');
app.whenReady().then(() => {
    const window = new BrowserWindow({ width: Number(process.env.AI_GUI_WEBVIEW_WIDTH) || 440, height: 860, show: true,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    void window.loadFile(process.env.AI_GUI_WEBVIEW_PAGE);
});
app.on('window-all-closed', () => app.quit());
