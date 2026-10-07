import { expect } from '../../../node_modules/@playwright/test/index.mjs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { desktopTest } from './desktop-test.mjs';

// An untrusted project folder: the conversation shows Restricted Mode, Trust Folder
// opens VS Code's trust dialog, and trusting it enables the agent's tools.
const test = await desktopTest('trust-smoke');
let failure;
try {
    await writeFile(path.join(test.workspace, 'hello.txt'), 'hello\n');
    await test.launch(test.workspace);
    const checks = [];
    const dialog = test.page.locator('.monaco-dialog-box');
    // VS Code may show its own startup prompt for an untrusted folder; decline it.
    const startup = test.page.getByRole('button', { name: "No, I don't trust the authors" });
    if (await startup.waitFor({ timeout: 8000 }).then(() => true, () => false)) { await startup.click(); checks.push('startup trust prompt shown and declined'); }
    await expect(dialog).toHaveCount(0);
    const conversation = await test.webview('conversation');
    await conversation.getByLabel('Conversation draft').fill('/build');
    await conversation.getByLabel('Conversation draft').press('Enter');
    await expect(conversation.locator('#mode-label')).toHaveText('Build');
    await expect(conversation.getByText('Restricted Mode', { exact: true })).toBeVisible();
    await conversation.getByRole('button', { name: 'Trust Folder', exact: true }).click();
    await expect(dialog).toContainText('so the AI GUI agent can read, edit and create files and run commands');
    await test.page.screenshot({ path: path.join(test.artifacts, 'trust-dialog.png') });
    await test.page.getByRole('button', { name: 'Trust Folder & Continue' }).click();
    await expect(conversation.getByText('Restricted Mode', { exact: true })).toHaveCount(0);
    await expect(conversation.locator('#agent-state')).toContainText('workspace');
    checks.push('Restricted Mode shown; Trust Folder opens the trust dialog; trusting clears it');
    await test.page.screenshot({ path: path.join(test.artifacts, 'trusted.png') });
    expect(test.errors).toEqual([]);
    await writeFile(path.join(test.artifacts, 'result.json'), JSON.stringify({ checks }, null, 2));
    console.log(`PASS: workspace trust from the conversation panel (${checks.length} checks).`);
} catch (error) { failure = error; throw error; }
finally { await test.finish(failure); }
