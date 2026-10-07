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
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const research = { sources: new ResearchSources('test'), resetScope: async () => research.sources.reset('next'), restore: () => {}, open: async () => {} };
    const adapter = { root: () => null, workspace: () => null, clear: () => {}, files: { pending: new Map() }, captureActive: () => ({ uri: 'untitled:test', text: '' }), ...extra };
    const chat = new Conversation({ directory, session: new ProductSession(), provider: { run, dispose: async () => {} }, research, adapter, ...options });
    chat.connections.models.push({ id: 'fixture/model', name: 'Fixture' }); chat.selectModel('fixture/model');
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
        else emit({ delta: 'ok '.repeat(200), usage: { input: 1234, output: 50 } });
    }, {}, { contextWindow: () => 12000 });
    for (let i = 0; i < 12; i++) await chat.send(`message ${i} ${'x'.repeat(3000)}`);
    const summaries = chat.data.messages.filter(message => message.kind === 'summary');
    assert.ok(summaries.length >= 1, 'a summary was inserted');
    assert.match(summaries[0].content, /SUMMARY/);
    const summaryRequest = requests.find(request => request.messages.at(-1).content.startsWith('Summarize our conversation'));
    assert.equal(summaryRequest.mode, 'discuss');
    const last = requests.at(-1);
    assert.equal(last.messages[0].kind, 'summary');
    assert.ok(!last.messages.some(message => message.content.startsWith('message 0 ')), 'condensed messages are no longer sent');
    assert.match(last.messages.at(-1).content, /^message 11 /);
    const usage = chat.snapshot().usage;
    assert.equal(usage.window, 12000); assert.ok(usage.used > 0 && usage.condensed >= 1);
    assert.deepEqual(chat.data.messages.findLast(message => message.role === 'assistant').usage, { input: 1234, output: 50 });
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
