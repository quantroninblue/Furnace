const { test } = require('node:test');
const assert = require('node:assert/strict');
const c = require('./research-contract.cjs');
const identity = { host: 'host-1', scope: 'session-1', page: 'page-1', generation: 2 };
const state = { ...identity, url: 'https://example.test/', title: 'Source', loading: false, back: false, forward: false, opened: true, error: '' };
const request = { ...identity, v: 1, type: 'request', id: 'request-1', action: 'capture', kind: 'selection' };
const capture = { ...identity, id: request.id, kind: 'selection', url: state.url, title: 'Source', text: 'Selected text', links: [], images: [], truncated: false };

test('only bounded HTTP(S) without credentials is accepted', () => {
    assert.equal(c.httpURL('https://example.test'), 'https://example.test/');
    assert.equal(c.httpURL('http://127.0.0.1:1234/a'), 'http://127.0.0.1:1234/a');
    for (const value of ['file:///tmp/test', 'javascript:alert(1)', 'data:text/html,hi', 'https://user:secret@example.test', 'https://example.test/\n', 'https://example.test/' + 'x'.repeat(8192), null]) {
        assert.throws(() => c.httpURL(value));
    }
});

test('wire commands are exact, typed and bounded; arbitrary execution is absent', () => {
    for (const action of ['open', 'navigate', 'back', 'forward', 'reload', 'stop', 'capture', 'close']) {
        const value = { ...identity, v: 1, type: 'request', id: 'req', action };
        if (['open', 'navigate'].includes(action)) value.url = state.url;
        if (action === 'capture') value.kind = 'page';
        assert.equal(c.request(value), value);
    }
    for (const change of [{ action: 'executeJavaScript' }, { script: 'hello' }, { scope: '../escape' }, { generation: -1 }, { generation: 1.1 }, { id: '' }, { kind: 'passwords' }, { url: state.url }, { v: 2 }, { action: 'share' }]) {
        assert.throws(() => c.request({ ...request, ...change }));
    }
    assert.throws(() => c.response({ v: 1, type: 'state', state: { ...state, title: 'x'.repeat(301) } }));
    assert.throws(() => c.response({ v: 1, type: 'result', id: 'wrong', state, capture }));
    const huge = { ...capture, links: Array.from({ length: 20 }, () => ({ url: 'https://example.test/' + 'a'.repeat(8000), label: '' })) };
    assert.throws(() => c.capture(huge), /Invalid/);
});

test('capture limits include Unicode bytes, references, title and text', () => {
    c.capture({ ...capture, text: 'x'.repeat(16000) });
    for (const change of [{ text: 'x'.repeat(16001) }, { kind: 'page', text: 'x'.repeat(8001) },
        { title: 'x'.repeat(301) }, { links: [{ url: 'file:///secret', label: '' }] },
        { links: Array(21).fill({ url: state.url, label: '' }) }, { images: Array(13).fill({ url: state.url, label: '' }) },
        { images: [{ url: state.url, label: 'x'.repeat(201) }] }]) assert.throws(() => c.capture({ ...capture, ...change }));
});

test('stale captures reject reload, away-and-back, host/page/session changes and wrong requests', () => {
    for (const change of [{ generation: 3 }, { host: 'new-host' }, { page: 'new-page' }, { scope: 'new-session' },
        { loading: true }, { opened: false }, { url: 'https://example.test/other' }]) {
        assert.throws(() => new c.ResearchSources(identity.scope).save(capture, request, { ...state, ...change }), /expired/);
    }
    for (const change of [{ id: 'other' }, { kind: 'page' }, { generation: 1 }]) {
        assert.throws(() => new c.ResearchSources(identity.scope).save(capture, { ...request, ...change }, state), /expired/);
    }
});

test('capturing never shares, explicit sharing is bounded and scope reset removes context', () => {
    const sources = new c.ResearchSources(identity.scope);
    for (let i = 0; i < 6; i++) sources.save({ ...capture, id: `req-${i}` }, { ...request, id: `req-${i}` }, state);
    assert.deepEqual(sources.context(), []);
    assert.throws(() => sources.save(capture, request, state), /Remove/);
    for (let i = 0; i < 3; i++) sources.share(`req-${i}`, true);
    assert.throws(() => sources.share('req-3', true), /three/);
    sources.share('req-0', false); sources.share('req-3', true);
    const snapshot = sources.context(); snapshot[0].text = 'tampered';
    assert.equal(sources.context()[0].text, capture.text);
    sources.remove('req-1'); assert.equal(sources.context().length, 2);
    sources.reset('next-session'); assert.deepEqual(sources.context(), []);
    assert.throws(() => sources.share('req-2', true));
});
