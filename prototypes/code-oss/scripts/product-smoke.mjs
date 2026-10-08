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
    await expect(home.locator('#tour')).toBeVisible();
    await expect(home.locator('.tour-step.current')).toContainText('Connect a model');
    await expect(home.locator('.tour-step')).toHaveCount(7);
    await expect(conversation.getByRole('button', { name: /Getting started · 0 of 7/ })).toBeVisible();
    await test.page.screenshot({ path: path.join(test.artifacts, 'tour.png') });
    await conversation.getByLabel('Conversation draft').fill('Keep the product core independent of the IDE.');
    // The conversation side bar is chat only; the Workspace pages set the mode.
    await expect(conversation.locator('.modes')).toHaveCount(0);
    await expect(conversation.getByRole('button', { name: 'Connections', exact: true })).toHaveCount(0);
    await home.getByRole('tab', { name: 'Plan', exact: true }).click();
    await expect(conversation.locator('#mode-label')).toHaveText('Plan');
    await home.getByLabel('Planning brief').fill('Goal: review changes against unsaved editor state.');
    for (const [page, mode] of [['Build', 'Build'], ['Research', 'Research'], ['Start', 'Discuss'], ['Plan', 'Plan']]) {
        await home.getByRole('tab', { name: page, exact: true }).click();
        await expect(conversation.locator('#mode-label')).toHaveText(mode);
        await expect(home.getByRole('tab', { name: page, exact: true })).toHaveAttribute('aria-selected', 'true');
    }
    await expect(home.getByLabel('Planning brief')).toHaveValue('Goal: review changes against unsaved editor state.');
    await test.page.screenshot({ path: path.join(test.artifacts, 'planning.png') });
    await test.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1024, 768));
    await expect(conversation.getByLabel('Conversation draft')).toBeVisible();
    await test.page.screenshot({ path: path.join(test.artifacts, 'compact.png') });
    // The workspace page is a side bar view: modes never open an editor tab.
    expect(await test.page.locator('.tabs-container .tab').count()).toBe(0);
    await expect(test.page.locator('.part.sidebar .composite.title')).toContainText('Furnace WORKSPACE', { ignoreCase: true });
    await home.getByRole('tab', { name: 'Start', exact: true }).click();
    // Branding: the Furnace wordmark shows, and the old placeholder name appears nowhere.
    await expect(home.getByRole('img', { name: 'Furnace' })).toBeVisible();
    await expect(conversation.getByRole('img', { name: 'Furnace' })).toBeVisible();
    for (const text of [await test.page.title(), await test.page.locator('body').innerText(), await home.locator('body').innerText(), await conversation.locator('body').innerText()])
        expect(text).not.toMatch(/AI GUI/i);
    await home.getByRole('button', { name: 'Skip tour', exact: true }).click();
    await expect(home.locator('#tour')).toBeHidden();
    // The Start page is Discuss mode; go back to Plan so the restart checks the saved mode.
    await expect(conversation.locator('#mode-label')).toHaveText('Discuss');
    await home.getByRole('tab', { name: 'Plan', exact: true }).click();
    await expect(conversation.locator('#mode-label')).toHaveText('Plan');
    await test.close();
    await test.launch();
    conversation = await test.webview('conversation');
    home = await test.webview('home');
    await expect(conversation.locator('#mode-label')).toHaveText('Plan');
    await expect(conversation.getByLabel('Conversation draft')).toHaveValue('Keep the product core independent of the IDE.');
    await expect(home.getByLabel('Planning brief')).toHaveValue('Goal: review changes against unsaved editor state.');
    await expect(home.locator('#tour')).toBeHidden();
    expect(test.errors).toEqual([]);
    await writeFile(path.join(test.artifacts, 'result.json'), JSON.stringify({ readyMs, checks: ['project-free', 'tour shown on first run', 'pages set modes; chat-only side bar', 'draft', 'brief', 'compact-layout', 'workspace view in the side bar; no editor tabs opened by modes', 'tour skip persists', 'restart'] }, null, 2));
    console.log('PASS: product shell, modes, planning/draft persistence and compact layout.');
} catch (error) { failure = error; throw error; }
finally { await test.finish(failure); }
