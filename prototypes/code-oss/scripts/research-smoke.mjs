import { expect } from '../../../node_modules/@playwright/test/index.mjs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { desktopTest } from './desktop-test.mjs';
import { root } from './environment.mjs';
const test = await desktopTest('research-smoke');
let failure;
try {
    process.env.AI_GUI_RESEARCH_TEST = test.artifacts;
    await test.launch(undefined, ['--extensionTestsPath', path.join(root, 'fixtures/research-tests.cjs')]);
    await expect.poll(async () => {
        const report = JSON.parse(await readFile(path.join(test.artifacts, 'research-report.json'), 'utf8').catch(() => '{}'));
        if (report.stage === 'failed') throw new Error(report.error);
        return report.stage;
    }, { timeout: 60000 }).toBe('complete');
    expect(test.errors).toEqual([]);
    await writeFile(path.join(test.artifacts, 'result.json'), await readFile(path.join(test.artifacts, 'research-report.json')));
    console.log('PASS: research companion transport and lifecycle from real extension host (P1.1 probe).');
} catch (error) { failure = error; throw error; }
finally { delete process.env.AI_GUI_RESEARCH_TEST; await test.finish(failure); }
