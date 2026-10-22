import { expect } from '../../../node_modules/@playwright/test/index.mjs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { desktopTest } from './desktop-test.mjs';

// Furnace themes (patches/themes-menu.patch, product/theme-manager.cjs) in the real window: the
// Themes menu, presets applied as in-memory overrides (never written to settings.json), the
// backdrop and see-through panels, fonts, the light base theme, per-project themes across a
// restart, the agent glow, and the Create a Custom Theme page with live preview and Cancel.
const test = await desktopTest('themes-smoke');
let failure;
try {
    await writeFile(path.join(test.workspace, 'hello.txt'), 'hello\n');
    await test.launch(test.workspace);
    const checks = [];
    const settingsFile = path.join(test.profile, 'user-data/User/settings.json');
    const settings = async () => JSON.parse(await readFile(settingsFile, 'utf8'));
    const label = item => item.label.replace(/&/g, '');
    const menus = () =>
        test.app.evaluate(({ Menu }) =>
            (Menu.getApplicationMenu()?.items || []).map(item => item.label.replace(/&/g, '')),
        );
    const themesMenu = () =>
        test.app.evaluate(({ Menu }) => {
            const menu = Menu.getApplicationMenu()?.items.find(
                item => item.label.replace(/&/g, '') === 'Themes',
            )?.submenu;
            return (menu?.items || [])
                .filter(item => item.type !== 'separator')
                .map(item => ({
                    label: item.label.replace(/&/g, ''),
                    checked: item.checked,
                    items: item.submenu?.items.map(sub => ({
                        label: sub.label.replace(/&/g, ''),
                        checked: sub.checked,
                    })),
                }));
        });
    const click = (...path) =>
        test.app.evaluate(({ Menu }, path) => {
            let items = Menu.getApplicationMenu().items.find(item => item.label.replace(/&/g, '') === 'Themes').submenu
                    .items,
                item;
            for (const name of path) {
                item = items.find(entry => entry.label.replace(/&/g, '') === name);
                items = item.submenu?.items;
            }
            item.click();
        }, path);
    const workbench = property =>
        test.page.evaluate(
            property => getComputedStyle(document.querySelector('.monaco-workbench')).getPropertyValue(property).trim(),
            property,
        );
    const conversation = await test.webview('conversation');
    const panelText = () => conversation.evaluate(() => getComputedStyle(document.body).color);
    const charcoalText = await panelText();

    // The menu: after Go, with the presets (Furnace Charcoal ticked) and an empty My Themes.
    await expect.poll(menus).toContain('Themes');
    expect((await menus()).indexOf('Themes')).toBe((await menus()).indexOf('Go') + 1);
    await expect.poll(async () => (await themesMenu()).find(item => item.label === 'Presets')?.items?.length).toBe(8);
    const menu = await themesMenu();
    expect(menu.map(item => item.label)).toEqual([
        'Create a Custom Theme...',
        'Edit Current Theme...',
        'Presets',
        'My Themes',
        'Surprise Me',
        'Use for This Project',
        'Day and Night...',
        'Agent Glow',
        'Import Theme...',
        'Export Current Theme...',
    ]);
    expect(menu.find(item => item.label === 'Presets').items.find(item => item.checked)?.label).toBe(
        'Furnace Charcoal',
    );
    expect(menu.find(item => item.label === 'My Themes').items.map(item => item.label)).toEqual([
        'No saved themes yet',
    ]);
    expect(await test.page.locator('.monaco-workbench > .furnace-backdrop').count()).toBe(0);
    checks.push(
        'Themes menu after Go: create/edit, 8 presets with Charcoal ticked, My Themes empty, project, day/night, glow, import/export',
    );

    // Midnight: gradient backdrop, see-through panels, Inter, Arctic code colours; nothing in settings.json but the choice.
    await click('Presets', 'Midnight');
    await expect.poll(async () => (await settings())['aiGui.theme.current']).toBe('midnight');
    await expect(test.page.locator('.monaco-workbench > .furnace-backdrop')).toHaveCount(1);
    expect(
        await test.page
            .locator('.monaco-workbench > .furnace-backdrop')
            .evaluate(element => element.style.backgroundImage),
    ).toContain('linear-gradient');
    await expect.poll(() => workbench('--vscode-editor-background')).toBe('#0d1424');
    expect(await workbench('--vscode-focusBorder')).toBe('#6ea8ff');
    expect(await workbench('--vscode-statusBar-background')).toMatch(/^rgba\(10, 16, 32, 0\.\d+\)$/); // See-through over the backdrop.
    expect(
        await test.page.evaluate(() => getComputedStyle(document.querySelector('.monaco-workbench')).fontFamily),
    ).toContain('Inter');
    // Nothing solid between the backdrop and the see-through parts (Astra found the layout grid painting grey).
    expect(
        await test.page.evaluate(() => {
            const solid = [];
            for (const part of document.querySelectorAll(
                '.part.sidebar, .part.auxiliarybar, .part.statusbar, .part.titlebar, .part.activitybar',
            )) {
                const box = part.getBoundingClientRect();
                if (!box.width || !box.height) continue;
                for (let e = part.parentElement; e && !e.classList.contains('monaco-workbench'); e = e.parentElement)
                    if (getComputedStyle(e).backgroundColor !== 'rgba(0, 0, 0, 0)') solid.push(e.className);
                if (!/, 0\.\d+\)$/.test(getComputedStyle(part).backgroundColor)) solid.push(part.id);
            }
            return [...new Set(solid)];
        }),
    ).toEqual([]);
    expect(
        Object.keys(await settings()).filter(key => /colorCustomizations|tokenColorCustomizations/.test(key)),
    ).toEqual([]);
    expect((await settings())['workbench.colorTheme']).toBe('Furnace Charcoal'); // The launcher's default, untouched.
    await expect.poll(panelText).toBe('rgb(221, 230, 245)');
    expect(await conversation.evaluate(() => document.body.dataset.backdrop)).toBe('1');
    await expect
        .poll(
            async () =>
                (await themesMenu()).find(item => item.label === 'Presets').items.find(item => item.checked)?.label,
        )
        .toBe('Midnight');
    await test.page.screenshot({ path: path.join(test.artifacts, 'midnight.png') });
    checks.push(
        'Midnight: gradient backdrop, see-through panels, editor/accent colours, Inter, panels recoloured; only aiGui.theme.current saved; menu tick moves',
    );

    // Paper: light base theme, solid background (no backdrop).
    await click('Presets', 'Paper');
    await expect
        .poll(() => test.page.locator('.monaco-workbench').evaluate(element => element.classList.contains('vs')))
        .toBe(true);
    await expect(test.page.locator('.monaco-workbench > .furnace-backdrop')).toHaveCount(0);
    await expect.poll(panelText).toBe('rgb(43, 42, 39)');
    // The message box follows a light theme too (Astra found it dark under Paper).
    expect(
        await conversation.evaluate(() => {
            // Any CSS colour → its red channel (a canvas normalises color(srgb …) and color-mix results).
            const context = document.createElement('canvas').getContext('2d');
            context.fillStyle = getComputedStyle(document.querySelector('.composer')).backgroundColor;
            context.fillRect(0, 0, 1, 1);
            return context.getImageData(0, 0, 1, 1).data[0];
        }),
    ).toBeGreaterThan(150);
    await test.page.screenshot({ path: path.join(test.artifacts, 'paper.png') });
    checks.push('Paper: light base theme, no backdrop, panels follow');

    // Per project: Use for This Project, then Forge applies to this project only and survives a restart.
    await click('Use for This Project');
    await expect
        .poll(async () => (await themesMenu()).find(item => item.label === 'Use for This Project').checked)
        .toBe(true);
    await click('Presets', 'Forge');
    await expect.poll(() => workbench('--vscode-focusBorder')).toBe('#e5533d');
    expect((await settings())['aiGui.theme.current']).toBe('paper');
    await test.close();
    await test.launch(test.workspace);
    await expect.poll(() => workbench('--vscode-focusBorder'), { timeout: 30000 }).toBe('#e5533d');
    await expect
        .poll(async () => (await themesMenu()).find(item => item.label === 'Use for This Project')?.checked)
        .toBe(true);
    await click('Use for This Project');
    await expect
        .poll(() => test.page.locator('.monaco-workbench').evaluate(element => element.classList.contains('vs')))
        .toBe(true);
    checks.push(
        'per-project theme: chosen theme stays with the project across a restart; the global choice is untouched; turning it off returns to it',
    );

    // Agent glow and Charcoal again: everything back to the stock look.
    await click('Agent Glow');
    await expect.poll(async () => (await settings())['aiGui.theme.agentGlow']).toBe(true);
    const chat = await test.webview('conversation');
    await expect(chat.locator('#agent-glow')).toHaveClass(/idle/);
    await click('Presets', 'Furnace Charcoal');
    await expect.poll(() => workbench('--vscode-editor-background')).toBe('#141414');
    await expect
        .poll(() => test.page.locator('.monaco-workbench').evaluate(element => element.classList.contains('vs-dark')))
        .toBe(true);
    await expect.poll(() => chat.evaluate(() => getComputedStyle(document.body).color)).toBe(charcoalText);
    expect(await chat.evaluate(() => document.body.dataset.backdrop)).toBeUndefined();
    await click('Agent Glow');
    await expect(chat.locator('#agent-glow')).toHaveCount(0);
    checks.push('agent glow on/off; Charcoal restores the stock theme, colours and panels');

    // Create a Custom Theme: live preview in the window, the ember effect, Cancel restores.
    await click('Create a Custom Theme...');
    const editor = await test.webview('themes');
    await expect(editor.locator('.theme-part h2')).toHaveCount(6);
    await editor.getByLabel('Accent colour', { exact: true }).fill('#33cc99');
    await expect.poll(() => workbench('--vscode-focusBorder')).toBe('#33cc99');
    await editor.getByRole('group', { name: 'Ember effect' }).getByRole('button', { name: 'Sparks' }).click();
    await expect(test.page.locator('.monaco-workbench > .furnace-backdrop canvas')).toHaveCount(1);
    await expect(editor.getByText(/Dim panels automatically/)).toBeVisible();
    await test.page.screenshot({ path: path.join(test.artifacts, 'custom-preview.png') });
    await editor.getByRole('button', { name: 'Cancel' }).click();
    await expect.poll(() => workbench('--vscode-focusBorder')).not.toBe('#33cc99');
    await expect(test.page.locator('.monaco-workbench > .furnace-backdrop')).toHaveCount(0);
    checks.push('Create a Custom Theme: accent previews live, sparks start, Cancel restores the previous theme');

    // Save: the new theme appears under My Themes, ticked.
    await click('Create a Custom Theme...');
    const second = await test.webview('themes');
    await second.getByLabel('Name').fill('Test Theme');
    await second.getByLabel('Main text', { exact: true }).fill('#eeeeee');
    await second.getByRole('button', { name: 'Save Theme' }).click();
    // The native menu bar only updates while the window (not a webview) has focus; clicking the window brings the update.
    await test.page.locator('.part.editor').click({ position: { x: 60, y: 60 } });
    await expect
        .poll(async () => (await themesMenu()).find(item => item.label === 'My Themes').items)
        .toEqual([{ label: 'Test Theme', checked: true }]);
    expect((await settings())['aiGui.theme.current']).toMatch(/^user-/);
    checks.push('Save: the theme is stored, listed under My Themes and applied');

    expect(test.errors).toEqual([]);
    await writeFile(path.join(test.artifacts, 'result.json'), JSON.stringify({ checks }, null, 2));
    console.log(`PASS: Furnace themes (${checks.length} checks).`);
} catch (error) {
    failure = error;
    throw error;
} finally {
    await test.finish(failure);
}
