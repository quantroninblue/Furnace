import { expect } from '../../../node_modules/@playwright/test/index.mjs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { desktopTest } from './desktop-test.mjs';

// The built-in JavaScript debugger (setup stage builtin-extensions) is available:
// Run and Debug is enabled, F5 launches Node, stops at `debugger;` and continues.
const test = await desktopTest('debug-smoke');
let failure;
try {
    await writeFile(path.join(test.workspace, 'app.js'), "const value = 6 * 7;\ndebugger;\nrequire('node:fs').writeFileSync(require('node:path').join(__dirname, 'debugged.txt'), String(value));\n");
    await mkdir(path.join(test.workspace, '.vscode'));
    await writeFile(path.join(test.workspace, '.vscode/launch.json'), JSON.stringify({ version: '0.2.0', configurations: [{ type: 'node', request: 'launch', name: 'Run app', program: '${workspaceFolder}/app.js' }] }));
    await test.launch(test.workspace, ['--disable-workspace-trust']);
    const checks = [];
    await test.command('View: Show Run and Debug');
    await expect(test.page.getByText('All debug extensions are disabled', { exact: false })).toHaveCount(0);
    await expect(test.page.locator('.debug-view-content, .debug-pane').first()).toBeVisible({ timeout: 30000 });
    checks.push('Run and Debug view has an enabled debugger');
    await test.page.keyboard.press('F5');
    await expect(test.page.locator('.debug-toolbar')).toBeVisible({ timeout: 60000 });
    await expect(test.page.locator('.debug-call-stack').getByText('app.js', { exact: false }).first()).toBeVisible({ timeout: 60000 });
    await test.page.screenshot({ path: path.join(test.artifacts, 'paused.png') });
    checks.push('F5 launches Node through js-debug and pauses at debugger statement');
    await test.page.keyboard.press('F5');
    await expect.poll(() => readFile(path.join(test.workspace, 'debugged.txt'), 'utf8').catch(() => ''), { timeout: 30000 }).toBe('42');
    checks.push('continue runs the program to completion');
    await expect(test.page.getByText(/Activating extension .* failed/)).toHaveCount(0);
    checks.push('no extension activation failures during debugging');
    expect(test.errors).toEqual([]);
    await writeFile(path.join(test.artifacts, 'result.json'), JSON.stringify({ checks }, null, 2));
    console.log(`PASS: built-in JavaScript debugger (${checks.length} checks).`);
} catch (error) { failure = error; throw error; }
finally { await test.finish(failure); }
