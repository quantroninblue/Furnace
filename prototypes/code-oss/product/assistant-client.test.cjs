const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AssistantClient } = require('./assistant-client.cjs');

// A reply sent after the service's read is already waiting must still arrive. On Windows that needs an overlapped
// pipe: with a plain one the reply stalled until the next request (packaged Furnace's sign-in never started).
test('the service can reply after a delay over its private pipe', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-client-'));
    const entry = path.join(dir, 'service.cjs');
    fs.writeFileSync(entry, `const { Socket } = require('node:net');
const { PrivateRPC } = require(${JSON.stringify(path.join(__dirname, '../../shared/assistant/rpc.cjs'))});
const rpc = new PrivateRPC(new Socket({ fd: 3, readable: true, writable: true }), async name => {
    await new Promise(resolve => setTimeout(resolve, 300));
    return { answered: name };
});
rpc.on('closed', () => process.exit(0));
`);
    const client = new AssistantClient({ executable: process.execPath, entry, directory: path.join(dir, 'data') });
    try {
        assert.deepEqual(await client.status(), { answered: 'status' });
        assert.deepEqual(await client.status(), { answered: 'status' });
    } finally {
        await client.dispose();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
