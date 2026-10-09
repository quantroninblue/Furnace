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
test('idle requests survive while the peer streams or waits on a tool, and time out when it goes silent', async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const [a, b] = pair();
    const caller = new PrivateRPC(a, async () => { await wait(150); return 'approved'; });
    const host = new PrivateRPC(b, async name => {
        if (name === 'stream') { for (let i = 0; i < 6; i++) { await wait(30); host.event('chat', i); } return 'streamed'; }
        if (name === 'tool') return host.request('tool', {}, 5000);
        return new Promise(() => {});
    });
    // Longer in total than the 60 ms timeout, but never 60 ms without a frame.
    assert.equal(await caller.request('stream', {}, 60, { idle: true }), 'streamed');
    // The caller's own tool handler takes 150 ms; the idle timer waits for it.
    assert.equal(await caller.request('tool', {}, 60, { idle: true }), 'approved');
    await assert.rejects(caller.request('silent', {}, 60, { idle: true }), /timed out/);
    host.close();
});
