'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ProductSession } = require('../product-core.cjs');
const { ResearchSources } = require('../research-contract.cjs');
const { Conversation, parseMentions } = require('./conversation.cjs');

async function fixture(t, run, extra = {}, options = {}) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-'));
    const research = { sources: new ResearchSources('test'), resetScope: async () => research.sources.reset('next'), restore: () => {}, open: async () => {} };
    const adapter = { root: () => null, workspace: () => null, clear: () => {}, files: { pending: new Map() }, captureActive: () => ({ uri: 'untitled:test', text: '' }), ...extra };
    const chat = new Conversation({ directory, session: new ProductSession(), provider: { run, dispose: async () => {} }, research, adapter, ...options });
    chat.connections.models.push({ id: 'fixture/model', name: 'Fixture' }); chat.selectModel('fixture/model');
    // Finish pending saves and logs before removing the folder.
    t.after(async () => { await chat.dispose(); await new Promise(resolve => setTimeout(resolve, 20)); await fs.rm(directory, { recursive: true, force: true }); });
    return chat;
}
async function project(t) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-project-'))); t.after(() => fs.rm(root, { recursive: true, force: true }));
    const host = { root, trusted: true, sandbox: null,
        read: async file => fs.readFile(file, 'utf8'), kind: async file => { try { return (await fs.stat(file)).isDirectory() ? 'directory' : 'file'; } catch { return null; } },
        list: async dir => (await fs.readdir(dir, { withFileTypes: true })).map(entry => ({ name: entry.name, directory: entry.isDirectory() })),
        write: async (file, text) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text); return ''; },
        remove: (file, recursive) => fs.rm(file, { recursive }), move: (from, to) => fs.rename(from, to), mkdir: dir => fs.mkdir(dir, { recursive: true }) };
    return { root, host };
}
const until = async check => { for (let i = 0; i < 300 && !check(); i++) await new Promise(r => setTimeout(r, 10)); assert.ok(check()); };

test('long conversations are condensed into a visible summary; the model then sees the summary and recent messages', async t => {
    const requests = [];
    const chat = await fixture(t, async (request, _tools, _signal, emit) => {
        requests.push(request);
        if (request.messages.at(-1).content.startsWith('Summarize our conversation')) emit({ delta: 'SUMMARY: goals and decisions.' });
        // Providers report about as many input tokens as the estimate (chars / 4).
        else emit({ delta: 'ok '.repeat(200), usage: { input: Math.ceil(JSON.stringify(request.messages).length / 4), output: 50 } });
    }, {}, { contextWindow: () => 12000 });
    for (let i = 0; i < 12; i++) await chat.send(`message ${i} ${'x'.repeat(3000)}`);
    const summaries = chat.data.messages.filter(message => message.kind === 'summary');
    assert.ok(summaries.length >= 1, 'a summary was inserted');
    assert.match(summaries[0].content, /SUMMARY/);
    const summaryRequest = requests.find(request => request.messages.at(-1).content.startsWith('Summarize our conversation'));
    assert.equal(summaryRequest.mode, 'discuss');
    const latest = requests.at(-1);
    assert.equal(latest.messages[0].kind, 'summary');
    assert.ok(!latest.messages.some(message => message.content.startsWith('message 0 ')), 'condensed messages are no longer sent');
    assert.match(latest.messages.at(-1).content, /^message 11 /);
    const usage = chat.snapshot().usage;
    assert.equal(usage.window, 12000); assert.ok(usage.used > 0 && usage.condensed >= 1);
    const last = chat.data.messages.findLast(message => message.role === 'assistant').usage;
    assert.equal(last.output, 50); assert.equal(last.input, last.billedInput); assert.ok(last.input > 0);
});

test('a failed summary leaves a note and older messages are no longer sent; /compact condenses on demand', async t => {
    let fail = true;
    const requests = [];
    const chat = await fixture(t, async (request, _tools, _signal, emit) => {
        requests.push(request);
        if (request.messages.at(-1).content.startsWith('Summarize our conversation')) { if (fail) throw new Error('rate limited'); emit({ delta: 'Manual summary.' }); }
        else emit({ delta: 'fine' });
    }, {}, { contextWindow: () => 12000 });
    for (let i = 0; i < 10; i++) await chat.send(`m${i} ${'y'.repeat(3000)}`);
    const note = chat.data.messages.find(message => message.kind === 'summary');
    assert.ok(note.failed); assert.match(note.error, /rate limited/);
    assert.ok(!requests.at(-1).messages.some(message => message.content.startsWith('m0 ')));
    assert.equal(chat.data.messages.at(-1).state, 'complete');
    fail = false;
    await chat.compact();
    assert.equal(chat.data.messages.at(-1).kind, 'summary'); assert.equal(chat.data.messages.at(-1).content, 'Manual summary.');
    await chat.send('after compact');
    assert.deepEqual(requests.at(-1).messages.map(message => message.kind || message.role), ['summary', 'user']);
});

