import { _electron as electron } from '../../../node_modules/playwright-core/index.mjs';
import { expect } from '../../../node_modules/@playwright/test/index.mjs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { launchOptions } from './launch.mjs';
import { root } from './environment.mjs';

// Renders the bundled React surfaces in a sandboxed Electron window under the production
// content security policy, feeds them fixture state and checks what they post back.
await mkdir(path.join(root, '.cache/webview-smoke'), { recursive: true });
const artifacts = await mkdtemp(path.join(root, '.cache/webview-smoke/run-'));
const media = path.join(root, '.cache/product/media');
const checks = [], errors = [];
let app, failure;

async function open(surface, width) {
    const file = path.join(artifacts, `${surface}.html`);
    await writeFile(file, `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src file:; script-src 'nonce-test';">
<link rel="stylesheet" href="${pathToFileURL(path.join(media, 'workspace.css'))}"></head><body data-surface="${surface}"><div id="root"></div>
<script nonce="test">window.posted = []; let saved; window.acquireVsCodeApi = () => ({ postMessage: message => window.posted.push(message), getState: () => saved, setState: value => { saved = value; } });</script>
<script nonce="test" src="${pathToFileURL(path.join(media, `${surface}.js`))}"></script></body></html>`);
    const options = await launchOptions(path.join(artifacts, 'launcher-profile'));
    for (const key of Object.keys(options.env)) if (/^(ELECTRON_|VSCODE_|NODE_OPTIONS$|NODE_PATH$)/.test(key)) delete options.env[key];
    options.args = [path.join(root, 'fixtures/webview-entry.cjs'), '--ozone-platform=x11'];
    Object.assign(options.env, { AI_GUI_WEBVIEW_PAGE: file, AI_GUI_WEBVIEW_WIDTH: String(width) });
    app = await electron.launch({ ...options, chromiumSandbox: true, timeout: 60000 });
    const page = await app.firstWindow(); page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.stack)); page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await expect.poll(() => page.evaluate(() => window.posted.some(message => message.type === 'ready'))).toBe(true);
    return page;
}
const send = (page, value) => page.evaluate(value => window.postMessage(value, '*'), value);
const posted = (page, type) => page.evaluate(type => window.posted.filter(message => message.type === type), type);
const step = (id, tool, title, extra = {}) => ({ id, tool, title, status: 'done', startedAt: 1000, endedAt: 1200, ...extra });
const reply = `## Summary

I updated **two files** and ran the tests:

- \`src/app.ts\`: added validation
- [x] tests pass

| File | Change |
| --- | --- |
| app.ts | +12 −3 |

\`\`\`ts
export function validate(input: string): boolean { return input.trim().length > 0 && input.length < 200 && /^[a-z0-9_-]+$/i.test(input) && !input.includes('..'); }
\`\`\`

<img src="x" onerror="window.injected = 1"> Raw HTML is never rendered. ![tracker](https://example.invalid/pixel.png)`;
const messages = [
    { id: 'u1', role: 'user', content: 'Add input validation and run the tests.' },
    { id: 'a1', role: 'assistant', model: 'openai/gpt-fixture', state: 'complete', content: reply, startedAt: 0, endedAt: 65000,
        steps: [...Array.from({ length: 8 }, (_, i) => step(`r${i}`, 'read_file', `Read src/file${i}.ts`)), step('g1', 'grep', 'Searched for “validate”'), step('g2', 'glob', 'Searched for **/*.ts'),
            step('e1', 'edit_file', 'Edited src/app.ts (+12 −3)', { diff: '--- src/app.ts\n+++ src/app.ts\n@@ -1,1 +1,1 @@\n-old\n+new' }), step('w1', 'write_file', 'Created src/new.ts (+20 −0)'),
            step('t1', 'todo_write', 'Tasks 0/2 done', { todos: [{ content: 'Validate', status: 'in_progress' }, { content: 'Test', status: 'pending' }] }),
            step('c1', 'run_command', 'Ran npm test (exit 0)', { output: 'all tests passed\n', startedAt: 2000, endedAt: 9000 }),
            step('t2', 'todo_write', 'Tasks 2/2 done', { todos: [{ content: 'Validate', status: 'completed' }, { content: 'Test', status: 'completed' }] })],
        changes: { files: [{ path: 'src/app.ts', status: 'modified', added: 12, removed: 3, restorable: true }, { path: 'src/new.ts', status: 'added', added: 20, removed: 0, restorable: true, reverted: true },
            { path: 'assets/a-very-long-folder-name/with/many/nested/levels/logo-with-a-long-name.png', status: 'modified', added: 0, removed: 0, restorable: false }] } },
    { id: 'u2', role: 'user', content: 'Now delete the old helper.' },
    { id: 'a2', role: 'assistant', model: 'openai/gpt-fixture', state: 'streaming', content: '', startedAt: Date.now() - 3000,
        steps: [step('d1', 'delete_path', 'Deleted src/old.ts', { status: 'waiting', approval: 'edit', rule: { kind: 'edit', pattern: '*', subject: '*' }, diff: '--- src/old.ts\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-helper' })] },
];
// Earlier messages condensed into a summary note; the first exchange is above it.
messages.splice(2, 0, { id: 's1', role: 'user', kind: 'summary', condensed: 2, content: '**Goals:** validation.', createdAt: 1 },
    { id: 'u-m', role: 'user', content: 'Explain @src/app.ts', mentions: [{ path: 'src/app.ts', kind: 'file', lines: 40 }, { path: '.env', kind: 'blocked' }], images: [{ id: 'i1', name: 'shot.png', mime: 'image/png', size: 2048 }] });
