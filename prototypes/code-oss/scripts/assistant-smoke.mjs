import { expect } from '../../../node_modules/@playwright/test/index.mjs';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { root, upstream } from './environment.mjs';
import { desktopTest } from './desktop-test.mjs';
const require = createRequire(path.join(upstream, 'package.json'));
const test = await desktopTest('assistant-smoke', { discover: true });
let failure;
const report = async () =>
    JSON.parse(await readFile(path.join(test.artifacts, 'assistant-report.json'), 'utf8').catch(() => '{}'));
const stage = async value =>
    expect
        .poll(
            async () => {
                const r = await report();
                if (r.stage === 'failed') throw new Error(r.error);
                return r.stage;
            },
            { timeout: 90000 },
        )
        .toBe(value);
try {
    await require('esbuild').build({
        entryPoints: [path.join(root, 'fixtures/assistant-entry.cjs')],
        outfile: path.join(test.artifacts, 'assistant-entry.cjs'),
        bundle: true,
        platform: 'node',
        format: 'cjs',
        external: ['electron'],
    });
    await writeFile(path.join(test.workspace, 'sample.txt'), 'Disk original.\n');
    const workspace = path.join(test.artifacts, 'assistant.code-workspace');
    await writeFile(
        workspace,
        JSON.stringify({
            folders: [{ path: 'workspace' }],
            settings: { 'files.autoSave': 'off', 'git.openRepositoryInParentFolders': 'never' },
        }),
    );
    process.env.AI_GUI_ASSISTANT_TEST = test.artifacts;
    await test.launch(workspace, [
        '--extensionTestsPath',
        path.join(root, 'fixtures/assistant-tests.cjs'),
        '--disable-workspace-trust',
    ]);
    await stage('connections-ready');
    const panel = await test.webview('conversation');
    await panel.getByLabel('Conversation draft').fill('/connections');
    await panel.getByLabel('Conversation draft').press('Enter');
    const home = await test.webview('home');
    await home.getByRole('tab', { name: 'API keys', exact: true }).click();
    await home.getByLabel('API key', { exact: true }).fill('test-only-key');
    await home.getByRole('button', { name: 'Connect API Key', exact: true }).click();
    await panel.getByRole('button', { name: 'Active model' }).click();
    await panel.getByRole('option', { name: /^openai: gpt-fixture/ }).click();
    await expect(panel.getByRole('button', { name: 'Active model' })).toContainText('openai: gpt-fixture');
    await stage('send-ready');
    await test.page.screenshot({ path: path.join(test.artifacts, 'connections.png') });
    await home.getByRole('button', { name: 'Done', exact: true }).click();
    await panel.getByLabel('Conversation draft').fill('Please change the current file.');
    await panel.getByRole('button', { name: 'Send', exact: true }).click();
    await stage('edit-approval');
    await test.page.screenshot({ path: path.join(test.artifacts, 'approval.png') });
    await panel.locator('#approval-bar').getByRole('button', { name: 'Approve', exact: true }).click(); // The bar above the message box.
    await stage('create-approval');
    await panel.getByRole('button', { name: 'Always allow edits in this chat', exact: true }).click();
    await stage('command-approval');
    await panel.locator('.step.waiting').getByRole('button', { name: 'Approve', exact: true }).click(); // The step's own approval card.
    await stage('complete');
    const first = await report();
    // Nothing in the message list may be wider than the panel.
    const wide = await panel.evaluate(() => {
        const scroller = document.getElementById('scroller'),
            limit =
                scroller.getBoundingClientRect().left +
                scroller.clientWidth -
                parseFloat(getComputedStyle(scroller).paddingRight) +
                0.5;
        const wide = [...scroller.querySelectorAll('*')]
            .filter(node => node.getBoundingClientRect().right > limit)
            .slice(0, 12)
            .map(
                node =>
                    `${node.tagName}.${node.className} (${Math.round(node.getBoundingClientRect().right - limit)}px): ${node.textContent.slice(0, 60)}`,
            );
        const walker = document.createTreeWalker(scroller, NodeFilter.SHOW_TEXT),
            range = document.createRange();
        for (let node = walker.nextNode(); node && wide.length < 12; node = walker.nextNode()) {
            range.selectNodeContents(node);
            const right = range.getBoundingClientRect().right;
            if (right > limit)
                wide.push(
                    `text in ${node.parentElement.tagName}.${node.parentElement.className} (${Math.round(right - limit)}px): ${node.textContent.slice(0, 60)}`,
                );
        }
        return scroller.scrollWidth > scroller.clientWidth
            ? [`scrollWidth ${scroller.scrollWidth} > ${scroller.clientWidth}`, ...wide]
            : wide;
    });
    expect(wide).toEqual([]);
    first.checks.push('message list has no horizontal overflow');
    // GUI: per-file revert removes the created file; Revert All reaches the conflict dialog
    // (extension-test mode refuses modal dialogs, so the refusal names the conflict).
    const changes = panel.locator('.changes').first();
    await changes.getByRole('button', { name: 'Revert notes/created.txt', exact: true }).click();
    await expect(changes.locator('li.reverted')).toHaveCount(1);
    await expect
        .poll(() =>
            readFile(path.join(test.workspace, 'notes/created.txt')).then(
                () => 'present',
                () => 'gone',
            ),
        )
        .toBe('gone');
    await changes.getByRole('button', { name: 'Revert All', exact: true }).click();
    await expect(panel.locator('#status')).toContainText('changed since the agent edited it');
    await expect(panel.getByRole('button', { name: 'Rewind to here' }).first()).toBeAttached();
    first.checks.push(
        'GUI per-file revert deletes the agent-created file; GUI Revert All detects the conflicting file before changing anything',
    );
    await test.page.screenshot({ path: path.join(test.artifacts, 'conversation-wide.png') });
    await test.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1024, 768));
    await expect(panel.getByRole('button', { name: 'Send', exact: true })).toBeVisible();
    await test.page.screenshot({ path: path.join(test.artifacts, 'conversation-compact.png') });
    await test.close();
    await expect
        .poll(() => {
            try {
                process.kill(first.servicePid, 0);
                return false;
            } catch {
                return true;
            }
        })
        .toBe(true);
    first.checks.push('IDE shutdown terminates provider companion');
    process.env.AI_GUI_ASSISTANT_RESTART = '1';
    await writeFile(path.join(test.artifacts, 'assistant-report.json'), '{}');
    await test.launch(workspace, [
        '--extensionTestsPath',
        path.join(root, 'fixtures/assistant-tests.cjs'),
        '--disable-workspace-trust',
    ]);
    await stage('complete');
    const second = await report();
    first.checks.push(...second.checks);
    await writeFile(path.join(test.artifacts, 'result.json'), JSON.stringify(first, null, 2));
    for (const file of await readdir(path.join(test.profile, 'user-data/logs'), { recursive: true })) {
        if (/(?:exthost|renderer)\.log$/.test(file))
            expect(await readFile(path.join(test.profile, 'user-data/logs', file), 'utf8')).not.toMatch(
                /Activating extension .*failed|Cannot find module|ReferenceError|TypeError/,
            );
    }
    expect(test.errors).toEqual([]);
    console.log(
        'PASS: migrated assistant, private provider process, unsaved edit review, context, commands, cancellation and restart.',
    );
} catch (error) {
    failure = error;
    throw error;
} finally {
    delete process.env.AI_GUI_ASSISTANT_TEST;
    delete process.env.AI_GUI_ASSISTANT_RESTART;
    await test.finish(failure);
}
