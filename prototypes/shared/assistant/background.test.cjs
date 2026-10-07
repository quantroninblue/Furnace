'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { BackgroundTasks, repositoryOf } = require('./background.cjs');

const until = async check => { for (let i = 0; i < 500 && !check(); i++) await new Promise(r => setTimeout(r, 10)); assert.ok(check()); };
async function repository(t) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bg-repo-'))), storage = await fs.mkdtemp(path.join(os.tmpdir(), 'bg-store-'));
    t.after(async () => { await fs.rm(root, { recursive: true, force: true }); await fs.rm(storage, { recursive: true, force: true }); });
    const git = (...args) => execFileSync('git', args, { cwd: root, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).toString();
    git('init', '-q'); await fs.writeFile(path.join(root, 'a.txt'), 'one\ntwo\nthree\n'); await fs.writeFile(path.join(root, 'b.txt'), 'bee\n');
    git('add', '-A'); git('commit', '-qm', 'start');
    return { root, storage, git };
}

test('a background task works in its own worktree from the current project, then applies or discards', async t => {
    const { root, storage, git } = await repository(t);
    // Uncommitted and untracked work is visible to the task.
    await fs.writeFile(path.join(root, 'a.txt'), 'one\ntwo (edited)\nthree\n'); await fs.writeFile(path.join(root, 'notes.md'), 'draft\n');
    const seen = [], finished = [], asked = [];
    const provider = { run: async (request, tools, _signal, emit) => {
        seen.push(await tools.execute('read_file', { path: 'notes.md', offset: null, limit: null }));
        await tools.execute('read_file', { path: 'a.txt', offset: null, limit: null });
        await tools.execute('edit_file', { path: 'a.txt', old_string: 'three', new_string: 'three\nfour', replace_all: null });
        await tools.execute('write_file', { path: 'new.txt', content: 'brand new\n' });
        await tools.execute('delete_path', { path: 'b.txt', recursive: null });
        emit({ delta: `Done: ${request.messages.at(-1).content}` });
    }, dispose: async () => {} };
    const tasks = new BackgroundTasks({ directory: storage, provider, connections: () => ({ models: [{ id: 'fixture/model', name: 'F' }], connections: [] }),
        ui: { approval: async (_task, step) => { asked.push(step.title); return 'approve'; }, finished: task => finished.push(task.state) } });
    await tasks.load();
    const task = await tasks.start({ root, prompt: 'add four', model: 'fixture/model' });
    assert.notEqual(task.dir, root);
    await until(() => finished.length === 1);
    assert.deepEqual(finished, ['done']); assert.match(seen[0], /draft/);
    assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'one\ntwo (edited)\nthree\n', 'the project is untouched until Apply');
    const listed = tasks.list(root)[0];
    assert.equal(listed.state, 'done'); assert.match(listed.summary, /Done: add four/);
    assert.deepEqual(listed.files.map(file => [file.path, file.status]).sort(), [['a.txt', 'modified'], ['b.txt', 'deleted'], ['new.txt', 'added']]);
    const review = await tasks.review(task.id);
    const a = review.find(file => file.path === 'a.txt');
    assert.equal(a.before, 'one\ntwo (edited)\nthree\n'); assert.equal(a.after, 'one\ntwo (edited)\nthree\nfour\n');
    // The user edits elsewhere in the meantime: the patch still applies cleanly.
    await fs.writeFile(path.join(root, 'a.txt'), 'zero\none\ntwo (edited)\nthree\n');
    await tasks.apply(task.id);
    assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'zero\none\ntwo (edited)\nthree\nfour\n');
    assert.equal(await fs.readFile(path.join(root, 'new.txt'), 'utf8'), 'brand new\n');
    await assert.rejects(fs.stat(path.join(root, 'b.txt')));
    assert.equal(git('diff', '--cached', '--name-only'), '', 'a clean apply does not stage anything');
    await tasks.discard(task.id);
    await assert.rejects(fs.stat(task.dir)); assert.doesNotMatch(git('worktree', 'list'), new RegExp(path.basename(task.dir)));
    // Tasks are kept across restarts; a running one becomes interrupted.
    const again = new BackgroundTasks({ directory: storage, provider });
    assert.equal((await again.load())[0].state, 'applied');
});

test('conflicting project edits are reported before applying; merge applies with conflict markers', async t => {
    const { root, storage } = await repository(t);
    const provider = { run: async (_request, tools, _signal, emit) => {
        await tools.execute('read_file', { path: 'a.txt', offset: null, limit: null });
        await tools.execute('edit_file', { path: 'a.txt', old_string: 'two', new_string: 'TWO', replace_all: null }); emit({ delta: 'ok' });
    }, dispose: async () => {} };
    const done = [];
    const tasks = new BackgroundTasks({ directory: storage, provider, connections: () => ({ models: [{ id: 'm', name: 'M' }] }), ui: { finished: task => done.push(task) } });
    await tasks.load();
    const task = await tasks.start({ root, prompt: 'shout', model: 'm' });
    await until(() => done.length === 1);
    await fs.writeFile(path.join(root, 'a.txt'), 'one\n2\nthree\n');
    await assert.rejects(tasks.apply(task.id), error => error.conflicts?.[0] === 'a.txt');
    assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'one\n2\nthree\n');
    const merged = await tasks.apply(task.id, { merge: true });
    assert.deepEqual(merged.conflicted, ['a.txt']);
    assert.match(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), /<<<<<<<[\s\S]*TWO[\s\S]*>>>>>>>/);
    await tasks.discard(task.id);
});

test('background tasks need a Git repository with a commit', async t => {
    const plain = await fs.mkdtemp(path.join(os.tmpdir(), 'bg-plain-')); t.after(() => fs.rm(plain, { recursive: true, force: true }));
    await assert.rejects(repositoryOf(plain), /Git repository/);
    execFileSync('git', ['init', '-q'], { cwd: plain });
    await assert.rejects(repositoryOf(plain), /at least one commit/);
});
