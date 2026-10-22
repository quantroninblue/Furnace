import { expect } from '../../../node_modules/@playwright/test/index.mjs';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { desktopTest } from './desktop-test.mjs';
import { root } from './environment.mjs';
const test = await desktopTest('browser-integration-smoke');
let failure;
const report = async () =>
    JSON.parse(await readFile(path.join(test.artifacts, 'browser-report.json'), 'utf8').catch(() => '{}'));
const stage = async expected =>
    expect
        .poll(
            async () => {
                const result = await report();
                if (result.stage === 'failed') throw new Error(result.error);
                return result.stage;
            },
            { timeout: 60000 },
        )
        .toBe(expected);
try {
    const folder = path.join(test.artifacts, 'second-folder');
    await mkdir(folder);
    const workspace = path.join(test.artifacts, 'browser.code-workspace');
    await writeFile(workspace, JSON.stringify({ folders: [{ path: 'workspace' }, { path: 'second-folder' }] }));
    process.env.AI_GUI_BROWSER_INTEGRATION_TEST = test.artifacts;
    await test.launch(workspace, [
        '--extensionTestsPath',
        path.join(root, 'fixtures/browser-integration-tests.cjs'),
        '--disable-workspace-trust',
    ]);
    await stage('form-ready');
    const home = await test.webview('home');
    await home.getByLabel('Website or search query').fill((await report()).url);
    await home.getByRole('button', { name: 'Open Research Browser', exact: true }).click();
    await stage('browser-ready');
    await expect(home.locator('#research-state')).toHaveText('Integrated research reference');
    await home.getByRole('button', { name: 'Capture Page', exact: true }).click();
    await expect(home.locator('#sources article')).toHaveCount(1);
    await home.getByRole('button', { name: 'Capture Selection', exact: true }).click();
    await stage('captured');
    await home.getByLabel('Share with next reply').first().check();
    await stage('shared');
    await test.page.screenshot({ path: path.join(test.artifacts, 'research-open.png') });
    await test.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1024, 768));
    await expect(home.getByRole('button', { name: 'Close Browser', exact: true })).toBeVisible();
    await test.page.screenshot({ path: path.join(test.artifacts, 'compact.png') });
    await home.getByRole('button', { name: 'Close Browser', exact: true }).click();
    await stage('complete');
    const result = await report();
    await test.close();
    await expect
        .poll(() => {
            try {
                process.kill(result.pid, 0);
                return false;
            } catch {
                return true;
            }
        })
        .toBe(true);
    await expect
        .poll(async () => {
            try {
                await readdir(result.profile);
                return false;
            } catch {
                return true;
            }
        })
        .toBe(true);
    result.checks.push('real IDE shutdown closes active companion and removes profile');
    const logs = path.join(test.profile, 'user-data/logs');
    for (const file of await readdir(logs, { recursive: true })) {
        if (!/(?:exthost|renderer)\.log$/.test(file)) continue;
        expect(await readFile(path.join(logs, file), 'utf8'), file).not.toMatch(
            /Activating extension .*failed|Cannot find module|ReferenceError|TypeError/,
        );
    }
    expect(test.errors).toEqual([]);
    await writeFile(path.join(test.artifacts, 'result.json'), JSON.stringify(result, null, 2));
    console.log('PASS: research GUI, real companion, workspace scope, crash/reopen and IDE shutdown.');
} catch (error) {
    failure = error;
    throw error;
} finally {
    delete process.env.AI_GUI_BROWSER_INTEGRATION_TEST;
    await test.finish(failure);
}