const chat = { id: 'chat-1', title: 'Add input validation', model: 'openai/gpt-fixture', busy: true, switching: false, connecting: false, error: '', attachments: [], sharePlan: false, shareEditor: false,
    connections: { models: [{ id: 'openai/gpt-fixture', name: 'openai: gpt-fixture' }], connections: [], secureStorage: true }, permission: 'ask', agent: { sandbox: true, project: { name: 'demo', trusted: true } }, grants: [],
    compacting: false, shareSelection: false, shareDiff: false, shareProblems: false, contextInfo: { editor: 1200, selection: { label: 'app.ts:3–9', chars: 240 }, problems: { count: 2, errors: 1, chars: 300 }, diff: null },
    usage: { used: 130000, window: 200000, system: 4000, history: 120000, shared: 6000, condensed: 1, measured: { input: 128000, output: 900 } }, queue: [], queuePaused: false, images: [], processes: [], rules: [] };
const state = (overrides = {}) => ({ type: 'state', state: { mode: 'Build', draft: '', brief: '' }, scope: 'demo', status: '', tour: { dismissed: false, seen: {} }, modeModels: {},
    review: { pending: false, busy: false, generation: 1 }, research: { sources: [], opened: false, busy: false, loading: false, url: '', title: '', error: '' }, chat, ...overrides });

