'use strict';
const { app, BrowserWindow, WebContentsView, session, ipcMain } = require('electron');
const { rmSync } = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const contract = require('../../../shared/research-contract.cjs');
const { extractionScript } = require('./extract.cjs');
const { browserURL } = require('../../../shared/research-url.cjs');
const { frames, send } = require('../research-transport.cjs');

// Electron's graceful exit can hang in native teardown after JavaScript has finished, and
// when the extension host is gone nobody else would kill the companion. A companion that
// leads its own process group (spawned by the transport) therefore ends that group outright;
// nothing needs flushing, as the session is ephemeral and the profile is removed first.
function exitNow(profile) {
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* Parent also cleans after exit. */ }
    try { process.kill(-process.pid, 'SIGKILL'); } catch { process.kill(process.pid, 'SIGKILL'); }
}
exports.exitNow = exitNow;

// Only the local controls get a preload; remote content gets no page bridge.
async function startHost({ pipe, host, scope, page: pageId, profile, hardExit = false }) {
    let window, view, closing = false, publishTimer;
    const state = { host, scope, page: pageId, generation: 0, url: '', title: '',
        loading: false, back: false, forward: false, opened: false, error: '' };
    contract.state(state);
    app.setPath('userData', profile); app.setPath('sessionData', profile);
    app.enableSandbox();
    const controlsURL = pathToFileURL(path.join(__dirname, 'controls.html')).href;
    const page = () => view && !view.webContents.isDestroyed() ? view.webContents : undefined;
    const shutdown = () => {
        if (closing) return;
        closing = true; clearTimeout(publishTimer);
        page()?.close({ waitForBeforeUnload: false });
        window?.destroy(); pipe.destroy();
        if (hardExit) exitNow(profile); else app.exit(0);
    };
    pipe.on('end', shutdown); pipe.on('error', shutdown);
    process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
    app.once('quit', () => { try { rmSync(profile, { recursive: true, force: true }); } catch { /* Parent also cleans after exit. */ } });
    const snapshot = () => ({ ...state });
    const reply = message => { if (!closing && !pipe.destroyed) send(pipe, contract.response({ v: 1, state: snapshot(), ...message })); };
    const publish = () => {
        if (closing) return;
        const contents = page();
        state.back = contents?.navigationHistory.canGoBack() ?? false;
        state.forward = contents?.navigationHistory.canGoForward() ?? false;
        if (window && !window.isDestroyed()) window.webContents.send('research:state', snapshot());
        // Bound noisy title/loading events without delaying local controls.
        if (!publishTimer) publishTimer = setTimeout(() => { publishTimer = undefined; reply({ type: 'state' }); }, 25);
    };
    const error = message => { state.error = message; publish(); };
    const allowed = url => { try { contract.httpURL(url); return true; } catch { return false; } };
    const navigate = url => {
        const contents = page();
        if (!contents) throw new Error('Research page is unavailable. Reopen the browser.');
        url = contract.httpURL(url);
        state.error = ''; state.url = url; state.title = ''; state.loading = true;
        // Acknowledge dispatch, not network completion, so Stop remains available.
        void contents.loadURL(url).catch(() => { /* did-fail-load owns navigation errors. */ });
        publish();
    };
    const action = (name, value) => {
        const contents = page();
        if (!contents) throw new Error('Research page is unavailable.');
        switch (name) {
            case 'open': window.show(); window.focus(); navigate(value); break;
            case 'navigate': navigate(value); break;
            case 'back': if (contents.navigationHistory.canGoBack()) { state.error = ''; contents.navigationHistory.goBack(); } break;
            case 'forward': if (contents.navigationHistory.canGoForward()) { state.error = ''; contents.navigationHistory.goForward(); } break;
            case 'reload': if (state.url) navigate(state.url); break;
            case 'stop': contents.stop(); state.loading = false; break;
            case 'close': shutdown(); return;
            default: throw new Error('Capture is not available yet.');
        }
        publish();
    };
    const focusAddress = () => { window.webContents.focus(); window.webContents.send('research:focus-address'); };
    await app.whenReady();
    if (closing) return;
    const isolated = session.fromPartition(`research-${host}`, { cache: false });
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    isolated.setPermissionCheckHandler(() => false);
    isolated.on('will-download', event => { event.preventDefault(); error('Downloads are not enabled in this research browser.'); });
    isolated.webRequest.onBeforeRequest((details, callback) => {
        const permitted = ['mainFrame', 'subFrame'].includes(details.resourceType)
            ? allowed(details.url) : /^(https?:|wss?:|data:|blob:)/i.test(details.url);
        callback({ cancel: !permitted });
    });
    window = new BrowserWindow({ title: 'Research · Furnace', width: 1120, height: 820, minWidth: 640, minHeight: 400,
        backgroundColor: '#202020', show: false, autoHideMenuBar: true,
        webPreferences: { preload: path.join(__dirname, 'controls-preload.cjs'), partition: `controls-${host}`,
            sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false } });
    window.removeMenu();
    view = new WebContentsView({ webPreferences: { session: isolated, sandbox: true, contextIsolation: true,
        nodeIntegration: false, webviewTag: false, navigateOnDragDrop: false } });
    view.setBackgroundColor('#ffffff');
    window.contentView.addChildView(view);
    const layout = () => { const [width, height] = window.getContentSize(); view.setBounds({ x: 0, y: 136, width, height: Math.max(0, height - 136) }); };
    layout(); window.on('resize', layout);
    window.on('close', event => { event.preventDefault(); shutdown(); });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.on('render-process-gone', shutdown);
    const contents = page();
    contents.setWindowOpenHandler(({ url }) => {
        if (allowed(url)) navigate(url); else error('Only HTTP and HTTPS links without credentials can be opened.');
        return { action: 'deny' };
    });
    const guard = (event, url) => {
        if (!allowed(url)) { event.preventDefault(); error('Only HTTP and HTTPS links without credentials can be opened.'); }
    };
    contents.on('will-navigate', guard); contents.on('will-redirect', guard);
    contents.on('will-frame-navigate', event => guard(event, event.url));
    contents.on('did-start-navigation', (_event, url, _inPlace, mainFrame) => {
        if (mainFrame && allowed(url)) {
            state.generation++; state.url = url; state.error = ''; state.title = ''; publish();
        }
    });
    contents.on('did-redirect-navigation', (_event, url, _inPlace, mainFrame) => {
        if (mainFrame && allowed(url)) { state.generation++; state.url = url; publish(); }
    });
    contents.on('did-navigate-in-page', (_event, url, mainFrame) => {
        if (mainFrame && allowed(url)) { state.generation++; state.url = url; publish(); }
    });
    contents.on('did-navigate', (_event, url) => { if (allowed(url)) state.url = url; publish(); });
    contents.on('did-start-loading', () => { state.loading = true; publish(); });
    contents.on('did-stop-loading', () => { state.loading = false; publish(); });
    contents.on('page-title-updated', (_event, title) => { state.title = title.slice(0, contract.limits.title); publish(); });
    contents.on('did-fail-load', (_event, code, _description, _url, mainFrame) => {
        if (mainFrame && code !== -3) {
            state.loading = false; error(`Could not load this page (${code}). Check the address or connection, then reload.`);
        }
    });
    contents.on('render-process-gone', () => {
        state.generation++; state.loading = false; error('The page stopped responding. Reload to reopen it.');
    });
    const keyboard = (event, input) => {
        if (input.type !== 'keyDown') return;
        if ((input.control || input.meta) && input.key.toLowerCase() === 'l') { event.preventDefault(); focusAddress(); }
        else if (input.key === 'F5' || ((input.control || input.meta) && input.key.toLowerCase() === 'r')) { event.preventDefault(); action('reload'); }
        else if (input.alt && input.key === 'ArrowLeft') { event.preventDefault(); action('back'); }
        else if (input.alt && input.key === 'ArrowRight') { event.preventDefault(); action('forward'); }
    };
    contents.on('before-input-event', keyboard); window.webContents.on('before-input-event', keyboard);
    ipcMain.handle('research:controls', (event, message) => {
        if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame
            || event.senderFrame.url !== controlsURL) throw new Error('Untrusted research controls');
        if (!message || typeof message !== 'object' || Object.keys(message).some(key => !['action', 'value'].includes(key))) throw new Error('Invalid controls');
        if (message.action === 'state') return snapshot();
        try {
            if (!['navigate', 'back', 'forward', 'reload', 'stop', 'close'].includes(message.action)) throw new Error('Unknown browser action.');
            action(message.action, message.action === 'navigate' ? browserURL(message.value) : undefined);
        } catch (reason) { error(reason.message); }
        return snapshot();
    });
    frames(pipe, value => {
        contract.request(value);
        if (value.host !== host || value.scope !== scope || value.page !== pageId) { shutdown(); return; }
        // Stop/close must work even if a navigation event crossed the request.
        if (!['stop', 'close'].includes(value.action) && value.generation !== state.generation) {
            reply({ type: 'result', id: value.id, error: 'Page changed. Try again.' }); return;
        }
        if (value.action === 'close') {
            state.opened = false; state.loading = false;
            reply({ type: 'result', id: value.id }); pipe.end(shutdown); return;
        }
        if (value.action === 'capture') {
            const captured = snapshot();
            if (captured.loading || !captured.url || captured.error) { reply({ type: 'result', id: value.id, error: 'Wait for a loaded page before capturing.' }); return; }
            void contents.executeJavaScriptInIsolatedWorld(999, [{ code: extractionScript(value.kind) }]).then(data => {
                if (!contract.samePage(captured, state) || state.loading || state.error) throw new Error('Research capture expired');
                if (!data.text.trim()) throw new Error('No readable text was selected or found.');
                const capture = contract.capture({ ...data, host, scope, page: pageId, generation: captured.generation, id: value.id, kind: value.kind, url: captured.url });
                reply({ type: 'result', id: value.id, capture });
            }).catch(() => reply({ type: 'result', id: value.id, error: 'Capture unavailable or page changed. Select readable text outside forms, or reload and retry.' }));
            return;
        }
        try { action(value.action, value.url); reply({ type: 'result', id: value.id }); }
        catch (reason) { reply({ type: 'result', id: value.id, error: reason.message.slice(0, 500) }); }
    }, shutdown);
    await window.loadURL(controlsURL);
    state.opened = true; window.show(); focusAddress();
    reply({ type: 'ready' });
    return { get window() { return window; }, get page() { return page(); }, snapshot, shutdown };
}
exports.startHost = startHost;
