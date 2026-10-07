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
// Replies run concurrently (a chat plus background tasks), each stoppable by its request ID.
let service, quitting = false;
const active = new Map(), operations = new Set();
const rpc = new PrivateRPC(new Socket({ fd: 3, readable: true, writable: true }), async (name, value) => {
    await ready;
    if (name === 'status') return service.snapshot();
    if (name === 'stop') { for (const [id, controller] of active) if (!value?.id || value.id === id) controller.abort(); return; }
    if (name === 'connection') return service.change(value.action, value);
    if (name === 'count') return service.count(value.request, value.definitions);
    if (name === 'spend') return service.spend();
    if (name !== 'run' || typeof value?.request?.id !== 'string' || active.has(value.request.id)) throw new Error('Unsupported or busy assistant operation.');
    const controller = new AbortController(); active.set(value.request.id, controller);
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(2 * 60 * 60 * 1000)]);
    const tools = { definitions: value.definitions, execute: async (name, args) => {
        signal.throwIfAborted();
        if (!value.definitions.some(d => d.function.name === name)) throw new Error('Tool is not permitted in this mode.');
        // Tools may wait on user approval or long commands; Stop/turn timeout still apply.
        return rpc.request('tool', { turn: value.request.id, name, args }, 2 * 60 * 60 * 1000);
    } };
    const operation = service.run(value.request, tools, signal);
    operations.add(operation);
    try { await operation; } finally { active.delete(value.request.id); operations.delete(operation); }
});
async function shutdown() {
    if (quitting) return; quitting = true; for (const controller of active.values()) controller.abort(); service?.dispose();
    const timer = setTimeout(() => app.exit(0), 1500);
    await Promise.allSettled([...operations]);
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
