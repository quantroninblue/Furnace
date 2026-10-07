'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ProductSession } = require('../product-core.cjs');
const { ResearchSources } = require('../research-contract.cjs');
const { Conversation } = require('./conversation.cjs');
async function fixture(t, run, extra = {}) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'conversation-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const research = { sources: new ResearchSources('test'), resetScope: async () => research.sources.reset('next'), restore: () => {}, open: async () => {} };
    const provider = { run, dispose: async () => {} };
    const adapter = { root: () => null, workspace: () => null, clear: () => {}, files: { pending: new Map() }, captureActive: () => ({ uri: 'untitled:test', text: 'unsaved current text' }), ...extra };
    const chat = new Conversation({ directory, session: new ProductSession(), provider, research, adapter });
    chat.connections.models.push({ id: 'fixture/model', name: 'Fixture' }); chat.selectModel('fixture/model');
    return chat;
}
test('context sharing is explicit, uses current unsaved contents and tools enforce Discuss mode', async t => {
    const requests = [];
    const chat = await fixture(t, async (request, tools, _signal, emit) => {
        requests.push(request); assert.equal(tools.definitions.length, 0);
        await assert.rejects(tools.execute('read_file', { path: 'secret', offset: null, limit: null }), /not available in discuss mode/);
        emit({ delta: 'reply' });
    });
    chat.session.update('brief', 'private planning text');
    await chat.send('hello'); assert.equal(requests[0].context, '');
    chat.sharePlan = true; chat.shareEditor = true; await chat.send('include it');
    assert.match(requests[1].context, /unsaved current text/); assert.match(requests[1].context, /private planning text/);
    assert.equal(chat.data.messages.at(-1).state, 'complete');
});
test('switch stops an in-flight turn, persists partial output and expires proposals before resume', async t => {
    let started;
    const ready = new Promise(resolve => started = resolve);
    const chat = await fixture(t, async (_request, _tools, signal, emit) => {
        emit({ delta: 'Partial reply' }); started();
        await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true }));
    });
    const id = chat.data.id, turn = chat.send('wait'); await ready;
    await chat.switch(); await turn; assert.equal(chat.data.messages.length, 0);
    await chat.switch(id); assert.equal(chat.data.messages.at(-1).content, 'Partial reply'); assert.equal(chat.data.messages.at(-1).state, 'stopped');
    assert.equal(chat.shareEditor, false); assert.equal(chat.proposals.size, 0);
});
test('plan suggestions require explicit application; stale IDs cannot apply across sessions', async t => {
    const chat = await fixture(t, async (_request, tools) => { await tools.execute('plan_propose', { text: 'Proposed plan', reason: 'explanation' }); });
    chat.session.update('mode', 'Plan'); await chat.send('plan');
    assert.equal(chat.session.state.brief, '');
    const proposal = [...chat.proposals.values()][0]; await chat.approve(proposal.id); assert.equal(chat.session.state.brief, 'Proposed plan');
    await assert.rejects(chat.approve(proposal.id), /expired/);
    await chat.switch(); await assert.rejects(chat.approve(proposal.id), /expired/);
});
test('a failed save blocks switching and provider execution, preserving the unsaved conversation', async t => {
    let requests = 0;
    const chat = await fixture(t, async () => { requests++; });
    chat.session.update('brief', 'Important unsaved brief');
    const id = chat.data.id;
    chat.storage.write = async () => { throw new Error('disk full'); };
    await assert.rejects(chat.switch(), /Could not save/); assert.equal(chat.data.id, id);
    await chat.send('Do not send if saving fails'); assert.equal(requests, 0); assert.equal(chat.turn, undefined);
    assert.match(chat.snapshot().error, /Could not save/);
});

