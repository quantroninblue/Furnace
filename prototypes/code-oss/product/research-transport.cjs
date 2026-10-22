'use strict';
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const contract = require('../../shared/research-contract.cjs');

// Dedicated inherited duplex pipe (fd 3), never a TCP listener or page bridge.
function frames(stream, receive, invalid) {
    let buffer = Buffer.alloc(0);
    stream.on('data', chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        let end;
        while ((end = buffer.indexOf(10)) >= 0) {
            if (end > contract.limits.wire) { invalid(); return; }
            const line = buffer.subarray(0, end); buffer = buffer.subarray(end + 1);
            try { receive(JSON.parse(line.toString('utf8'))); } catch { invalid(); return; }
        }
        if (buffer.length > contract.limits.wire) invalid();
    });
}
function send(stream, value) { stream.write(`${JSON.stringify(value)}\n`); }
class ResearchTransport extends EventEmitter {
    constructor({ executable, entry, scope, env = process.env, timeout = 5000 }) {
        super();
        this.host = randomUUID(); this.scope = scope; this.page = randomUUID();
        this.pending = new Map(); this.timeout = timeout;
        this.profile = mkdtempSync(path.join(tmpdir(), 'ai-gui-research-'));
        this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
        this.ready.catch(() => {});
        const childEnv = { ...env };
        for (const key of Object.keys(childEnv)) {
            if (/^(ELECTRON_|VSCODE_|NODE_OPTIONS$|NODE_PATH$)/.test(key)) delete childEnv[key];
        }
        this.child = spawn(executable, [entry, '--research-host', this.host, this.scope, this.page, this.profile], {
            // 'overlapped' (same as 'pipe' off Windows): a non-overlapped Windows pipe blocks the host's
            // writes while its read waits, so replies would stall until the next request.
            env: childEnv, stdio: ['ignore', 'ignore', 'ignore', 'overlapped'], detached: process.platform === 'linux',
        });
        this.pipe = this.child.stdio[3];
        this.exited = new Promise(resolve => { this.resolveExit = resolve; });
        this.child.once('error', () => this.fail('Research host could not start'));
        // Chromium descendants can briefly retain inherited descriptors. Reject
        // on main-process exit, without waiting for every pipe to reach EOF.
        // Lifecycle timestamps help diagnose a companion that does not go away.
        this.lifecycle = { spawned: Date.now() };
        this.child.once('exit', (code, signal) => { this.lifecycle.exit = { at: Date.now(), code, signal }; this.fail('Research host exited'); });
        this.child.once('close', () => {
            this.lifecycle.close = Date.now(); this.fail('Research host exited'); clearTimeout(this.killTimer);
            rmSync(this.profile, { recursive: true, force: true }); this.resolveExit();
        });
        this.pipe.on('error', () => this.fail('Research transport closed'));
        this.pipe.on('end', () => this.fail('Research transport closed'));
        frames(this.pipe, value => this.receive(value), () => this.fail('Invalid research response'));
        this.readyTimer = setTimeout(() => this.fail('Research host startup timed out'), timeout);
    }
    receive(value) {
        contract.response(value);
        const next = value.state;
        if (next.host !== this.host || next.scope !== this.scope || next.page !== this.page
            || (this.state && next.generation < this.state.generation)) throw new Error('Research identity mismatch');
        if (value.type === 'ready') {
            if (this.state) throw new Error('Duplicate ready');
            clearTimeout(this.readyTimer); this.state = next; this.resolveReady(next); return;
        }
        if (!this.state) throw new Error('Research host is not ready');
        this.state = next;
        if (value.type === 'result') {
            const pending = this.pending.get(value.id);
            if (!pending) throw new Error('Unknown research request');
            this.pending.delete(value.id); clearTimeout(pending.timer);
            if (value.capture && (pending.request.action !== 'capture' || value.capture.kind !== pending.request.kind
                || !contract.samePage(value.capture, pending.request) || next.loading || !next.opened)) {
                pending.reject(new Error('Research capture expired'));
            } else if (pending.request.action === 'capture' && !value.error && !value.capture) {
                pending.reject(new Error('Missing research capture'));
            } else if (value.error) pending.reject(new Error(value.error));
            else pending.resolve(value);
        }
        this.emit('state', next);
    }
    async request(action, details = {}) {
        await this.ready;
        if (this.closed) throw new Error('Research host is closed');
        if (this.pending.size >= contract.limits.pending) throw new Error('Too many research requests');
        const value = contract.request({ ...details, v: 1, type: 'request', id: randomUUID(), host: this.host,
            scope: this.scope, page: this.page, generation: this.state.generation, action });
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => this.fail('Research request timed out'), this.timeout);
            this.pending.set(value.id, { request: value, resolve, reject, timer });
            send(this.pipe, value);
        });
    }
    fail(message) {
        if (this.closed) return;
        this.closed = true; clearTimeout(this.readyTimer);
        const error = new Error(message); this.rejectReady(error);
        for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
        this.pending.clear(); this.pipe.destroy();
        const kill = signal => {
            try {
                if (process.platform === 'linux' && this.child.pid) process.kill(-this.child.pid, signal);
                else this.child.kill(signal);
            } catch { /* Already exited. */ }
        };
        this.lifecycle.failed = { at: Date.now(), message };
        kill('SIGTERM'); this.killTimer = setTimeout(() => { this.lifecycle.forced = Date.now(); kill('SIGKILL'); }, 1000);
        this.killTimer.unref();
        this.emit('closed', message);
    }
    dispose() { this.fail('Research scope closed'); return this.exited; }
}
module.exports = { ResearchTransport, frames, send };
