import { _electron as electron } from '../../../node_modules/playwright-core/index.mjs';
import { expect } from '../../../node_modules/@playwright/test/index.mjs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { root } from './environment.mjs';
import { launchOptions } from './launch.mjs';

export async function desktopTest(name) {
    await mkdir(path.join(root, '.cache', name), { recursive: true });
    const artifacts = await mkdtemp(path.join(root, '.cache', name, 'run-'));
    const profile = path.join(artifacts, 'profile');
    const workspace = path.join(artifacts, 'workspace');
    await mkdir(workspace);
    const logs = [];
    const errors = [];
    const test = {
        artifacts, profile, workspace, errors,
        async launch(folder, extraArgs = []) {
            const options = await launchOptions(profile);
            options.args.push('--ozone-platform=x11', ...extraArgs);
            if (folder) options.args.push(folder);
            const start = Date.now();
            test.app = await electron.launch({ ...options, timeout: 60000, chromiumSandbox: true });
            test.app.process().stderr.on('data', data => logs.push(data.toString()));
            test.app.process().stdout.on('data', data => logs.push(data.toString()));
            test.page = await test.app.firstWindow({ timeout: 60000 });
            test.page.on('pageerror', error => errors.push(error.stack));
            await test.page.locator('.monaco-workbench').waitFor({ timeout: 60000 });
            await test.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 800));
            return Date.now() - start;
        },
        async webview(surface) {
            let result;
            await expect.poll(async () => {
                for (const frame of test.page.frames()) {
                    if (await frame.locator(`body[data-surface="${surface}"]`).count().catch(() => 0)) { result = frame; return true; }
                }
                return false;
            }, { timeout: 30000 }).toBe(true);
            return result;
        },
        async command(title) {
            await test.page.keyboard.press('Escape');
            await test.page.keyboard.press('Control+Shift+p');
            const input = test.page.locator('.quick-input-widget input').first();
            await input.fill(`>${title}`);
            await test.page.locator('.quick-input-list .monaco-list-row').filter({ hasText: title }).first().waitFor();
            await test.page.keyboard.press('Enter');
            await input.waitFor({ state: 'hidden' });
        },
        async close() { if (test.app) { await test.app.close(); test.app = undefined; } },
        async finish(error) {
            if (test.app) {
                await test.page.screenshot({ path: path.join(artifacts, error ? 'failure.png' : 'final.png') }).catch(() => {});
                await writeFile(path.join(artifacts, 'page.txt'), await test.page.locator('body').innerText().catch(() => 'unavailable'));
            }
            await test.close();
            await writeFile(path.join(artifacts, 'desktop.log'), logs.join(''));
            await writeFile(path.join(artifacts, 'errors.json'), JSON.stringify(errors, null, 2));
            console.log(`Evidence: ${artifacts}`);
        },
    };
    return test;
}
