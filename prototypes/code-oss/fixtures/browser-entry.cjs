// Match Playwright's normal Electron loader when using our pinned executable.
require('../../../node_modules/playwright-core/lib/server/electron/loader.js');
// Playwright-only owner: exercises the exact bundled production host. Its duplex
// pipe endpoint is kept in the test main process; it is never exposed to pages.
const { Duplex } = require('node:stream');
const { startHost } = require('../.cache/product/research/host.cjs');
const replies = new Map();
const pipe = new Duplex({ read() {}, write(chunk, _encoding, callback) {
    for (const line of chunk.toString().trim().split('\n')) { const value = JSON.parse(line); if (value.type === 'result') replies.set(value.id, value); }
    callback();
} });
globalThis.researchTestCapture = async kind => {
    const state = globalThis.researchTestHost.snapshot(), id = require('node:crypto').randomUUID();
    pipe.push(JSON.stringify({ v: 1, type: 'request', id, host: state.host, scope: state.scope, page: state.page, generation: state.generation, action: 'capture', kind }) + '\n');
    const deadline = Date.now() + 5000;
    while (!replies.has(id)) { if (Date.now() > deadline) throw new Error('Capture timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
    const result = replies.get(id); replies.delete(id); return result;
};
void startHost({ pipe, host: 'browser-test', scope: 'session-test', page: 'page-test', profile: process.env.AI_GUI_BROWSER_TEST_PROFILE })
    .then(host => { globalThis.researchTestHost = host; })
    .catch(error => { console.error(error); require('electron').app.exit(1); });