test('/compact leaves short history alone and drops a summary that is not shorter', async t => {
    let summary = 'Short.';
    const summaries = [];
    const chat = await fixture(t, async (request, _tools, _signal, emit) => {
        if (request.messages.at(-1).content.startsWith('Summarize our conversation')) { summaries.push(request); emit({ delta: summary }); }
        else emit({ delta: 'ok' });
    });
    for (let i = 0; i < 6; i++) await chat.send(`hi ${i}`);
    await chat.compact();
    assert.equal(summaries.length, 0, 'no summary request for a tiny chat');
    assert.match(chat.error, /^Too little to condense yet: the earlier messages are only about \d+ tokens\.$/);
    assert.ok(!chat.data.messages.some(message => message.kind === 'summary'));
    await chat.send(`long ${'z'.repeat(5000)}`);
    summary = 'w'.repeat(8000);
    await chat.compact();
    assert.equal(summaries.length, 1);
    assert.match(chat.error, /no shorter than the messages it would replace/);
    assert.ok(!chat.data.messages.some(message => message.kind === 'summary'));
    summary = 'Useful summary.';
    await chat.compact();
    assert.equal(chat.error, '');
    assert.equal(chat.data.messages.at(-1).content, 'Useful summary.');
});

test('@file and @folder mentions share project content; protected and blocked paths are not shared', async t => {
    const { root, host } = await project(t);
    await fs.mkdir(path.join(root, 'src')); await fs.writeFile(path.join(root, 'src/app.ts'), 'export const app = 1;\n');
    await fs.mkdir(path.join(root, 'infra')); await fs.writeFile(path.join(root, 'infra/main.tf'), 'secret infra');
    await fs.writeFile(path.join(root, '.env'), 'TOKEN=1');
    const requests = [];
    const chat = await fixture(t, async request => { requests.push(request); }, { root: () => root, toolHost: () => host });
    await chat.addRule({ effect: 'deny', kind: 'path', pattern: 'infra/' });
    assert.deepEqual(parseMentions('see @src/app.ts, @"my file.md" and me@example.com'), ['src/app.ts', 'my file.md']);
    await chat.send('Explain @src/app.ts and @src/ plus @.env and @infra/main.tf and @missing.ts');
    const context = requests[0].context;
    assert.match(context, /Mentioned file @src\/app\.ts \(2 lines\):\nexport const app = 1;/);
    assert.match(context, /Mentioned folder @src[\s\S]*src\/app\.ts/);
    assert.doesNotMatch(context, /TOKEN=1|secret infra/);
    assert.match(context, /@\.env was not shared/); assert.match(context, /@infra\/main\.tf was not shared/);
    assert.deepEqual(chat.data.messages[0].mentions.map(item => `${item.kind} ${item.path}`), ['file src/app.ts', 'folder src', 'blocked .env', 'blocked infra/main.tf']);
});

