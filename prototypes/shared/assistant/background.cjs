'use strict';
// Background tasks: a Build conversation that works in its own Git worktree, so the user keeps
// editing the project meanwhile. The worktree starts from the project as it is now (HEAD plus
// uncommitted and untracked files); when the task finishes the user reviews the result and
// applies it to the project as a patch, or discards the worktree.
const { randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { ProductSession } = require('../product-core.cjs');
const { ResearchSources } = require('../research-contract.cjs');
const { Conversation } = require('./conversation.cjs');

const MAX_RUNNING = 3, MAX_UNTRACKED = 500, MAX_FILE = 5 * 1024 * 1024;

function git(cwd, args, input) {
    return new Promise((resolve, reject) => {
        const child = execFile('git', ['-c', 'core.quotepath=off', ...args], { cwd, maxBuffer: 256 * 1024 * 1024, encoding: 'buffer', env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } }, (error, stdout, stderr) => {
            if (error) { error.message = String(stderr || error.message).trim().split('\n').slice(0, 6).join('\n'); error.stderr = String(stderr); reject(error); }
            else resolve(stdout);
        });
        if (input !== undefined) child.stdin.end(input);
    });
}
const lines = buffer => buffer.toString('utf8').split('\0').filter(Boolean);

/** Plain file-system tool host rooted at the worktree (no IDE documents are involved). */
class FsToolHost {
    constructor(root, sandbox) { this.root = root; this.trusted = true; this.sandbox = sandbox || null; }
    async read(file) {
        const info = await fs.stat(file);
        if (!info.isFile()) throw new Error(`${file} is not a file.`);
        if (info.size > MAX_FILE) throw new Error('The file is larger than 5 MB. Use grep, or read part of it with run_command.');
        const data = await fs.readFile(file);
        if (data.includes(0)) throw new Error('This is a binary file; it cannot be read as text.');
        return data.toString('utf8');
    }
    async kind(file) {
        try { const info = await fs.stat(file); return info.isDirectory() ? 'directory' : info.isFile() ? 'file' : null; }
        catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null; throw error; }
    }
    async list(directory) {
        return (await fs.readdir(directory, { withFileTypes: true })).map(entry => ({ name: entry.name, directory: entry.isDirectory() }))
            .sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
    }
    async write(file, text) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text); return ''; }
    async remove(file, recursive) { await fs.rm(file, { recursive }); }
    async move(from, to) { await fs.mkdir(path.dirname(to), { recursive: true }); await fs.rename(from, to); }
    async mkdir(directory) { await fs.mkdir(directory, { recursive: true }); }
}

/** The Git repository top level of a folder, or an explanation of why a task cannot start there. */
async function repositoryOf(root) {
    if (!root) throw new Error('Open a project folder to start a background task.');
    let top;
    try { top = (await git(root, ['rev-parse', '--show-toplevel'])).toString().trim(); }
    catch { throw new Error('Background tasks need the project to be a Git repository (run git init and make a first commit).'); }
    try { await git(root, ['rev-parse', '--verify', 'HEAD^{commit}']); }
    catch { throw new Error('Background tasks need at least one commit in this repository.'); }
    return await fs.realpath(top);
}

