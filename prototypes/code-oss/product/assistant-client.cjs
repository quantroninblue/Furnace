'use strict';
const { spawn } = require('node:child_process');
const { PrivateRPC } = require('../../shared/assistant/rpc.cjs');
class AssistantClient {
    constructor(options) {
        this.options = options;
    }
    async start() {
        if (this.rpc && !this.rpc.closed) return;
        const env = { ...process.env };
        for (const key of Object.keys(env))
            if (/^(ELECTRON_|VSCODE_|NODE_OPTIONS$|NODE_PATH$)/.test(key)) delete env[key];
        // 'overlapped', not 'pipe': on Windows a non-overlapped pipe serializes I/O, so the service's waiting read
        // blocks its reply until we send something else (same as 'pipe' elsewhere).
        const child = spawn(
            this.options.executable,
            [this.options.entry, '--assistant-service', this.options.directory],
            { env, stdio: ['ignore', 'ignore', 'ignore', 'overlapped'], detached: process.platform !== 'win32' },
        );
        this.child = child;
        // Several replies can run at once (the chat and background tasks), routed by request ID.
        this.turns ??= new Map();
        const rpc = (this.rpc = new PrivateRPC(child.stdio[3], (name, value) => {
            const turn = this.turns.get(value?.turn);
            if (name !== 'tool' || !turn) throw new Error('Assistant turn expired.');
            turn.signal.throwIfAborted();
            return turn.tools.execute(value.name, value.args);
        }));
        rpc.on('chat', value => {
            const turn = this.turns.get(value?.id);
            if (turn && !turn.signal.aborted) turn.emit(value);
        });
        const kill = signal => {
            try {
                if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
                else child.kill(signal);
            } catch {
                /* Already exited. */
            }
        };
        rpc.on('closed', () => {
            kill('SIGTERM');
            const timer = setTimeout(() => kill('SIGKILL'), 2000);
            timer.unref();
            child.once('close', () => clearTimeout(timer));
        });
        this.exited = new Promise(resolve =>
            child.once('close', () => {
                rpc.close();
                resolve();
            }),
        );
        child.once('error', () => rpc.close());
        child.once('exit', () => rpc.close());
    }
    async connection(value) {
        await this.start();
        return this.rpc.request('connection', value, value.action === 'signIn' ? 330000 : 120000);
    }
    async status() {
        await this.start();
        return this.rpc.request('status', {}, 15000);
    }
    async count(request, definitions) {
        await this.start();
        return this.rpc.request('count', { request, definitions }, 30000);
    }
    async spend() {
        await this.start();
        return this.rpc.request('spend', {}, 60000);
    }
    async run(request, tools, signal, emit) {
        await this.start();
        signal.throwIfAborted();
        if (this.turns.has(request.id)) throw new Error('This reply is already running.');
        this.turns.set(request.id, { tools, signal, emit });
        const abort = () => {
            void this.rpc.request('stop', { id: request.id }, 5000).catch(() => {});
        };
        signal.addEventListener('abort', abort, { once: true });
        // A turn has no fixed length (slow local models reason for many minutes); it fails only
        // after 10 minutes without any sign of life. The service still caps a turn at 2 hours.
        try {
            await this.rpc.request('run', { request, definitions: tools.definitions }, 10 * 60 * 1000, { idle: true });
        } finally {
            signal.removeEventListener('abort', abort);
            this.turns.delete(request.id);
        }
    }
    async dispose() {
        this.rpc?.close();
        await this.exited;
    }
}
module.exports = { AssistantClient };