test('saved project rules allow approved commands next time, block denied paths and are audited', async t => {
    const { root, host } = await project(t);
    await fs.mkdir(path.join(root, 'infra')); await fs.writeFile(path.join(root, 'infra/x.tf'), 'x');
    const chat = await fixture(t, async (request, tools, _signal, emit) => {
        for (const command of request.messages.at(-1).content.split(' | ')) {
            try { emit({ delta: await tools.execute('run_command', { command, workdir: null, timeout_seconds: null, escalate: null, justification: null, background: null }) }); }
            catch (error) { emit({ delta: error.message }); }
        }
        await tools.execute('read_file', { path: 'infra/x.tf', offset: null, limit: null }).catch(error => emit({ delta: error.message }));
    }, { root: () => root, toolHost: () => host, permission: () => 'ask' });
    chat.session.update('mode', 'Build');
    const waiting = () => chat.data.messages.at(-1)?.steps?.find(step => step.status === 'waiting');
    let turn = chat.send('echo one');
    await until(waiting);
    assert.deepEqual(waiting().rule, { kind: 'command', pattern: 'echo one', subject: 'echo one' });
    chat.decide(waiting().id, 'project'); await turn;
    await until(() => chat.rules.list(root).length === 1);
    await chat.addRule({ effect: 'deny', kind: 'path', pattern: 'infra' });
    turn = chat.send('echo one --again'); await turn;
    const steps = chat.data.messages.at(-1).steps;
    assert.equal(steps[0].status, 'done'); assert.match(steps[0].allowedBy, /project rule: command echo one/);
    assert.match(chat.data.messages.at(-1).content, /blocked by the user's saved project rule "infra"/);
    await chat.addRule({ effect: 'deny', kind: 'command', pattern: 'echo' });
    await chat.send('echo one');
    assert.match(chat.data.messages.at(-1).content, /saved project rule "echo" blocks this command/);
    await new Promise(resolve => setTimeout(resolve, 50));
    const log = await chat.audit.read(root);
    assert.ok(log.some(entry => entry.event === 'tool' && entry.tool === 'run_command' && /project rule/.test(entry.decision)));
    assert.ok(log.some(entry => entry.event === 'rule' && /allow command echo one/.test(entry.title)));
});

test('messages queued while the agent works are sent after the reply; a stopped reply pauses the queue', async t => {
    const requests = [];
    let release;
    const chat = await fixture(t, async (request, _tools, signal, emit) => {
        requests.push(request.messages.at(-1).content);
        if (request.messages.at(-1).content === 'slow') await new Promise((resolve, reject) => { release = resolve; signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true }); });
        emit({ delta: 'done' });
    });
    const first = chat.send('slow');
    await until(() => release);
    chat.enqueue('second'); chat.enqueue('third');
    assert.deepEqual(chat.snapshot().queue.map(item => item.text), ['second', 'third']);
    release(); await first;
    await until(() => requests.length === 3 && !chat.turn);
    assert.deepEqual(requests, ['slow', 'second', 'third']);
    release = undefined;
    const again = chat.send('slow'); await until(() => release);
    chat.enqueue('later'); await chat.stop(); await again;
    assert.equal(chat.snapshot().queuePaused, true); assert.equal(chat.queued.length, 1);
    await chat.sendQueued();
    assert.equal(requests.at(-1), 'later'); assert.equal(chat.queued.length, 0);
});

test('regenerate answers again, branch copies the conversation, and history supports rename, search and delete', async t => {
    let count = 0;
    const chat = await fixture(t, async (_request, _tools, _signal, emit) => { emit({ delta: `answer ${++count}` }); });
    chat.session.update('draft', 'unsent draft');
    await chat.send('first question', { fromDraft: false }); await chat.send('second question', { fromDraft: false });
    const reply = chat.data.messages.at(-1);
    const { turn } = await chat.regenerate(reply.id); await turn;
    assert.deepEqual(chat.data.messages.map(message => message.content), ['first question', 'answer 1', 'second question', 'answer 3']);
    assert.equal(chat.session.state.draft, 'unsent draft');
    const original = chat.data.id;
    await chat.branch(chat.data.messages[1].id);
    assert.notEqual(chat.data.id, original);
    assert.deepEqual(chat.data.messages.map(message => message.content), ['first question', 'answer 1']);
    assert.match(chat.snapshot().title, /\(branch\)$/);
    await chat.send('branch question');
    await chat.rename(original, 'Renamed original');
    const listed = await chat.list();
    assert.ok(listed.some(item => item.id === original && item.title === 'Renamed original'));
    assert.deepEqual((await chat.list('second question')).map(item => item.id), [original]);
    assert.match((await chat.list('answer 3'))[0].snippet, /answer 3/);
    await chat.remove(original);
    assert.ok(!(await chat.list()).some(item => item.id === original));
    const branchId = chat.data.id; await chat.remove(branchId);
    assert.notEqual(chat.data.id, branchId); assert.equal(chat.data.messages.length, 0);
});

test('pasted images go with the next message only; a completed checklist ticks the brief', async t => {
    const requests = [];
    const chat = await fixture(t, async (request, tools, _signal, emit) => {
        requests.push(request);
        if (request.messages.at(-1).content === 'build') await tools.execute('todo_write', { todos: [{ content: 'Add the parser', status: 'completed' }, { content: 'Run tests', status: 'in_progress' }] });
        emit({ delta: 'seen' });
    });
    assert.throws(() => chat.addImage({ name: 'x.svg', mime: 'image/svg+xml', data: 'AAAA' }), /PNG, JPEG/);
    chat.addImage({ name: 'shot.png', mime: 'image/png', data: 'iVBORw0KGgo=' });
    assert.deepEqual(chat.snapshot().images.map(image => image.name), ['shot.png']);
    assert.ok(!('data' in chat.snapshot().images[0]));
    await chat.send('what is this?');
    assert.deepEqual(requests[0].images, [{ mime: 'image/png', data: 'iVBORw0KGgo=' }]);
    assert.equal(chat.data.messages[0].images[0].name, 'shot.png');
    await chat.send('and now?'); assert.equal(requests[1].images, undefined);
    chat.session.update('brief', '- [ ] Add the parser\n- [ ] Run tests');
    chat.session.update('mode', 'Plan');
    await chat.send('build');
    assert.equal(chat.session.state.brief, '- [x] Add the parser\n- [ ] Run tests');
});

