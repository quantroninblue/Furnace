const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { EventEmitter } = require('node:events');
const { ResearchTransport, frames } = require('./research-transport.cjs');
const { limits } = require('../../shared/research-contract.cjs');

test('private pipe handles fragmented Unicode and multiple frames without parsing logs', () => {
    const pipe = new PassThrough(), received = [];
    let invalid = 0;
    frames(pipe, value => received.push(value), () => invalid++);
    const bytes = Buffer.from('{"text":"参考"}\n{"text":"next"}\n');
    for (const byte of bytes) pipe.write(Buffer.from([byte]));
    assert.deepEqual(received, [{ text: '参考' }, { text: 'next' }]);
    pipe.write('Electron log output\n'); assert.equal(invalid, 1);
    pipe.destroy();
});

test('oversized frames reject with and without a delimiter, counting bytes', () => {
    for (const suffix of ['', '\n']) {
        const pipe = new PassThrough(); let invalid = 0, received = 0;
        frames(pipe, () => received++, () => invalid++);
        pipe.write('界'.repeat(Math.floor(limits.wire / 3) + 1) + suffix);
        assert.equal(invalid, 1); assert.equal(received, 0); pipe.destroy();
    }
});

function client() {
    const transport = Object.assign(new EventEmitter(), { host: 'host', scope: 'scope', page: 'page', pending: new Map() });
    Object.setPrototypeOf(transport, ResearchTransport.prototype);
    transport.state = { host: 'host', scope: 'scope', page: 'page', generation: 2, url: 'https://example.test/',
        title: '', error: '', opened: true, loading: false, back: false, forward: false };
    return transport;
}

test('responses from another host/scope/page, old generations and unknown requests reject', () => {
    const transport = client();
    for (const change of [{ host: 'other' }, { scope: 'other' }, { page: 'other' }, { generation: 1 }]) {
        assert.throws(() => transport.receive({ v: 1, type: 'state', state: { ...transport.state, ...change } }), /identity/);
    }
    assert.throws(() => transport.receive({ v: 1, type: 'result', id: 'unknown', state: transport.state }), /Unknown/);
    assert.throws(() => transport.receive({ v: 1, type: 'ready', state: transport.state }), /Duplicate/);
});

test('reload invalidates an in-flight capture even when its URL did not change', async () => {
    const transport = client();
    const result = new Promise((resolve, reject) => transport.pending.set('capture-1', {
        resolve, reject, request: { ...transport.state, action: 'capture', kind: 'selection' },
    }));
    const state = { ...transport.state, generation: 3 };
    transport.receive({ v: 1, type: 'result', id: 'capture-1', state, capture: {
        host: state.host, scope: state.scope, page: state.page, generation: 3, id: 'capture-1', kind: 'selection',
        url: state.url, title: '', text: 'Delayed selection', links: [], images: [], truncated: false,
    } });
    await assert.rejects(result, /expired/);
    assert.equal(transport.pending.size, 0);
});
