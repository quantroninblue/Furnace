'use strict';
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const MAX = 2 * 1024 * 1024;
// Private inherited pipe, bounded requests, no network listener or eval operation.
class PrivateRPC extends EventEmitter {
    constructor(pipe, handler = async () => { throw new Error('Unsupported operation'); }) {
        super(); this.pipe = pipe; this.handler = handler; this.pending = new Map(); this.inflight = 0;
        let buffer = Buffer.alloc(0);
        pipe.on('data', chunk => {
            buffer = Buffer.concat([buffer, chunk]);
            let end;
            while ((end = buffer.indexOf(10)) >= 0) {
                if (end > MAX) return this.close();
                const line = buffer.subarray(0, end); buffer = buffer.subarray(end + 1);
                try { this.receive(JSON.parse(line.toString('utf8'))); } catch { return this.close(); }
            }
            if (buffer.length > MAX) this.close();
        });
        pipe.on('error', () => this.close()); pipe.on('end', () => this.close());
    }
    send(value) {
        if (this.closed) throw new Error('Assistant service disconnected. Retry to reconnect.');
        const data = JSON.stringify(value);
        if (Buffer.byteLength(data) > MAX) throw new Error('Assistant request exceeds 2 MB. Reduce shared context.');
        this.pipe.write(data + '\n');
    }
    event(name, value) { this.send({ type: 'event', name, value }); }
    request(name, value, timeout = 200000) {
        if (this.pending.size >= 16) return Promise.reject(new Error('Too many assistant operations.'));
        const id = randomUUID();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Assistant service timed out.')); this.close(); }, timeout);
            this.pending.set(id, { resolve, reject, timer });
            try { this.send({ type: 'request', id, name, value }); }
            catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
        });
    }
    receive(message) {
        if (!message || typeof message !== 'object') throw new Error('Invalid frame');
        if (message.type === 'event' && typeof message.name === 'string') { this.emit(message.name, message.value); return; }
        if (message.type === 'result') {
            const pending = this.pending.get(message.id);
            if (!pending) throw new Error('Unknown reply');
            clearTimeout(pending.timer); this.pending.delete(message.id);
            if (message.error) pending.reject(new Error(String(message.error).slice(0, 1000))); else pending.resolve(message.value);
            return;
        }
        if (message.type !== 'request' || typeof message.id !== 'string' || message.id.length > 80 || typeof message.name !== 'string' || ++this.inflight > 16) throw new Error('Invalid request');
        Promise.resolve().then(() => this.handler(message.name, message.value)).then(
            value => this.send({ type: 'result', id: message.id, value }),
            error => this.send({ type: 'result', id: message.id, error: String(error.message || 'Assistant operation failed').slice(0, 1000) })
        ).catch(() => this.close()).finally(() => this.inflight--);
    }
    close() {
        if (this.closed) return;
        this.closed = true; this.pipe.destroy();
        for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error('Assistant service disconnected. Retry to reconnect.')); }
        this.pending.clear(); this.emit('closed');
    }
}
module.exports = { PrivateRPC };
