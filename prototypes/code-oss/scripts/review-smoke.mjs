import { expect } from '../../../node_modules/@playwright/test/index.mjs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { desktopTest } from './desktop-test.mjs';
import { root } from './environment.mjs';

const test = await desktopTest('review-smoke');
let failure;
const report = async () => JSON.parse(await readFile(path.join(test.artifacts, 'review-report.json'), 'utf8').catch(() => '{}'));
const stage = async expected => expect.poll(async () => {
    const result = await report();
    if (result.stage === 'failed') throw new Error(result.error);
    return result.stage;
}, { timeout: 60000 }).toBe(expected);
const checkActivationLogs = async () => {
    const logs = path.join(test.profile, 'user-data/logs');
    for (const file of await readdir(logs, { recursive: true })) {
        if (!/(?:exthost|renderer)\.log$/.test(file)) continue;
        const content = await readFile(path.join(logs, file), 'utf8');
        expect(content, file).not.toMatch(/Activating extension .*failed|Cannot find module|ReferenceError|TypeError/);
    }
};
try {
    await writeFile(path.join(test.workspace, 'sample.txt'), 'Original disk text.\n');
    await mkdir(path.join(test.artifacts, 'extra-folder'));
    const workspaceFile = path.join(test.artifacts, 'review.code-workspace');
    await writeFile(workspaceFile, JSON.stringify({ folders: [{ path: 'workspace' }, { path: 'extra-folder' }],
        settings: { 'files.autoSave': 'off', 'git.openRepositoryInParentFolders': 'never' } }));
    process.env.AI_GUI_REVIEW_TEST = test.artifacts;
    await test.launch(workspaceFile, ['--extensionTestsPath', path.join(root, 'fixtures/review-tests.cjs'), '--disable-workspace-trust']);
    await stage('review-ready');
    const proposed = test.page.locator('.monaco-diff-editor .editor.modified .monaco-editor');
    await proposed.waitFor();
    await proposed.click();
    await test.page.keyboard.press('Control+a');
    await test.page.keyboard.insertText('Human reviewed replacement.\n');
    await test.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1680, 1000));
    await expect(test.page.locator('.monaco-diff-editor .editor.original .view-lines')).toBeVisible();
    await expect(test.page.locator('.monaco-diff-editor .editor.original .view-lines')).toContainText('Unsaved user draft.');
    await test.page.screenshot({ path: path.join(test.artifacts, 'editable-review.png') });
    const conversation = await test.webview('conversation');
    await test.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1024, 768));
    await expect(conversation.getByRole('button', { name: 'Apply Reviewed Changes', exact: true })).toBeVisible();
    await test.page.screenshot({ path: path.join(test.artifacts, 'compact-review.png') });
    await conversation.getByRole('button', { name: 'Apply Reviewed Changes', exact: true }).click();
    await stage('complete');
    await test.page.screenshot({ path: path.join(test.artifacts, 'pending-before-restart.png') });
    await test.close();
    await checkActivationLogs();
    delete process.env.AI_GUI_REVIEW_TEST;
    await test.launch(workspaceFile, ['--disable-workspace-trust']);
    await test.webview('conversation');
    await test.command('AI GUI: Apply Reviewed Changes');
    await expect((await test.webview('conversation')).locator('#status')).toHaveText('No pending proposal.');
    await checkActivationLogs();
    const result = await report();
    result.checks.push('real process restart expires approval');
    await writeFile(path.join(test.artifacts, 'result.json'), JSON.stringify(result, null, 2));
    expect(test.errors).toEqual([]);
    console.log('PASS: reviewed unsaved documents, stale changes, apply, undo and restart expiry.');
} catch (error) { failure = error; throw error; }
finally { await test.finish(failure); }
