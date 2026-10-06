'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Duplex } = require('node:stream');
const { PrivateRPC } = require('./rpc.cjs');
function pair() {
    let a, b;
    a = new Duplex({ read() {}, write(chunk, _encoding, done) { b.push(chunk); done(); } });
    b = new Duplex({ read() {}, write(chunk, _encoding, done) { a.push(chunk); done(); } });
    return [a, b];
}
test('private assistant RPC correlates bidirectional tools and rejects pending calls on disconnect', async () => {
    const [a, b] = pair();
    const caller = new PrivateRPC(a, async name => { assert.equal(name, 'tool'); return 'unsaved contents'; });
    const host = new PrivateRPC(b, async name => { if (name === 'hang') return new Promise(() => {}); return host.request('tool', {}); });
    assert.equal(await caller.request('run', {}), 'unsaved contents');
    const waiting = caller.request('hang', {}); caller.close(); await assert.rejects(waiting, /disconnected/); host.close();
});
test('oversized and malformed assistant frames fail closed', async () => {
    const [a, b] = pair(), rpc = new PrivateRPC(a);
    await assert.rejects(rpc.request('run', 'x'.repeat(2 * 1024 * 1024)), /2 MB/);
    const closed = new Promise(resolve => rpc.once('closed', resolve)); b.write('{invalid}\n'); await closed; assert.equal(rpc.closed, true); b.destroy();
});
