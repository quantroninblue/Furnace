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
    const waiting = () => chat.data.messages.at(-1).steps?.find(step => step.status === 'waiting');
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