test('agent approvals wait for the user, honour "always" for the chat and are denied on Stop', async t => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'approvals-'))); t.after(() => fs.rm(root, { recursive: true, force: true }));
    const host = { root, trusted: true, sandbox: null, kind: async file => { try { return (await fs.stat(file)).isDirectory() ? 'directory' : 'file'; } catch { return null; } }, mkdir: dir => fs.mkdir(dir, { recursive: true }) };
    const chat = await fixture(t, async (request, tools, _signal, emit) => {
        assert.equal(request.permission, 'ask');
        for (const name of request.messages.at(-1).content.split(' ')) {
            try { emit({ delta: await tools.execute('create_directory', { path: name }) }); }
            catch (error) { emit({ delta: error.message }); }
        }
    }, { permission: () => 'ask', toolHost: () => host });
    chat.session.update('mode', 'Build');
    const waiting = () => chat.data.messages.at(-1)?.steps?.find(step => step.status === 'waiting');
    const until = async check => { for (let i = 0; i < 200 && !check(); i++) await new Promise(r => setTimeout(r, 10)); assert.ok(check()); };
    let turn = chat.send('one two three');
    await until(waiting); chat.decide(waiting().id, 'approve');
    await until(() => waiting()?.title.includes('two')); chat.decide(waiting().id, 'deny');
    await until(() => waiting()?.title.includes('three')); chat.decide(waiting().id, 'always');
    await turn;
    assert.deepEqual(chat.data.messages.at(-1).steps.map(step => step.status), ['done', 'denied', 'done']);
    await assert.rejects(fs.stat(path.join(root, 'two'))); await fs.stat(path.join(root, 'three'));
    assert.deepEqual(chat.snapshot().grants, ['edit']);
    await chat.send('four'); // Granted for this chat: no prompt.
    assert.equal(chat.data.messages.at(-1).steps[0].status, 'done');
    chat.grants.clear(); turn = chat.send('five');
    await until(waiting); await chat.stop(); await turn;
    assert.equal(chat.data.messages.at(-1).state, 'stopped');
    await assert.rejects(fs.stat(path.join(root, 'five')));
    assert.equal(chat.approvals.size, 0);
});

test('each reply checkpoints its file changes; files revert per reply and rewind restores files and history', async t => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'checkpoint-chat-'))); t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.writeFile(path.join(root, 'app.txt'), 'original\n');
    const host = { root, trusted: true, sandbox: null,
        read: async file => fs.readFile(file, 'utf8'), kind: async file => { try { return (await fs.stat(file)).isDirectory() ? 'directory' : 'file'; } catch { return null; } },
        list: async dir => (await fs.readdir(dir, { withFileTypes: true })).map(entry => ({ name: entry.name, directory: entry.isDirectory() })),
        write: async (file, text) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text); return ''; },
        remove: (file, recursive) => fs.rm(file, { recursive }), move: (from, to) => fs.rename(from, to), mkdir: dir => fs.mkdir(dir, { recursive: true }) };
    const chat = await fixture(t, async (request, tools) => {
        const [file, text] = request.messages.at(-1).content.split('=');
        await tools.execute('read_file', { path: file, offset: null, limit: null }).catch(() => {});
        await tools.execute('write_file', { path: file, content: text + '\n' });
    }, { root: () => root, permission: () => 'auto', toolHost: () => host });
    chat.session.update('mode', 'Build');
    await chat.send('notes.txt=first');
    await chat.send('notes.txt=second');
    await chat.send('extra.txt=third');
    const replies = chat.data.messages.filter(item => item.role === 'assistant');
    assert.deepEqual(replies.map(item => item.changes.files.map(file => `${file.status} ${file.path}`)), [['added notes.txt'], ['modified notes.txt'], ['added extra.txt']]);
    assert.ok(replies.every(item => item.endedAt >= item.startedAt));
    // The user edits a file the agent wrote: reverting it needs explicit confirmation.
    await fs.writeFile(path.join(root, 'extra.txt'), 'user change\n');
    await assert.rejects(chat.revert(replies[2].id), error => error.conflicts?.[0] === 'extra.txt');
    assert.equal(await fs.readFile(path.join(root, 'extra.txt'), 'utf8'), 'user change\n');
    await chat.revert(replies[2].id, null, true);
    await assert.rejects(fs.stat(path.join(root, 'extra.txt')));
    assert.equal(chat.data.messages.find(item => item.id === replies[2].id).changes.files[0].reverted, true);
    assert.match(chat.data.messages.at(-1).content, /User reverted 1 file/);
    // Rewinding to the second request restores notes.txt to the first reply's content.
    const second = chat.data.messages.find(item => item.content === 'notes.txt=second');
    await chat.rewind(second.id);
    assert.equal(await fs.readFile(path.join(root, 'notes.txt'), 'utf8'), 'first\n');
    assert.equal(chat.data.messages.at(-1).id, replies[0].id);
    assert.equal(chat.session.state.draft, 'notes.txt=second');
    await chat.rewind(chat.data.messages[0].id);
    await assert.rejects(fs.stat(path.join(root, 'notes.txt')));
    assert.equal(chat.data.messages.length, 0);
    assert.equal(await fs.readFile(path.join(root, 'app.txt'), 'utf8'), 'original\n');
});
