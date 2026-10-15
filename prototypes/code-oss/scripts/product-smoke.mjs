import { expect } from '../../../node_modules/@playwright/test/index.mjs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { desktopTest } from './desktop-test.mjs';
const test = await desktopTest('product-smoke', { welcome: true });
let failure;
try {
    const readyMs = await test.launch();
    let conversation = await test.webview('conversation');
    let home = await test.webview('home');
    await expect(home.getByText('No project needed', { exact: true })).toBeVisible();
    // First start: the welcome card offers the tutorial (patches/furnace-tutorial.patch draws it).
    const card = test.page.locator('.furnace-tutorial-card');
    await expect(card).toContainText('Welcome to Furnace', { timeout: 20000 });
    await test.page.screenshot({ path: path.join(test.artifacts, 'welcome.png') });
    await card.getByText("Don't show this again").click();
    await card.getByRole('button', { name: 'Start the Tutorial' }).click();
    // Walk every step: each bubble (in the window or inside a panel) must find what it points at.
    const bubbles = () => [test.page.locator('.furnace-tutorial-bubble'), conversation.locator('.tutorial-bubble'), home.locator('.tutorial-bubble')];
    const bubbleAt = async label => {
        let found;
        await expect.poll(async () => {
            for (const bubble of bubbles()) if (await bubble.count() && (await bubble.locator('.furnace-tutorial-count, .tutorial-count').textContent().catch(() => '')) === label) { found = bubble; return true; }
            return false;
        }, { timeout: 15000, message: `tutorial step ${label}` }).toBe(true);
        return found;
    };
    const firstCount = await (await bubbleAt('1 of 30')).locator('.furnace-tutorial-count').textContent();
    const total = Number(firstCount.split(' of ')[1]), walked = [];
    for (let index = 0; index < total; index++) {
        const bubble = await bubbleAt(`${index + 1} of ${total}`);
        const where = (await bubble.getAttribute('class')).includes('furnace-tutorial-bubble') ? 'window' : 'panel';
        // Bubbles follow their target as views open, so give each a moment to settle on it.
        const target = await expect.poll(() => bubble.getAttribute('data-target'), { timeout: 3000 }).toBe('found').then(() => 'found', () => 'none');
        const ring = await test.page.locator('.furnace-tutorial-ring').boundingBox().catch(() => null);
        walked.push({ step: index + 1, where, title: await bubble.locator('h3').textContent(), target, ...(where === 'window' && ring ? { ring } : {}) });
        await test.page.waitForTimeout(250);
        await test.page.screenshot({ path: path.join(test.artifacts, `tutorial-${String(index + 1).padStart(2, '0')}.png`) });
        await bubble.getByRole('button', { name: index === total - 1 ? 'Finish' : 'Next' }).click();
    }
    await writeFile(path.join(test.artifacts, 'tutorial.json'), JSON.stringify(walked, null, 2));
    expect(walked.filter(step => step.target !== 'found').map(step => step.title)).toEqual(['Welcome to Furnace']);
    expect(walked.filter(step => step.where === 'panel').length).toBeGreaterThan(15);
    for (const bubble of bubbles()) await expect(bubble).toHaveCount(0);
    await expect(conversation.locator('#mode-label')).toHaveText('Discuss');
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
    // Display menu (patches/display-menu.patch): in the native menu bar after View; its
    // Window Opacity slider writes aiGui.window.opacity.
    const menus = () => test.app.evaluate(({ Menu }) => (Menu.getApplicationMenu()?.items || []).map(item => item.label.replace(/&/g, '')));
    await expect.poll(menus).toContain('Display');
    const labels = await menus();
    expect(labels.indexOf('Display')).toBe(labels.indexOf('View') + 1);
    await test.command('Display: Window Opacity');
    const slider = test.page.getByRole('slider', { name: 'Window opacity' });
    await expect(slider).toBeFocused();
    await expect(slider).toHaveValue('96');
    await test.page.keyboard.press('ArrowLeft');
    const settingsFile = path.join(test.profile, 'user-data/User/settings.json');
    await expect.poll(async () => JSON.parse(await readFile(settingsFile, 'utf8'))['aiGui.window.opacity']).toBe(0.95);
    await test.page.keyboard.press('Escape');
    await expect(slider).toHaveCount(0);
    // The Furnace menu sits before Help; Begin Tutorial starts the tour (Escape ends it), Help opens Furnace Help.
    const furnaceItems = () => test.app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.items.find(item => item.label.replace(/&/g, '') === 'Furnace')?.submenu?.items.map(item => item.label.replace(/&/g, '')) || []);
    expect((await menus()).indexOf('Furnace')).toBe((await menus()).indexOf('Help') - 1);
    await expect.poll(furnaceItems).toEqual(['Begin Tutorial', 'Help']);
    const clickFurnace = label => test.app.evaluate(({ Menu }, label) => Menu.getApplicationMenu().items.find(item => item.label.replace(/&/g, '') === 'Furnace').submenu.items.find(item => item.label.replace(/&/g, '') === label).click(), label);
    await clickFurnace('Begin Tutorial');
    await expect(test.page.locator('.furnace-tutorial-bubble h3')).toHaveText('Welcome to Furnace');
    await test.page.keyboard.press('Escape');
    await expect(test.page.locator('.furnace-tutorial-bubble')).toHaveCount(0);
    await clickFurnace('Help');
    const help = await test.webview('help');
    await expect(help.locator('.help-contents button').filter({ hasText: 'Connect a model' })).toBeVisible();
    await help.getByLabel('Search help').fill('autocompute');
    await expect(help.locator('.help-section h2').first()).toHaveText('Working with the agent');
    await test.page.screenshot({ path: path.join(test.artifacts, 'help.png') });
    await test.command('View: Close All Editors');
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
    // Finished (and "Don't show this again"): no welcome card on later starts.
    await test.page.waitForTimeout(4000);
    await expect(test.page.locator('.furnace-tutorial-card')).toHaveCount(0);
    expect(test.errors).toEqual([]);
    await writeFile(path.join(test.artifacts, 'result.json'), JSON.stringify({ readyMs, checks: ['project-free', 'welcome card on first start', 'tutorial: every step points at its target', 'Furnace menu: Begin Tutorial and Help', 'pages set modes; chat-only side bar', 'draft', 'brief', 'compact-layout', 'workspace view in the side bar; no editor tabs opened by modes', 'no welcome card after the tutorial', 'restart'] }, null, 2));
    console.log('PASS: product shell, modes, planning/draft persistence and compact layout.');
} catch (error) { failure = error; throw error; }
finally { await test.finish(failure); }
