'use strict';
const { app, safeStorage, shell } = require('electron');
const { Socket } = require('node:net');
const path = require('node:path');
const { PrivateRPC } = require('../../../shared/assistant/rpc.cjs');
const { ProviderService } = require('../../../shared/assistant/provider-service.cjs');

exports.startAssistantService = (options = {}) => {
const directory = options.directory || process.argv[process.argv.indexOf('--assistant-service') + 1];
if (!directory || !path.isAbsolute(directory)) app.exit(1);
app.setPath('userData', directory); app.enableSandbox();
let service, active, operation, quitting = false;
const rpc = new PrivateRPC(new Socket({ fd: 3, readable: true, writable: true }), async (name, value) => {
    await ready;
    if (name === 'status') return service.snapshot();
    if (name === 'stop') { active?.abort(); return; }
    if (name === 'connection') return service.change(value.action, value);
    if (name !== 'run' || active) throw new Error('Unsupported or busy assistant operation.');
    const controller = new AbortController(); active = controller;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(2 * 60 * 60 * 1000)]);
    const tools = { definitions: value.definitions, execute: async (name, args) => {
        signal.throwIfAborted();
        if (!value.definitions.some(d => d.function.name === name)) throw new Error('Tool is not permitted in this mode.');
        // Tools may wait on user approval or long commands; Stop/turn timeout still apply.
        return rpc.request('tool', { turn: value.request.id, name, args }, 2 * 60 * 60 * 1000);
    } };
    operation = service.run(value.request, tools, signal);
    try { await operation; } finally { if (active === controller) active = undefined; }
});
async function shutdown() {
    if (quitting) return; quitting = true; active?.abort(); service?.dispose();
    const timer = setTimeout(() => app.exit(0), 1500);
    try { await operation; } catch { /* Cancellation is expected. */ }
    clearTimeout(timer); rpc.close(); app.exit(0);
}
rpc.on('closed', shutdown); process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
const ready = (async () => {
    await app.whenReady();
    if (!app.requestSingleInstanceLock()) throw new Error('Connections are open in another IDE window. Close that window before connecting here.');
    const cipher = { available: () => safeStorage.isEncryptionAvailable() && (process.platform !== 'linux' || !['basic_text', 'unknown'].includes(safeStorage.getSelectedStorageBackend())), encrypt: value => safeStorage.encryptString(value), decrypt: value => safeStorage.decryptString(value) };
    service = new ProviderService({ dependencies: options.dependencies, directory, cipher, openBrowser: url => shell.openExternal(url), emit: event => rpc.event('chat', event) });
    await service.init();
})();
ready.catch(() => {});

};
