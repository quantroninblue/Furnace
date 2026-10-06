'use strict';
const { spawn } = require('node:child_process');
const { PrivateRPC } = require('../../shared/assistant/rpc.cjs');
class AssistantClient {
    constructor(options) { this.options = options; }
    async start() {
        if (this.rpc && !this.rpc.closed) return;
        const env = { ...process.env };
        for (const key of Object.keys(env)) if (/^(ELECTRON_|VSCODE_|NODE_OPTIONS$|NODE_PATH$)/.test(key)) delete env[key];
        const child = spawn(this.options.executable, [this.options.entry, '--assistant-service', this.options.directory], { env, stdio: ['ignore', 'ignore', 'ignore', 'pipe'], detached: process.platform !== 'win32' });
        this.child = child;
        const rpc = this.rpc = new PrivateRPC(child.stdio[3], (name, value) => {
            if (name !== 'tool' || !this.turn || value.turn !== this.turn.id) throw new Error('Assistant turn expired.');
            this.turn.signal.throwIfAborted(); return this.turn.tools.execute(value.name, value.args);
        });
        rpc.on('chat', value => { if (this.turn?.id === value.id && !this.turn.signal.aborted) this.turn.emit(value); });
        const kill = signal => { try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch { /* Already exited. */ } };
        rpc.on('closed', () => { kill('SIGTERM'); const timer = setTimeout(() => kill('SIGKILL'), 2000); timer.unref(); child.once('close', () => clearTimeout(timer)); });
        this.exited = new Promise(resolve => child.once('close', () => { rpc.close(); resolve(); }));
        child.once('error', () => rpc.close()); child.once('exit', () => rpc.close());
    }
    async connection(value) { await this.start(); return this.rpc.request('connection', value, value.action === 'signIn' ? 330000 : 120000); }
    async status() { await this.start(); return this.rpc.request('status', {}, 15000); }
    async run(request, tools, signal, emit) {
        await this.start(); signal.throwIfAborted();
        if (this.turn) throw new Error('A reply is already running.');
        this.turn = { id: request.id, tools, signal, emit };
        const abort = () => { void this.rpc.request('stop', {}, 5000).catch(() => {}); };
        signal.addEventListener('abort', abort, { once: true });
        try { await this.rpc.request('run', { request, definitions: tools.definitions }); }
        finally { signal.removeEventListener('abort', abort); this.turn = undefined; }
    }
    async dispose() { this.rpc?.close(); await this.exited; }
}
module.exports = { AssistantClient };
