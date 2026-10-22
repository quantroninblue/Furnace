import { _electron as electron } from '../../../node_modules/playwright-core/index.mjs';
import { expect } from '../../../node_modules/@playwright/test/index.mjs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { launchOptions } from './launch.mjs';
import { root } from './environment.mjs';
await mkdir(path.join(root, '.cache/browser-smoke'), { recursive: true });
const artifacts = await mkdtemp(path.join(root, '.cache/browser-smoke/run-'));
let app, page, base, failure;
const checks = [],
    errors = [],
    logs = [],
    pending = new Set();
const server = http.createServer((req, res) => {
    if (req.url === '/slow') {
        pending.add(res);
        res.on('close', () => pending.delete(res));
        return;
    }
    if (req.url === '/redirect') {
        res.writeHead(302, { Location: '/two' });
        res.end();
        return;
    }
    if (req.url === '/download') {
        res.writeHead(200, { 'Content-Disposition': 'attachment; filename=test.txt' });
        res.end('fixture');
        return;
    }
    res.setHeader('Content-Type', 'text/html');
    res.end(
        `<!doctype html><title>${req.url === '/two' ? 'Second reference' : 'First reference'}</title><style>body{font:18px system-ui;margin:48px;color:#222}a{display:block;margin:20px 0}</style><h1>${req.url === '/two' ? 'Second reference' : 'First reference'}</h1><p>A controlled reference page for the research browser.</p><a id="two" href="/two">Second reference</a><a id="popup" target="_blank" href="/two">Open second reference in new window</a><a id="download" href="/download">Download fixture</a><a id="external" href="mailto:example@example.test">Unsupported link</a><input placeholder="Page input" value="INPUT_SECRET"><form>FORM_SECRET</form><p hidden>HIDDEN_SECRET</p><p contenteditable>EDITABLE_SECRET</p>`,
    );
});
const state = () => app.evaluate(() => globalThis.researchTestHost?.snapshot());
const ready = async title => {
    await expect
        .poll(async () => {
            const s = await state();
            return s?.loading ? '' : s?.title;
        })
        .toBe(title);
};
const navigate = async url => {
    await page.getByLabel('Website or search query').fill(url);
    await page.getByRole('button', { name: 'Go', exact: true }).click();
};
const screenshot = async name => {
    // Window capture omits the native WebContentsView on this Linux runtime.
    // Capture the isolated display so evidence includes the actual page surface.
    const png = await app.evaluate(async ({ desktopCapturer, screen }) => {
        const { width, height } = screen.getPrimaryDisplay().size;
        const [display] = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height } });
        return display.thumbnail.toPNG().toString('base64');
    });
    await writeFile(path.join(artifacts, name), Buffer.from(png, 'base64'));
};
try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    const options = await launchOptions(path.join(artifacts, 'launcher-profile'));
    for (const key of Object.keys(options.env))
        if (/^(ELECTRON_|VSCODE_|NODE_OPTIONS$|NODE_PATH$)/.test(key)) delete options.env[key];
    options.args = [path.join(root, 'fixtures/browser-entry.cjs'), '--ozone-platform=x11'];
    options.env.AI_GUI_BROWSER_TEST_PROFILE = path.join(artifacts, 'browser-profile');
    await mkdir(options.env.AI_GUI_BROWSER_TEST_PROFILE);
    app = await electron.launch({ ...options, chromiumSandbox: true, timeout: 60000 });
    app.process().stderr.on('data', data => logs.push(data.toString()));
    page = await app.firstWindow();
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.stack));
    await expect.poll(async () => !!(await state())).toBe(true);
    await navigate(`${base}/one`);
    await ready('First reference');
    await expect(page.getByLabel('Back', { exact: true })).toBeDisabled();
    const isolation = await app.evaluate(async () => {
        const wc = globalThis.researchTestHost.page;
        return {
            page: await wc.executeJavaScript(
                '({require:typeof require, process:typeof process, controls:typeof researchControls})',
            ),
            persistent: wc.session.isPersistent(),
            sameSession: wc.session === globalThis.researchTestHost.window.webContents.session,
        };
    });
    expect(isolation).toEqual({
        page: { require: 'undefined', process: 'undefined', controls: 'undefined' },
        persistent: false,
        sameSession: false,
    });
    checks.push(
        'production bundled host loads local page; ephemeral separate session; no Node or controls bridge on page',
    );
    const captured = await app.evaluate(() => globalThis.researchTestCapture('page'));
    expect(captured.capture.text).toContain('A controlled reference page');
    expect(captured.capture.text).not.toMatch(/INPUT_SECRET|FORM_SECRET|HIDDEN_SECRET|EDITABLE_SECRET/);
    await app.evaluate(() =>
        globalThis.researchTestHost.page.executeJavaScript(
            `const range = document.createRange(); range.selectNodeContents(document.querySelector('p')); const selected = window.getSelection(); selected.removeAllRanges(); selected.addRange(range);`,
        ),
    );
    const selection = await app.evaluate(() => globalThis.researchTestCapture('selection'));
    expect(selection.capture.kind).toBe('selection');
    expect(selection.capture.text).toBe('A controlled reference page for the research browser.');
    await app.evaluate(() =>
        globalThis.researchTestHost.page.executeJavaScript(
            `document.querySelector('input').focus(); document.querySelector('input').select();`,
        ),
    );
    expect((await app.evaluate(() => globalThis.researchTestCapture('selection'))).error).toBeTruthy();
    checks.push('explicit bounded page/selection capture excludes forms, hidden and editable content; no page bridge');
    await screenshot('wide.png');
    await app.evaluate(() => globalThis.researchTestHost.window.setSize(640, 480));
    await expect(page.getByLabel('Website or search query')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Close browser', exact: true })).toBeVisible();
    await screenshot('compact.png');
    await app.evaluate(() =>
        globalThis.researchTestHost.page.executeJavaScript("document.querySelector('#two').click()", true),
    );
    await ready('Second reference');
    await page.getByLabel('Back', { exact: true }).click();
    await ready('First reference');
    await page.getByLabel('Forward', { exact: true }).click();
    await ready('Second reference');
    const previous = (await state()).generation;
    await page.getByLabel('Reload', { exact: true }).click();
    await expect.poll(async () => (await state()).generation).toBeGreaterThan(previous);
    await ready('Second reference');
    checks.push('links, back/forward and same-URL reload update navigation generation');
    const beforeHash = (await state()).generation;
    await app.evaluate(() => globalThis.researchTestHost.page.executeJavaScript("location.hash='part'"));
    await expect.poll(async () => (await state()).generation).toBeGreaterThan(beforeHash);
    await navigate(`${base}/redirect`);
    await ready('Second reference');
    await expect.poll(async () => (await state()).url).toBe(`${base}/two`);
    checks.push('in-page navigation and redirects update URL and generation');
    await page.getByLabel('Website or search query').fill('draft address');
    await app.evaluate(() =>
        globalThis.researchTestHost.page.executeJavaScript("document.title='Title changed while typing'"),
    );
    await expect(page.getByLabel('Website or search query')).toHaveValue('draft address');
    await page.getByLabel('Website or search query').press('Escape');
    await expect(page.getByLabel('Website or search query')).toHaveValue(`${base}/two`);
    await app.evaluate(() => {
        const wc = globalThis.researchTestHost.window.webContents;
        wc.sendInputEvent({ type: 'keyDown', keyCode: 'L', modifiers: ['control'] });
        wc.sendInputEvent({ type: 'keyUp', keyCode: 'L', modifiers: ['control'] });
    });
    await expect(page.getByLabel('Website or search query')).toBeFocused();
    checks.push('address draft survives state updates; Escape restores URL; Ctrl+L focuses address');
    await navigate('file:///etc/passwd');
    await expect(page.getByRole('status')).toContainText('HTTP');
    await expect.poll(async () => (await state()).url).toBe(`${base}/two`);
    await navigate(`${base}/slow`);
    await expect(page.getByLabel('Stop', { exact: true })).toBeEnabled();
    await page.getByLabel('Stop', { exact: true }).click();
    await expect.poll(async () => (await state()).loading).toBe(false);
    await navigate('http://127.0.0.1:1/unreachable');
    await expect(page.getByRole('status')).toContainText('Could not load');
    await navigate(`${base}/one`);
    await ready('First reference');
    checks.push('invalid protocols rejected; slow navigation can stop; failed navigation can recover');
    await app.evaluate(() =>
        globalThis.researchTestHost.page.executeJavaScript("document.querySelector('#popup').click()"),
    );
    await ready('Second reference');
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
    await app.evaluate(() =>
        globalThis.researchTestHost.page.executeJavaScript("document.querySelector('#download').click()"),
    );
    await expect(page.getByRole('status')).toContainText('Downloads are not enabled');
    await app.evaluate(() =>
        globalThis.researchTestHost.page.executeJavaScript("document.querySelector('#external').click()"),
    );
    await expect(page.getByRole('status')).toContainText('Only HTTP');
    checks.push('popups reuse existing page; downloads and external protocols denied');
    await navigate(`${base}/one`);
    await ready('First reference');
    const generation = (await state()).generation;
    await app.evaluate(() => globalThis.researchTestHost.page.forcefullyCrashRenderer());
    await expect(page.getByRole('status')).toContainText('stopped responding');
    expect((await state()).generation).toBeGreaterThan(generation);
    await screenshot('renderer-recovery.png');
    await page.getByLabel('Reload', { exact: true }).click();
    await ready('First reference');
    checks.push('remote renderer crash preserves controls and recovers on reload');
    expect(errors).toEqual([]);
    await screenshot('final.png');
    const exited = new Promise(resolve => app.process().once('exit', resolve));
    await app.evaluate(() => globalThis.researchTestHost.window.close()).catch(() => {});
    await exited;
    app = undefined;
    checks.push('native window close exits companion');
    await writeFile(path.join(artifacts, 'result.json'), JSON.stringify({ checks, isolation }, null, 2));
    console.log('PASS: production research browser navigation, isolation, controls, renderer recovery and close.');
} catch (error) {
    failure = error;
    if (app) {
        await screenshot('failure.png').catch(() => {});
        await writeFile(
            path.join(artifacts, 'state.json'),
            JSON.stringify(
                await app.evaluate(() => ({
                    state: globalThis.researchTestHost.snapshot(),
                    entries: globalThis.researchTestHost.page.navigationHistory.getAllEntries(),
                })),
                null,
                2,
            ),
        ).catch(() => {});
    }
    throw error;
} finally {
    if (app) await app.close().catch(() => {});
    for (const response of pending) response.destroy();
    server.close();
    await writeFile(path.join(artifacts, 'errors.json'), JSON.stringify(errors, null, 2));
    await writeFile(path.join(artifacts, 'desktop.log'), logs.join(''));
    if (failure) await writeFile(path.join(artifacts, 'failure.txt'), failure.stack);
    console.log(`Evidence: ${artifacts}`);
}
