'use strict';

// No Electron, editor or provider dependencies. Remote data is always untrusted.
const limits = Object.freeze({
    wire: 131072,
    url: 8192,
    title: 300,
    selection: 16000,
    page: 8000,
    links: 20,
    images: 12,
    saved: 6,
    shared: 3,
    pending: 16,
});
const fail = () => {
    throw new Error('Invalid research message');
};
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, max) => typeof value === 'string' && value.length <= max;
const id = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
const generation = value => Number.isSafeInteger(value) && value >= 0;
function keys(value, names) {
    if (!object(value) || Object.keys(value).some(key => !names.includes(key))) fail();
}
function bounded(value) {
    if (new TextEncoder().encode(JSON.stringify(value)).length > limits.wire) fail();
    return value;
}
function httpURL(value) {
    if (!text(value, limits.url) || !value || /[\u0000-\u0020\u007f]/.test(value)) fail();
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) fail();
    if (url.href.length > limits.url) fail();
    return url.href;
}
function identity(value) {
    if (!id(value.host) || !id(value.scope) || !id(value.page) || !generation(value.generation)) fail();
}
function request(value) {
    bounded(value);
    keys(value, ['v', 'type', 'id', 'host', 'scope', 'page', 'generation', 'action', 'url', 'kind']);
    identity(value);
    if (
        value.v !== 1 ||
        value.type !== 'request' ||
        !id(value.id) ||
        !['open', 'navigate', 'back', 'forward', 'reload', 'stop', 'capture', 'close'].includes(value.action)
    )
        fail();
    if (['open', 'navigate'].includes(value.action)) httpURL(value.url);
    else if (value.url !== undefined) fail();
    if (value.action === 'capture') {
        if (!['selection', 'page'].includes(value.kind)) fail();
    } else if (value.kind !== undefined) fail();
    return value;
}
function state(value) {
    keys(value, [
        'host',
        'scope',
        'page',
        'generation',
        'url',
        'title',
        'loading',
        'back',
        'forward',
        'opened',
        'error',
    ]);
    identity(value);
    if (value.url !== '') httpURL(value.url);
    if (
        !text(value.title, limits.title) ||
        !text(value.error, 500) ||
        !['loading', 'back', 'forward', 'opened'].every(key => typeof value[key] === 'boolean')
    )
        fail();
    return value;
}
function capture(value) {
    keys(value, [
        'host',
        'scope',
        'page',
        'generation',
        'id',
        'kind',
        'url',
        'title',
        'text',
        'links',
        'images',
        'truncated',
    ]);
    identity(value);
    httpURL(value.url);
    if (
        !id(value.id) ||
        !['selection', 'page'].includes(value.kind) ||
        !text(value.title, limits.title) ||
        !text(value.text, limits[value.kind]) ||
        typeof value.truncated !== 'boolean'
    )
        fail();
    for (const field of ['links', 'images']) {
        if (!Array.isArray(value[field]) || value[field].length > limits[field]) fail();
        for (const item of value[field]) {
            keys(item, ['url', 'label']);
            httpURL(item.url);
            if (!text(item.label, 200)) fail();
        }
    }
    return bounded(value);
}
function response(value) {
    bounded(value);
    keys(value, ['v', 'type', 'id', 'state', 'capture', 'error']);
    if (value.v !== 1 || !['ready', 'state', 'result'].includes(value.type)) fail();
    state(value.state);
    if (value.type === 'result') {
        if (!id(value.id)) fail();
        if (value.error !== undefined && (!text(value.error, 500) || !value.error)) fail();
        if (value.capture !== undefined) {
            capture(value.capture);
            if (value.error || value.capture.id !== value.id || !samePage(value.capture, value.state)) fail();
        }
    } else if (value.id !== undefined || value.capture !== undefined || value.error !== undefined) fail();
    return value;
}
function samePage(a, b) {
    return !!a && !!b && ['host', 'scope', 'page', 'generation'].every(key => a[key] === b[key]);
}

// Captures are saved locally; only an explicit share operation adds model context.
class ResearchSources {
    constructor(scope) {
        if (!id(scope)) fail();
        this.scope = scope;
        this.sources = new Map();
        this.shared = new Set();
    }
    save(value, pending, current) {
        capture(value);
        request(pending);
        state(current);
        if (
            pending.action !== 'capture' ||
            pending.kind !== value.kind ||
            value.id !== pending.id ||
            value.scope !== this.scope ||
            !samePage(value, pending) ||
            !samePage(value, current) ||
            !current.opened ||
            current.loading ||
            value.url !== current.url
        )
            throw new Error('Research capture expired');
        if (this.sources.has(value.id)) throw new Error('Capture already saved');
        if (this.sources.size >= limits.saved) throw new Error('Remove a saved source first');
        this.sources.set(value.id, JSON.parse(JSON.stringify(value)));
    }
    share(sourceId, enabled) {
        if (!this.sources.has(sourceId) || typeof enabled !== 'boolean') fail();
        if (enabled && !this.shared.has(sourceId) && this.shared.size >= limits.shared)
            throw new Error('Share at most three sources');
        if (enabled) this.shared.add(sourceId);
        else this.shared.delete(sourceId);
    }
    remove(sourceId) {
        this.shared.delete(sourceId);
        this.sources.delete(sourceId);
    }
    context() {
        return [...this.shared].map(key => JSON.parse(JSON.stringify(this.sources.get(key))));
    }
    reset(scope) {
        if (!id(scope)) fail();
        this.scope = scope;
        this.sources.clear();
        this.shared.clear();
    }
}
module.exports = { limits, httpURL, request, response, state, capture, samePage, ResearchSources };
