// P1.1 feasibility probe only. Full browsing/capture UI belongs to P1.2/P1.3.
const { app, BrowserWindow, session } = require('electron');
const { Socket } = require('node:net');
const assert = require('node:assert/strict');
const { rmSync } = require('node:fs');
const contract = require('../../shared/research-contract.cjs');
const { frames, send } = require('../product/research-transport.cjs');
const offset = process.argv.indexOf('--research-host');
const [host, scope, page, profile] = process.argv.slice(offset + 1);
if (offset < 0 || !profile) process.exit(1);
app.setPath('userData', profile);
app.setPath('sessionData', profile);
app.enableSandbox();
app.commandLine.appendSwitch('ozone-platform', 'x11');
const pipe = new Socket({ fd: 3, readable: true, writable: true });
// Same shutdown as the production host: end the companion's own process group.
const { exitNow } = require('../product/research/host.cjs');
const quit = () => exitNow(profile);
pipe.on('end', quit); pipe.on('error', quit);
app.on('quit', () => rmSync(profile, { recursive: true, force: true }));
let window;
let state = { host, scope, page, generation: 0, url: '', title: '', loading: false, back: false, forward: false, opened: false, error: '' };
const reply = value => send(pipe, contract.response({ v: 1, state: { ...state }, ...value }));
const mode = process.env.AI_GUI_RESEARCH_PROBE_MODE;
app.whenReady().then(() => {
    const isolated = session.fromPartition(`research-${host}`, { cache: false });
    assert.equal(isolated.isPersistent(), false);
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    isolated.setPermissionCheckHandler(() => false);
    isolated.on('will-download', event => event.preventDefault());
    isolated.webRequest.onBeforeRequest((details, callback) => {
        let allowed = false;
        try { contract.httpURL(details.url); allowed = true; } catch { /* Deny. */ }
        callback({ cancel: !allowed });
    });
    frames(pipe, value => {
        contract.request(value);
        if (!contract.samePage(value, state)) {
            reply({ type: 'result', id: value.id, error: 'Research request expired' }); return;
        }
        if (mode === 'timeout') return;
        if (mode === 'crash') { process.kill(process.pid, 'SIGKILL'); return; }
        if (value.action === 'open') {
            if (window) throw new Error('Probe supports one open');
            state.generation++; state.opened = true; state.loading = true; state.url = value.url;
            reply({ type: 'state' });
            window = new BrowserWindow({ width: 720, height: 480, show: false,
                webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false } });
            window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
            for (const name of ['will-navigate', 'will-redirect']) window.webContents.on(name, (event, url) => {
                try { contract.httpURL(url); } catch { event.preventDefault(); }
            });
            window.on('closed', quit);
            // Only this controlled probe uses a fixed diagnostic expression. There
            // is no JavaScript/CDP command in the transport or API exposed to pages.
            void window.loadURL(value.url).then(async () => {
                const result = await window.webContents.executeJavaScript(`({ node: typeof process, require: typeof require, bridge: typeof research, isolated: !!globalThis.crossOriginIsolated })`);
                assert.equal(result.node, 'undefined'); assert.equal(result.require, 'undefined'); assert.equal(result.bridge, 'undefined');
                assert.equal(window.webContents.getProcessId() === process.pid, false);
                state.loading = false; state.title = window.webContents.getTitle().slice(0, 300);
                reply({ type: 'result', id: value.id });
            }).catch(() => { reply({ type: 'result', id: value.id, error: 'Probe page failed' }); });
        } else if (value.action === 'close') {
            state.opened = false; reply({ type: 'result', id: value.id }); pipe.end(); quit();
        } else reply({ type: 'result', id: value.id, error: 'Not implemented in transport probe' });
    }, () => app.exit(2));
    reply({ type: 'ready' });
}).catch(() => app.exit(3));
