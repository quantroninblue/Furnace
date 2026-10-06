import { _electron as electron } from '../../../node_modules/playwright-core/index.mjs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { launchOptions } from './launch.mjs';
import { root } from './environment.mjs';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

await mkdir(path.join(root, '.cache/launch-smoke'), { recursive: true });
const run = await mkdtemp(path.join(root, '.cache/launch-smoke/run-'));
const options = await launchOptions(path.join(run, 'profile'));
options.args.push('--ozone-platform=x11');
const diagnostics = [];
let app;
try {
    const started = Date.now();
    app = await electron.launch({ ...options, timeout: 60000, chromiumSandbox: true });
    app.process().stderr.on('data', data => diagnostics.push(data.toString()));
    const page = await app.firstWindow({ timeout: 60000 });
    page.on('pageerror', error => diagnostics.push(`Renderer: ${error.stack}`));
    await page.locator('.monaco-workbench').waitFor({ timeout: 60000 });
    await page.keyboard.press('Control+Shift+e');
    await page.getByText('No Folder Opened', { exact: true }).first().waitFor({ timeout: 30000 });
    const readyMs = Date.now() - started;
    // Startup extensions activate after the workbench is already visible.
    await delay(12000);
    const body = await page.locator('body').innerText();
    assert.doesNotMatch(body, /Activating extension .* failed|Cannot find module/);
    assert.equal(diagnostics.filter(line => line.startsWith('Renderer:')).length, 0);
    await page.screenshot({ path: path.join(run, 'project-free.png') });
    await writeFile(path.join(run, 'result.json'), JSON.stringify({ readyMs, startupObservationMs: 12000, title: await page.title() }, null, 2));
    console.log(`PASS: Code OSS project-free launch. Evidence: ${run}`);
} finally {
    if (app) {
        for (const [index, page] of app.windows().entries()) {
            await page.screenshot({ path: path.join(run, `final-${index}.png`) }).catch(() => {});
            await writeFile(path.join(run, `page-${index}.txt`), await page.locator('body').innerText().catch(() => 'unavailable'));
        }
    }
    await app?.close();
    await writeFile(path.join(run, 'desktop.log'), diagnostics.join(''));
    console.log(`Launch evidence: ${run}`);
}