try {
    let page = await open('conversation', 440);
    await send(page, state({ messages: { reset: true, order: messages.map(m => m.id), upsert: messages } }));
    const first = page.locator('.message').nth(1);
    await expect(first.locator('.markdown h2')).toHaveText('Summary');
    await expect(first.locator('.markdown table td').first()).toHaveText('app.ts');
    await expect(first.locator('.code-block .hljs-keyword').first()).toBeVisible();
    await expect(first.locator('.code-head span')).toHaveText('ts');
    expect(await first.locator('.markdown img').count()).toBe(0);
    expect(await page.evaluate(() => window.injected)).toBeUndefined();
    await expect(first.locator('.markdown a', { hasText: 'tracker' })).toHaveCount(1);
    checks.push('Markdown reply: headings, GFM table and task list, highlighted code; raw HTML and remote images are not rendered');
    await expect(first.locator('.work-summary > summary')).toHaveText('Worked for 1m 05s · 15 steps');
    await first.locator('.work-summary > summary').click();
    await expect(first.locator('.step-group > summary').first()).toHaveText('✓Read 8 files, searched 2 times');
    await expect(first.locator('.step-group > summary').nth(1)).toHaveText('✓Made 2 changes (+32 −3)');
    await expect(first.locator('.todos')).toHaveCount(1);
    await expect(first.locator('.step-time')).toHaveText('7s');
    checks.push('finished work collapses to "Worked for … · N steps"; reads and edits group; only the latest checklist shows');
    const changes = first.locator('.changes');
    await expect(changes.locator('.changes-head strong')).toHaveText('Changed 2 files');
    await expect(changes.getByText('Reverted')).toBeVisible();
    await expect(changes.getByText('Can’t restore')).toBeVisible();
    await expect(changes.getByRole('button', { name: 'Revert All' })).toBeDisabled();
    await send(page, state({ chat: { ...chat, busy: false }, messages: { reset: false, order: messages.map(m => m.id), upsert: [] } }));
    await changes.getByRole('button', { name: 'Revert src/app.ts' }).click();
    await changes.getByRole('button', { name: 'Review' }).click();
    expect(await posted(page, 'revertChanges')).toEqual([{ type: 'revertChanges', messageId: 'a1', path: 'src/app.ts', sessionId: 'chat-1' }]);
    expect(await posted(page, 'openChange')).toEqual([{ type: 'openChange', messageId: 'a1', sessionId: 'chat-1' }]);
    await send(page, state({ messages: { reset: false, order: messages.map(m => m.id), upsert: [] } }));
    checks.push('changes card lists added/modified/reverted/unrestorable files; per-file revert and Review post typed messages; disabled while busy');
    await first.getByRole('button', { name: 'Copy', exact: true }).click();
    expect((await posted(page, 'copy'))[0].text).toContain('export function validate');
    const live = page.locator('.message').nth(4);
    await expect(live.locator('.live-state')).toContainText('WAITING FOR YOU · ');
    await live.getByRole('button', { name: 'Approve' }).click();
    expect((await posted(page, 'approval'))[0]).toMatchObject({ id: 'd1', decision: 'approve' });
    checks.push('live byline shows state and elapsed time; inline approval and code Copy post back');
    await live.getByRole('button', { name: 'Always allow edits in this project' }).click();
    expect((await posted(page, 'approval'))[1]).toMatchObject({ id: 'd1', decision: 'project' });
    await expect(page.locator('.condensed-note > summary')).toContainText('Earlier messages condensed · 2 messages');
    await expect(page.locator('.message').first()).toHaveClass(/condensed-out/);
    await expect(page.locator('.message').nth(2)).not.toHaveClass(/condensed-out/);
    await expect(page.locator('.attachment-chip')).toHaveText(['@src/app.ts', '@.env · not shared', 'shot.png']);
    await expect(page.locator('#context-meter')).toHaveText('65%');
    await expect(page.locator('#context-meter')).toHaveClass(/medium/);
    expect(await page.locator('#context-meter').getAttribute('title')).toContain('about 130k of 200k tokens');
    checks.push('approval offers a saved project rule; condensed-summary note dims older messages; mention/image chips; context meter shows usage');
    // Incremental update: only the live reply is sent; the other rows keep their DOM nodes.
    await page.evaluate(() => { document.querySelectorAll('.message')[1].dataset.mark = 'kept'; });
    const updated = { ...messages[5], content: 'Deleting it **now**.', steps: [{ ...messages[5].steps[0], status: 'done' }] };
    await send(page, state({ messages: { reset: false, order: messages.map(m => m.id), upsert: [updated] } }));
    await expect(live.locator('.markdown strong')).toHaveText('now');
    expect(await page.evaluate(() => document.querySelectorAll('.message')[1].dataset.mark)).toBe('kept');
    checks.push('incremental update re-renders only the changed message');
    const overflow = () => page.evaluate(() => {
        const scroller = document.getElementById('scroller'), style = getComputedStyle(scroller);
        const limit = scroller.getBoundingClientRect().left + scroller.clientWidth - parseFloat(style.paddingRight) + 0.5;
        const wide = [...scroller.querySelectorAll('*')].filter(node => node.getBoundingClientRect().right > limit).map(node => `${node.tagName}.${node.className} +${Math.round(node.getBoundingClientRect().right - limit)}px`);
        return scroller.scrollWidth > scroller.clientWidth ? [`scrollWidth ${scroller.scrollWidth} > ${scroller.clientWidth}`, ...wide.slice(0, 8)] : [];
    });
    for (const width of [440, 300]) {
        await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 860), width);
        await expect.poll(overflow).toEqual([]);
    }
    checks.push('no horizontal overflow in the message list at 440 and 300 px');
    const code = first.locator('.code-block pre'), wrapButton = first.getByRole('button', { name: 'Wrap' });
    const scrolls = () => code.evaluate(node => node.scrollWidth > node.clientWidth);
    await expect(wrapButton).toHaveAttribute('aria-pressed', 'true');
    expect(await scrolls()).toBe(false);
    await wrapButton.click();
    await expect(wrapButton).toHaveAttribute('aria-pressed', 'false');
    expect(await scrolls()).toBe(true);
    await wrapButton.click();
    expect(await scrolls()).toBe(false);
    checks.push('code blocks wrap long lines by default; the Wrap toggle switches to horizontal scrolling and back');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(240, 860));
    await expect.poll(() => page.evaluate(() => {
        const problems = [...document.querySelectorAll('.modes button')].filter(node => node.scrollWidth > node.clientWidth).map(node => node.textContent);
        if (document.getElementById('model').getBoundingClientRect().width < 100) problems.push('model picker hidden');
        return problems;
    })).toEqual([]);
    checks.push('at 240 px the mode tabs fit and the model picker keeps its own row');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(440, 860));
    expect(await page.evaluate(() => { const node = document.getElementById('scroller'); node.scrollTop = 0; node.dispatchEvent(new Event('scroll')); return node.scrollHeight - node.clientHeight; })).toBeGreaterThan(200);
    const sent = [...messages, { id: 'u3', role: 'user', content: 'One more thing.' }];
    await send(page, state({ messages: { reset: false, order: sent.map(m => m.id), upsert: [sent.at(-1)] } }));
    await expect.poll(() => page.evaluate(() => { const node = document.getElementById('scroller'); return node.scrollHeight - node.scrollTop - node.clientHeight < 2; })).toBe(true);
    await send(page, state({ messages: { reset: false, order: messages.map(m => m.id), upsert: [] } }));
    checks.push('sending while scrolled up brings the new message into view');
    await page.screenshot({ path: path.join(artifacts, 'conversation.png') });
    // Draft echoes must not overwrite newer typing; external changes still apply.
    const idle = { ...chat, busy: false };
    await send(page, state({ chat: idle, messages: { reset: false, order: messages.map(m => m.id), upsert: [] } }));
    const draft = page.getByLabel('Conversation draft');
    await draft.pressSequentially('hello world');
    await send(page, state({ chat: idle, state: { mode: 'Build', draft: 'hello', brief: '' } }));
    await expect(draft).toHaveValue('hello world');
    await send(page, state({ chat: idle, state: { mode: 'Build', draft: '', brief: '' } }));
    await expect(draft).toHaveValue('');
    await draft.fill('/per');
    await expect(page.locator('#slash')).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page.locator('#permission')).toBeFocused();
    await page.locator('.message.user').first().hover();
    await page.getByRole('button', { name: 'Rewind to here' }).first().click();
    expect((await posted(page, 'rewind'))[0]).toMatchObject({ messageId: 'u1' });
    checks.push('draft echoes do not clobber typing; external clears apply; slash palette runs commands; rewind posts from a user message');
    // @ mentions: the palette asks for paths and inserts the chosen one.
    await draft.fill('');
    await draft.pressSequentially('Look at @ap');
    await expect.poll(async () => (await posted(page, 'mentionSearch')).at(-1)?.value).toBe('ap');
    await send(page, { type: 'mentions', query: 'ap', items: [{ path: 'src/app.ts', kind: 'file' }, { path: 'src/my app', kind: 'folder' }] });
    await expect(page.getByRole('listbox', { name: 'Files and folders' }).getByRole('option')).toHaveCount(2);
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
    await expect(draft).toHaveValue('Look at @"src/my app" ');
    // Context chips: selection, Git changes, Problems.
    await page.getByRole('button', { name: 'Selection app.ts:3–9' }).click();
    await page.getByRole('button', { name: 'Problems (2)' }).click();
    expect((await posted(page, 'context')).slice(-2)).toEqual([{ type: 'context', field: 'shareSelection', enabled: true, sessionId: 'chat-1' }, { type: 'context', field: 'shareProblems', enabled: true, sessionId: 'chat-1' }]);
    // While busy, Enter queues; queued messages and background processes are listed.
    const busyChat = { ...chat, busy: true, queue: [{ id: 'q1', text: 'Then update the docs' }], processes: [{ id: 'p1', command: 'npm run dev', cwd: '/demo', status: 'running', exitCode: null, startedAt: 1, sandboxed: false }] };
    await send(page, state({ chat: busyChat, state: { mode: 'Build', draft: 'Also add tests', brief: '' } }));
    await expect(page.locator('.queue-row')).toHaveText(/Then update the docs/);
    await expect(page.locator('.process-row code')).toHaveText('npm run dev');
    await page.getByRole('button', { name: 'Stop npm run dev' }).click();
    expect((await posted(page, 'processStop'))[0]).toMatchObject({ id: 'p1' });
    await draft.focus(); await page.keyboard.press('Enter');
    expect((await posted(page, 'enqueue')).at(-1)).toMatchObject({ value: 'Also add tests' });
    await send(page, state({ chat: idle }));
    // History pane: search, rename, delete, open.
    await page.getByRole('button', { name: 'Chat History' }).click();
    await expect.poll(async () => (await posted(page, 'historyList')).length).toBeGreaterThan(0);
    await send(page, { type: 'history', query: '', current: 'chat-1', items: [{ id: 'chat-1', title: 'Add input validation', updatedAt: new Date().toISOString(), messageCount: 4 }, { id: 'old', title: 'Older chat', updatedAt: '2026-01-02T00:00:00Z', messageCount: 2, snippet: '…the parser…' }] });
    await expect(page.locator('.history-item')).toHaveCount(2);
    await page.getByLabel('Search conversations').fill('parser');
    await expect.poll(async () => (await posted(page, 'historyList')).at(-1)?.value).toBe('parser');
    await page.getByRole('button', { name: 'Rename Older chat' }).click();
    await page.getByLabel('Conversation name').fill('Parser work'); await page.keyboard.press('Enter');
    expect((await posted(page, 'historyRename'))[0]).toMatchObject({ id: 'old', title: 'Parser work' });
    await page.getByRole('button', { name: 'Delete Older chat' }).click();
    expect((await posted(page, 'historyDelete'))[0]).toMatchObject({ id: 'old' });
    await page.getByRole('button', { name: /^Older chat/ }).click();
    expect((await posted(page, 'historyOpen'))[0]).toMatchObject({ id: 'old' });
    await expect(page.locator('.history')).toHaveCount(0);
    // Message actions: branch and regenerate the latest reply.
    await page.locator('.message.assistant').first().hover();
    await page.getByRole('button', { name: 'Branch from here' }).nth(1).click();
    expect((await posted(page, 'branch'))[0]).toMatchObject({ messageId: 'a1' });
    await send(page, state({ chat: idle, messages: { reset: false, order: messages.map(m => m.id), upsert: [{ ...messages[5], state: 'complete', content: 'Done.' }] } }));
    await page.locator('.message.assistant').last().hover();
    await page.getByRole('button', { name: 'Regenerate' }).click();
    expect((await posted(page, 'regenerate'))[0]).toMatchObject({ messageId: 'a2' });
    checks.push('@ palette inserts a quoted path; selection/Problems chips; busy Enter queues; queue and background process rows with Stop; history pane search/rename/delete/open; branch and regenerate post');
    await page.screenshot({ path: path.join(artifacts, 'conversation-idle.png') });
    await app.close(); app = undefined;

    page = await open('home', 360);
    await send(page, state({ chat: idle }));
    await expect(page.getByRole('tab', { name: 'Build' })).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('tab', { name: 'Start' }).click();
    await expect(page.locator('.tour-step')).toHaveCount(7);
    await expect(page.locator('.shortcuts div')).toHaveCount(9);
    await send(page, { type: 'connections' });
    await page.getByRole('tab', { name: 'API keys', exact: true }).click();
    await page.getByLabel('API key', { exact: true }).fill('fixture-key');
    await page.getByRole('button', { name: 'Connect API Key', exact: true }).click();
    expect((await posted(page, 'connection'))[0]).toMatchObject({ value: { action: 'connect', provider: 'openai', key: 'fixture-key' } });
    await expect(page.getByLabel('API key', { exact: true })).toHaveValue('');
    await page.screenshot({ path: path.join(artifacts, 'connections.png') });
    await page.getByRole('button', { name: 'Close Connections', exact: true }).click();
    await send(page, state({ chat: idle, state: { mode: 'Plan', draft: '', brief: '' } }));
    await page.getByLabel('Planning brief').fill('Ship it\n- [x] Parser\n- [ ] Tests');
    expect((await posted(page, 'brief')).at(-1).value).toBe('Ship it\n- [x] Parser\n- [ ] Tests');
    await expect(page.locator('#plan-progress')).toHaveText('1 of 2 steps done');
    await page.getByRole('button', { name: 'Build from Plan' }).click();
    expect(await posted(page, 'buildPlan')).toHaveLength(1);
    await send(page, state({ chat: { ...idle, rules: [{ id: 'r1', effect: 'allow', kind: 'command', pattern: 'npm test', createdAt: '' }, { id: 'r2', effect: 'deny', kind: 'path', pattern: 'infra/', createdAt: '' }] }, state: { mode: 'Plan', draft: '', brief: '' } }));
    await page.getByRole('tab', { name: 'Rules' }).click();
    await expect(page.locator('.rule')).toHaveText([/Run “npm test” without asking/, /Never read or change infra\//]);
    await page.getByLabel('Rule effect').selectOption('deny');
    await page.getByLabel('Rule pattern').fill('git push'); await page.getByLabel('Rule type').selectOption('command');
    await page.getByRole('button', { name: 'Add Rule' }).click();
    expect((await posted(page, 'ruleAdd'))[0]).toMatchObject({ effect: 'deny', kind: 'command', pattern: 'git push' });
    await page.getByRole('button', { name: /Remove rule: Never read/ }).click();
    expect((await posted(page, 'ruleRemove'))[0]).toMatchObject({ id: 'r2' });
    await page.getByRole('tab', { name: 'Activity' }).click();
    await expect.poll(async () => (await posted(page, 'auditLoad')).length).toBe(1);
    await send(page, { type: 'audit', entries: [{ time: new Date().toISOString(), event: 'tool', tool: 'run_command', title: 'Ran npm test (exit 0)', status: 'done', decision: 'project rule: command npm test' }] });
    await expect(page.locator('.activity-title')).toHaveText('Ran npm test (exit 0)');
    await expect(page.locator('.activity small')).toHaveText('project rule: command npm test');
    await page.screenshot({ path: path.join(artifacts, 'activity.png') });
    await send(page, state({ chat: idle, state: { mode: 'Research', draft: '', brief: '' } }));
    await expect(page.getByRole('tab', { name: 'Research' })).toHaveAttribute('aria-selected', 'true');
    checks.push('workspace view pages: plan progress and Build from Plan; saved rules list/add/remove; activity log; switching mode shows its page');
    await page.screenshot({ path: path.join(artifacts, 'home.png') });
    checks.push('workspace page: tour, Connections tabs and key entry (field cleared), brief editing');
    expect(errors).toEqual([]);
    await writeFile(path.join(artifacts, 'result.json'), JSON.stringify({ checks }, null, 2));
    console.log(`PASS: React webview surfaces (${checks.length} checks).`);
} catch (error) { failure = error; throw error; }
finally {
    if (failure && app) await (await app.firstWindow()).screenshot({ path: path.join(artifacts, 'failure.png') }).catch(() => {});
    await app?.close();
    await writeFile(path.join(artifacts, 'errors.json'), JSON.stringify(errors, null, 2));
    console.log(`Evidence: ${artifacts}`);
}