test('provider token counts correct the context meter, and API-key replies are priced and logged', async t => {
    const chat = await fixture(t, async (_request, _tools, _signal, emit) => {
        emit({ delta: 'answer', usage: { input: 1000, output: 100 } });
        emit({ usage: { input: 1500, output: 50 }, limits: { tokens: { limit: 30000, remaining: 28000 } } });
    });
    chat.connections.models.push({ id: 'anthropic/claude-sonnet-5-5', name: 'Sonnet' }); chat.selectModel('anthropic/claude-sonnet-5-5');
    await chat.send('hello');
    const reply = chat.data.messages.at(-1);
    assert.deepEqual(reply.usage, { input: 1500, output: 150, billedInput: 2500, first: 1000 });
    // $2 / $10 per million: 2500 input + 150 output.
    assert.ok(Math.abs(reply.cost - (2500 * 2 + 150 * 10) / 1e6) < 1e-12);
    assert.ok(Math.abs(chat.snapshot().cost.total - reply.cost) < 1e-12);
    await until(() => chat.spend.summary().today.byProvider.anthropic > 0);
    assert.deepEqual(chat.snapshot().limits.anthropic.tokens, { limit: 30000, remaining: 28000 });
    // Calibrated from the first call (estimate vs measured), then from the provider's own count.
    assert.equal(chat.snapshot().usage.source, 'calibrated');
    chat.provider.count = async () => 4321;
    assert.equal(await chat.measure(), 4321);
    const usage = chat.snapshot().usage;
    assert.equal(usage.source, 'counted'); assert.equal(usage.used, 4321);
    // Plan and local models have no dollar cost.
    chat.selectModel('fixture/model'); await chat.send('again');
    assert.equal(chat.data.messages.at(-1).cost, undefined);
});

test('research sources keep stable citation keys; cited replies list them and approved plans gain a Sources list', async t => {
    const requests = [];
    const chat = await fixture(t, async (request, _tools, _signal, emit) => {
        requests.push(request);
        emit({ delta: 'Use the cache [S2], not polling [S1].' });
    });
    const add = (id, url) => chat.research.sources.sources.set(id, { id, url, title: `Title ${id}`, text: 'body', links: [], images: [], capturedAt: '', truncated: false });
    add('a', 'https://one.example/a'); add('b', 'https://two.example/b');
    chat.research.sources.shared.add('b');
    await chat.send('which?');
    assert.match(requests[0].context, /Shared research source \[S2\] \(untrusted reference; cite it as \[S2\]\)/); assert.doesNotMatch(requests[0].context, /\[S1\]/);
    const reply = chat.data.messages.at(-1);
    assert.deepEqual(reply.citations.map(item => [item.key, item.url]), [['S1', 'https://one.example/a'], ['S2', 'https://two.example/b']]);
    // Keys survive removing a source, and new sources get the next key.
    chat.research.sources.remove('a'); add('c', 'https://three.example/c');
    assert.deepEqual(chat.citationKeys(), { a: 'S1', b: 'S2', c: 'S3' });
    assert.equal(chat.citationsIn('see [S1]')[0].url, 'https://one.example/a');
    assert.equal(chat.withSourceList('- [ ] Add a cache [S2]'), '- [ ] Add a cache [S2]\n\n## Sources\n[S2]: https://two.example/b "Title b"\n');
    assert.equal(chat.withSourceList('no citations'), 'no citations');
});

