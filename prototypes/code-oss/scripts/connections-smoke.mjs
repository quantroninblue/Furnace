// Checks the packaged app's connection service on a real macOS, Windows or Linux runner
// (.github/workflows/release.yml), started exactly as the Furnace extension starts it: the app
// binary running the built-in assistant/entry.cjs, talking over a private inherited pipe.
//   node scripts/connections-smoke.mjs <app binary> <furnace-workspace extension dir> [--sign-in]
// Passes when the service answers a status request. With --sign-in it also starts a ChatGPT sign-in
// and requires it to get as far as waiting for the browser (sign-in configuration fetched, local
// callback listening, the browser asked to open the sign-in page), then cancels it.
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { AssistantClient } = require('../product/assistant-client.cjs');
const [executable, extension, ...flags] = process.argv.slice(2);
if (!executable || !extension)
    throw new Error('Usage: node scripts/connections-smoke.mjs <app binary> <extension dir> [--sign-in]');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const directory = await mkdtemp(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'furnace-connections-'));
const client = new AssistantClient({ executable, entry: path.join(extension, 'assistant/entry.cjs'), directory });
try {
    const status = await client.status();
    console.log(
        `Connection service answered: secure storage ${JSON.stringify(status.secureStorage)}, ChatGPT ${JSON.stringify({ accounts: status.chatgpt?.accounts?.length ?? 0, pending: status.chatgpt?.pending })}`,
    );
    if (flags.includes('--sign-in')) {
        const flow = client.connection({ action: 'signIn', remember: false }).then(
            () => 'finished',
            error => error.message,
        );
        const early = await Promise.race([flow, sleep(20000).then(() => null)]);
        if (early) throw new Error(`ChatGPT sign-in stopped before waiting for the browser: ${early}`);
        const waiting = await client.status();
        if (!waiting.chatgpt?.pending) throw new Error('ChatGPT sign-in is not waiting for the browser.');
        await client.connection({ action: 'cancel' });
        console.log(`ChatGPT sign-in reached the browser step, then: ${await flow}`);
    }
    console.log('Connections PASS');
} finally {
    await client.dispose();
    await rm(directory, { recursive: true, force: true });
}
