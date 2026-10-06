import { expect } from '../../../node_modules/@playwright/test/index.mjs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { desktopTest } from './desktop-test.mjs';
const test = await desktopTest('product-smoke');
let failure;
try {
    const readyMs = await test.launch();
    let conversation = await test.webview('conversation');
    let home = await test.webview('home');
    await expect(home.getByText('No project needed', { exact: true })).toBeVisible();
    await conversation.getByLabel('Conversation draft').fill('Keep the product core independent of the IDE.');
    await conversation.getByRole('button', { name: 'Plan', exact: true }).click();
    await home.getByLabel('Planning brief').fill('Goal: review changes against unsaved editor state.');
    for (const mode of ['Build', 'Research', 'Discuss', 'Plan']) {
        await conversation.getByRole('button', { name: mode, exact: true }).click();
        await expect(conversation.getByRole('button', { name: mode, exact: true })).toHaveAttribute('aria-pressed', 'true');
    }
    await expect(home.getByLabel('Planning brief')).toHaveValue('Goal: review changes against unsaved editor state.');
    await test.page.screenshot({ path: path.join(test.artifacts, 'planning.png') });
    await test.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1024, 768));
    await expect(conversation.getByLabel('Conversation draft')).toBeVisible();
    await test.page.screenshot({ path: path.join(test.artifacts, 'compact.png') });
    await test.close();
    await test.launch();
    conversation = await test.webview('conversation');
    home = await test.webview('home');
    await expect(conversation.getByRole('button', { name: 'Plan', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(conversation.getByLabel('Conversation draft')).toHaveValue('Keep the product core independent of the IDE.');
    await expect(home.getByLabel('Planning brief')).toHaveValue('Goal: review changes against unsaved editor state.');
    expect(test.errors).toEqual([]);
    await writeFile(path.join(test.artifacts, 'result.json'), JSON.stringify({ readyMs, checks: ['project-free', 'modes', 'draft', 'brief', 'compact-layout', 'restart'] }, null, 2));
    console.log('PASS: product shell, modes, planning/draft persistence and compact layout.');
} catch (error) { failure = error; throw error; }
finally { await test.finish(failure); }