class BackgroundTasks {
    /**
     * ui: { approval(task, step) → Promise<'approve' | 'deny'>, finished(task) } (notifications in the IDE).
     * connections(): the current models, so a task can use the model the user chose.
     */
    constructor({ directory, provider, sandbox = () => null, ui, changed = () => {}, connections = () => ({ models: [], connections: [] }), environment = () => '' }) {
        this.directory = directory; this.provider = provider; this.sandbox = sandbox; this.ui = ui; this.changed = changed;
        this.connections = connections; this.environment = environment;
        this.tasks = []; this.live = new Map(); this.file = path.join(directory, 'tasks.json'); this.writes = Promise.resolve();
    }
    async load() {
        try { this.tasks = JSON.parse(await fs.readFile(this.file, 'utf8')).filter(task => task && typeof task.id === 'string'); } catch { this.tasks = []; }
        for (const task of this.tasks) if (task.state === 'running') { task.state = 'interrupted'; task.error = 'AI GUI closed while the task was running. Its worktree is kept; review or discard it.'; }
        await this.persist(); return this.tasks;
    }
    persist() {
        const data = JSON.stringify(this.tasks.slice(-50), null, 2);
        this.writes = this.writes.then(async () => { await fs.mkdir(this.directory, { recursive: true }); await fs.writeFile(this.file + '.tmp', data); await fs.rename(this.file + '.tmp', this.file); }).catch(() => {});
        return this.writes;
    }
    list(root) {
        return this.tasks.filter(task => !root || task.root === root).map(task => {
            const chat = this.live.get(task.id)?.chat, approvals = chat ? [...chat.approvals.values()].map(entry => ({ id: entry.step.id, title: entry.step.title })) : [];
            const reply = chat?.data.messages.findLast(message => message.role === 'assistant');
            return { ...task, approvals, activity: reply?.steps?.at(-1)?.title || '', summary: task.summary || (reply?.content || '').slice(0, 400) };
        }).reverse();
    }
    get(id) { const task = this.tasks.find(item => item.id === id); if (!task) throw new Error('That background task no longer exists.'); return task; }