test('the timeline lists turns with changes and branches; compare and review use the recorded changes; plan checks keep evidence', async t => {
    const { root, host } = await project(t);
    await fs.writeFile(path.join(root, 'a.txt'), 'one\n');
    let reviewRequest;
    const chat = await fixture(t, async (request, tools, _signal, emit) => {
        if (request.mode === 'discuss' && request.messages[0].id === 'review-instructions') { reviewRequest = request; emit({ delta: '- **high** a.txt:1 wrong value' }); return; }
        const text = request.messages.at(-1).content;
        if (text.startsWith('change')) {
            await tools.execute('read_file', { path: 'a.txt', offset: null, limit: null });
            await tools.execute('edit_file', { path: 'a.txt', old_string: text === 'change 1' ? 'one' : 'two', new_string: text === 'change 1' ? 'two' : 'three', replace_all: null });
        }
        emit({ delta: `done ${text}` });
    }, { root: () => root, toolHost: () => host, permission: () => 'full', trusted: () => true });
    chat.session.update('mode', 'Build');
    await chat.send('change 1'); await chat.send('just talk'); await chat.send('change 2');
    const first = chat.data.messages[0].id, reply = chat.data.messages[1];
    const original = chat.data.id;
    await chat.branch(reply.id); const branch = chat.data.id;
    await chat.switch(original);
    const timeline = await chat.timeline();
    assert.equal(timeline.points.length, 3);
    assert.deepEqual(timeline.points.map(point => [point.text, point.checkpoint, point.reply?.files]), [['change 1', true, ['a.txt']], ['just talk', false, []], ['change 2', true, ['a.txt']]]);
    assert.ok(timeline.points[0].at > 0);
    assert.deepEqual(timeline.points[0].branches.map(item => item.id), [branch]);
    const compared = await chat.compareFrom(first);
    assert.deepEqual(compared.map(entry => [entry.path, entry.before, entry.after]), [['a.txt', 'one\n', 'three\n']]);
    // A second model reviews the first reply's diff; its notes can go back to the agent.
    await chat.reviewChanges(reply.id);
    const reviewed = chat.data.messages.find(item => item.id === reply.id).review;
    assert.equal(reviewed.state, 'complete'); assert.match(reviewed.content, /wrong value/);
    assert.match(reviewRequest.messages[1].content, /-one\n\+two/);
    assert.deepEqual(reviewRequest.messages[1].content.match(/The user asked:\n(.*)/)[1], 'change 1');
    await assert.rejects(chat.reviewChanges(chat.data.messages[3].id), /no changes to review/);
    await chat.addressReview(reply.id);
    assert.match(chat.data.messages.at(-2).content, /A second model reviewed[\s\S]*wrong value/);
    // Plan steps: the user runs a check, or confirms a manual one; evidence is kept and ticks the step.
    chat.session.update('brief', '- [ ] Has three (check: `grep -q three a.txt`)\n- [ ] Looks right (check: manual: open it)\n- [ ] Has four (check: `grep -q four a.txt`)');
    await chat.checkStep('has three');
    await chat.checkStep('has four');
    await chat.confirmStep('looks right', true);
    const steps = chat.planSteps();
    assert.deepEqual(steps.map(step => [step.done, step.evidence?.status, step.evidence?.by]), [[true, 'passed', 'you'], [true, 'passed', 'you'], [false, 'failed', 'you']]);
    assert.match(chat.session.state.brief, /- \[x\] Has three/);
});

test('a Build reply that ticks its checklist without doing anything is sent back once, then flagged', async t => {
    const { root, host } = await project(t);
    const todos = [{ content: 'Create app.js', status: 'completed' }, { content: 'Test it', status: 'completed' }];
    const requests = [];
    let behaviour = 'lazy-then-work';
    const chat = await fixture(t, async (request, tools, _signal, emit) => {
        requests.push(request);
        const sentBack = /nothing has been done yet/.test(request.messages.at(-1).content);
        if (behaviour === 'works' || (behaviour === 'lazy-then-work' && sentBack)) await tools.execute('write_file', { path: 'app.js', content: 'console.log(1);\n' });
        await tools.execute('todo_write', { todos });
        emit({ delta: 'All steps completed.' });
    }, { root: () => root, toolHost: () => host, permission: () => 'full', trusted: () => true });
    chat.session.update('mode', 'Build');

    await chat.send('build the app');
    assert.equal(requests.length, 2, 'sent back once');
    assert.equal(requests[1].messages.at(-2).content, 'All steps completed.');
    assert.match(requests[1].messages.at(-1).content, /You marked 2 tasks completed/);
    let reply = chat.data.messages.at(-1);
    assert.equal(reply.unbacked, undefined);
    assert.equal(await fs.readFile(path.join(root, 'app.js'), 'utf8'), 'console.log(1);\n');
    assert.deepEqual(reply.changes.files.map(file => file.path), ['app.js']);

    behaviour = 'lazy'; requests.length = 0;
    await chat.send('build more');
    assert.equal(requests.length, 2, 'only one retry');
    reply = chat.data.messages.at(-1);
    assert.equal(reply.unbacked, 'unresolved'); assert.equal(reply.state, 'complete');

    behaviour = 'works'; requests.length = 0;
    await chat.send('build again');
    assert.equal(requests.length, 1, 'real work is not sent back');
    assert.equal(chat.data.messages.at(-1).unbacked, undefined);
});