    async start({ root, prompt, model, brief = '' }) {
        if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 20000) throw new Error('Describe the background task (up to 20,000 characters).');
        if (this.tasks.filter(task => task.state === 'running').length >= MAX_RUNNING) throw new Error(`At most ${MAX_RUNNING} background tasks run at once.`);
        const connections = this.connections();
        if (!connections.models?.some(item => item.id === model)) throw new Error('Open Connections and select a model first.');
        const repository = await repositoryOf(root), id = randomUUID(), dir = path.join(this.directory, 'worktrees', id.slice(0, 8));
        const subdir = path.relative(repository, await fs.realpath(root));
        await fs.mkdir(path.dirname(dir), { recursive: true });
        await git(repository, ['worktree', 'add', '--detach', dir, 'HEAD']);
        const task = { id, root, repository, dir, cwd: path.join(dir, subdir), prompt: prompt.trim(), title: prompt.trim().split('\n')[0].slice(0, 80), model, state: 'running', createdAt: Date.now(), files: [] };
        try {
            // Bring over what the user has not committed yet, so the task sees the project as it is.
            const diff = await git(repository, ['diff', '--binary', 'HEAD']);
            if (diff.length) await git(dir, ['apply', '--binary', '--whitespace=nowarn'], diff);
            const untracked = lines(await git(repository, ['ls-files', '--others', '--exclude-standard', '-z'])).slice(0, MAX_UNTRACKED);
            for (const file of untracked) {
                const from = path.join(repository, file), info = await fs.lstat(from).catch(() => null);
                if (!info?.isFile() || info.size > MAX_FILE) continue;
                await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true }); await fs.copyFile(from, path.join(dir, file));
            }
            await git(dir, ['add', '-A']);
            task.base = (await git(dir, ['write-tree'])).toString().trim();
        } catch (error) { await this.removeWorktree(task).catch(() => {}); throw new Error(`Could not prepare the worktree: ${error.message}`); }
        this.tasks.push(task); await this.persist();
        this.run(task, brief); return task;
    }
    conversation(task) {
        const session = new ProductSession({ mode: 'Build' });
        const research = { sources: new ResearchSources('background'), resetScope: async () => {}, restore: () => {}, open: async () => {} };
        const chat = new Conversation({ directory: path.join(this.directory, 'conversations'), session, research, provider: this.provider,
            adapter: { root: () => task.cwd, trusted: () => true, workspace: () => null, clear: () => {}, files: { pending: new Map() }, captureActive: () => null,
                permission: () => 'auto', toolHost: () => new FsToolHost(task.cwd, this.sandbox()),
                environment: () => `Background task in a separate Git worktree of ${task.root}: ${task.cwd}. The user is not watching: do not ask questions; make reasonable choices, finish the task, run the relevant tests, and end with a short summary of what changed and anything left to check. Do not commit. ${this.environment()}`.slice(0, 1000) },
            changed: () => this.notice(task) });
        chat.connections = this.connections(); chat.selectModel(task.model);
        return chat;
    }
    run(task, brief, text = task.prompt) {
        const chat = this.live.get(task.id)?.chat || this.conversation(task);
        if (brief) chat.session.update('brief', brief), chat.sharePlan = true;
        const entry = { chat, asked: new Set() }; this.live.set(task.id, entry);
        task.state = 'running'; delete task.error; task.endedAt = undefined; task.conversation = chat.data.id;
        entry.done = chat.send(text, { fromDraft: false }).catch(error => { chat.error = error.message; }).then(() => this.finish(task, chat));
        this.changed(); return entry.done;
    }
    /** Approvals become notifications; answered ones are forwarded to the task's conversation. */
    notice(task) {
        const entry = this.live.get(task.id);
        if (entry) for (const [id, approval] of entry.chat.approvals) {
            if (entry.asked.has(id)) continue;
            entry.asked.add(id);
            Promise.resolve(this.ui?.approval?.(task, approval.step)).then(decision => { if (entry.chat.approvals.has(id)) entry.chat.decide(id, decision === 'approve' ? 'approve' : 'deny'); }, () => {});
        }
        this.changed();
    }
    async finish(task, chat) {
        const reply = chat.data.messages.findLast(message => message.role === 'assistant');
        task.state = task.state === 'stopping' || reply?.state === 'stopped' ? 'stopped' : reply?.state === 'complete' ? 'done' : 'failed';
        if (task.state === 'failed') task.error = reply?.error || chat.error || 'The task did not finish.';
        task.summary = (reply?.content || '').slice(0, 2000); task.endedAt = Date.now();
        task.cost = reply?.cost;
        try { task.files = await this.changedFiles(task); } catch (error) { task.error = `Could not read the worktree: ${error.message}`; }
        await this.persist(); this.changed();
        if (this.live.get(task.id)?.chat === chat) this.ui?.finished?.(task);
    }
    /** Paths changed in the worktree since it started: [{ path, status: added | modified | deleted }]. */
    async changedFiles(task) {
        await git(task.dir, ['add', '-A']);
        const fields = lines(await git(task.dir, ['diff', '--cached', '--name-status', '-z', '--no-renames', task.base])), files = [];
        for (let index = 0; index + 1 < fields.length; index += 2) files.push({ path: fields[index + 1], status: { A: 'added', D: 'deleted' }[fields[index][0]] || 'modified' });
        return files;
    }
    /** Before (at the start of the task) and after (in the worktree) for review. */
    async review(id) {
        const task = this.get(id); task.files = await this.changedFiles(task);
        return Promise.all(task.files.map(async file => ({ ...file, file: path.join(task.dir, file.path),
            before: file.status === 'added' ? '' : (await git(task.dir, ['show', `${task.base}:${file.path}`]).catch(() => Buffer.from(''))).toString('utf8'),
            after: file.status === 'deleted' ? null : await fs.readFile(path.join(task.dir, file.path), 'utf8').catch(() => '') })));
    }
    /** Applies the task's changes to the project's working tree (nothing is staged). If the user
     * changed the same places meanwhile, nothing is applied unless merge = true: then each file is
     * merged and overlapping edits get conflict markers (task.conflicted lists those files). */
    async apply(id, { merge = false } = {}) {
        const task = this.get(id);
        if (task.state === 'running' || task.state === 'stopping') throw new Error('Wait for the task to finish, or stop it first.');
        if (task.removed) throw new Error('This task was discarded.');
        task.files = await this.changedFiles(task);
        if (!task.files.length) throw new Error('The task changed no files.');
        const patch = await git(task.dir, ['diff', '--cached', '--binary', '--no-renames', task.base]);
        try { await git(task.repository, ['apply', '--check', '--binary', '--whitespace=nowarn'], patch); }
        catch {
            // The project changed since the task started: merge each file; overlapping edits need the user's go-ahead.
            const plan = await this.merge(task);
            if (plan.conflicted.length && !merge) { const conflict = new Error(`The project changed in the same places since the task started: ${plan.conflicted.join(', ')}`); conflict.conflicts = plan.conflicted; throw conflict; }
            for (const write of plan.writes) { if (write.data === null) await fs.rm(write.target, { force: true }); else { await fs.mkdir(path.dirname(write.target), { recursive: true }); await fs.writeFile(write.target, write.data); } }
            task.conflicted = plan.conflicted; task.state = 'applied'; await this.persist(); this.changed(); return task;
        }
        await git(task.repository, ['apply', '--binary', '--whitespace=nowarn'], patch);
        task.conflicted = []; task.state = 'applied'; await this.persist(); this.changed(); return task;
    }
    // Three-way merge per file: the task's starting content is the common base.
    async merge(task) {
        const conflicted = [], writes = [], scratch = await fs.mkdtemp(path.join(this.directory, 'merge-'));
        try {
            for (const file of task.files) {
                const target = path.join(task.repository, file.path), theirs = path.join(task.dir, file.path);
                const base = file.status === 'added' ? Buffer.from('') : await git(task.dir, ['show', `${task.base}:${file.path}`]);
                const ours = await fs.readFile(target).catch(() => null);
                if (file.status === 'deleted') {
                    if (ours === null) continue;
                    if (ours.equals(base)) writes.push({ target, data: null }); else conflicted.push(file.path);
                    continue;
                }
                const result = await fs.readFile(theirs);
                if (ours === null || ours.equals(base)) { writes.push({ target, data: result }); continue; }
                if (ours.equals(result)) continue;
                const basePath = path.join(scratch, 'base'), theirsPath = path.join(scratch, 'theirs');
                await fs.writeFile(basePath, base); await fs.writeFile(theirsPath, result);
                const merged = await new Promise(resolve => execFile('git', ['merge-file', '-p', '-L', 'project', '-L', 'task start', '-L', 'background task', target, basePath, theirsPath],
                    { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => resolve(error && !(error.code > 0 && error.code < 128) ? null : { stdout, clean: !error })));
                if (!merged) { conflicted.push(file.path); continue; }
                writes.push({ target, data: merged.stdout });
                if (!merged.clean) conflicted.push(file.path);
            }
        } finally { await fs.rm(scratch, { recursive: true, force: true }); }
        return { writes, conflicted };
    }
    async discard(id) {
        const task = this.get(id);
        await this.stop(id); await this.removeWorktree(task);
        task.state = task.state === 'applied' ? 'applied' : 'discarded'; task.removed = true;
        this.live.delete(id); await this.persist(); this.changed(); return task;
    }
    async removeWorktree(task) {
        await git(task.repository, ['worktree', 'remove', '--force', task.dir]).catch(() => fs.rm(task.dir, { recursive: true, force: true }));
        await git(task.repository, ['worktree', 'prune']).catch(() => {});
    }
    async stop(id) {
        const entry = this.live.get(id), task = this.get(id);
        if (!entry || task.state !== 'running') return;
        task.state = 'stopping'; await entry.chat.stop(); await entry.done;
    }
    /** Sends another message to a finished task (it keeps its worktree and conversation). */
    async followUp(id, text) {
        const task = this.get(id);
        if (task.removed) throw new Error('This task was discarded.');
        if (task.state === 'running') throw new Error('The task is still working.');
        if (!this.live.get(id)) { const chat = this.conversation(task); if (task.conversation) await chat.switch(task.conversation).catch(() => {}); chat.selectModel(task.model); this.live.set(id, { chat, asked: new Set() }); }
        return this.run(task, '', text);
    }
    async dispose() { for (const id of this.live.keys()) await this.stop(id).catch(() => {}); await this.writes; }
}
module.exports = { BackgroundTasks, FsToolHost, repositoryOf };
