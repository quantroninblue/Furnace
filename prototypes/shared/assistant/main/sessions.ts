import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Session, SessionSummary } from '../shared/types';

const MAX_SESSION = 4 * 1024 * 1024;
export class Sessions {
    private active: Session;
    private root: string | null = null;
    private queue = Promise.resolve();
    constructor(
        private directory: string,
        private legacyDirectory: string,
    ) {
        this.active = this.blank();
    }
    private blank(): Session {
        const now = new Date().toISOString();
        return {
            id: randomUUID(),
            title: 'New conversation',
            createdAt: now,
            updatedAt: now,
            projectRoot: this.root,
            messages: [],
            model: '',
            plan: '',
            sources: [],
        };
    }
    private file(id: string) {
        if (!/^[a-zA-Z0-9-]{1,100}$/.test(id)) throw new Error('Invalid session ID.');
        return path.join(this.directory, `${id}.json`);
    }
    current() {
        return this.active;
    }
    start(root: string | null) {
        this.root = root;
        this.active = this.blank();
        return this.active;
    }
    private valid(data: Session) {
        if (
            !data ||
            !Array.isArray(data.messages) ||
            typeof data.model !== 'string' ||
            typeof data.plan !== 'string' ||
            data.messages.some(
                m =>
                    !m ||
                    !['user', 'assistant'].includes(m.role) ||
                    typeof m.id !== 'string' ||
                    typeof m.content !== 'string',
            )
        )
            throw new Error('Invalid session data.');
    }
    async write(data: Session, root: string | null) {
        if (!data || data.id !== this.active.id || root !== this.root)
            throw new Error('Session changed before saving. Previous data was not overwritten.');
        this.valid(data);
        const first = data.messages.find(m => m.role === 'user' && !m.kind)?.content.split('\n')[0];
        const saved: Session = {
            ...data,
            id: this.active.id,
            projectRoot: root,
            createdAt: this.active.createdAt,
            updatedAt: new Date().toISOString(),
            title: data.customTitle || first?.slice(0, 90) || 'Planning conversation',
        };
        const content = JSON.stringify(saved);
        if (Buffer.byteLength(content) > MAX_SESSION) throw new Error('Session exceeds the 4 MB draft limit.');
        const file = this.file(saved.id);
        const write = async () => {
            await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
            const temp = `${file}.${randomUUID()}.tmp`;
            try {
                await fs.writeFile(temp, content, { mode: 0o600 });
                await fs.rename(temp, file);
                // Only a successful disk write advances the last saved state. A queued
                // save may finish after New chat, so it must not replace that session.
                if (this.active.id === saved.id && this.root === root) this.active = JSON.parse(content) as Session;
            } finally {
                await fs.rm(temp, { force: true });
            }
        };
        const pending = this.queue.then(write);
        this.queue = pending.catch(() => {});
        await pending;
    }
    private async read(id: string) {
        const file = this.file(id);
        if ((await fs.stat(file)).size > MAX_SESSION) throw new Error('Saved session is too large.');
        const data = JSON.parse(await fs.readFile(file, 'utf8')) as Session;
        this.valid(data);
        if (data.id !== id) throw new Error('Invalid session identity.');
        return data;
    }
    async resume(id: string, root: string | null) {
        await this.queue;
        const saved = await this.read(id);
        if (saved.projectRoot !== root) throw new Error("Open this session's project before resuming it.");
        this.root = root;
        this.active = saved;
        return saved;
    }
    /** Starts a new active session holding a copy of `messages` from `source` (a branch). */
    branch(source: Session, messages: Session['messages'], root: string | null) {
        this.root = root;
        this.active = {
            ...this.blank(),
            model: source.model,
            plan: source.plan,
            sources: source.sources,
            messages,
            evidence: source.evidence,
            citations: source.citations,
            branchOf: source.id,
            branchAt: messages.at(-1)?.id,
            customTitle: `${(source.customTitle || source.title || 'Conversation').slice(0, 80)} (branch)`,
        };
        return this.active;
    }
    /** Renames a saved conversation that is not the active one (the active one saves its own title). */
    async rename(id: string, title: string) {
        await this.queue;
        const saved = await this.read(id);
        saved.customTitle = title;
        saved.title = title;
        const file = this.file(id),
            temp = `${file}.${randomUUID()}.tmp`;
        try {
            await fs.writeFile(temp, JSON.stringify(saved), { mode: 0o600 });
            await fs.rename(temp, file);
        } finally {
            await fs.rm(temp, { force: true });
        }
    }
    async remove(id: string) {
        if (id === this.active.id) throw new Error('Switch to another conversation before deleting this one.');
        await this.queue;
        await fs.rm(this.file(id), { force: true });
    }
    /** Conversations for this project whose title or messages contain the query, newest first. */
    async search(root: string | null, query: string): Promise<SessionSummary[]> {
        const needle = query.trim().toLowerCase();
        const all = await this.list(root);
        if (!needle) return all;
        const found: SessionSummary[] = [];
        for (const summary of all) {
            if (summary.title.toLowerCase().includes(needle)) {
                found.push(summary);
                continue;
            }
            try {
                const saved = await this.read(summary.id);
                const message = saved.messages.find(item => item.content.toLowerCase().includes(needle));
                if (!message) continue;
                const at = message.content.toLowerCase().indexOf(needle),
                    start = Math.max(0, at - 40);
                found.push({
                    ...summary,
                    snippet: `${start ? '…' : ''}${message.content.slice(start, at + needle.length + 60).replace(/\s+/g, ' ')}…`,
                });
            } catch {
                /* Skip unreadable history. */
            }
        }
        return found;
    }
    async list(root: string | null): Promise<SessionSummary[]> {
        await this.queue;
        await this.migrate(root);
        let files: string[];
        try {
            files = await fs.readdir(this.directory);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
            throw error;
        }
        const sessions: SessionSummary[] = [];
        for (const file of files.filter(file => file.endsWith('.json'))) {
            try {
                const saved = await this.read(file.slice(0, -5));
                if (saved.projectRoot === root)
                    sessions.push({
                        id: saved.id,
                        title: saved.title,
                        createdAt: saved.createdAt,
                        updatedAt: saved.updatedAt,
                        projectRoot: root,
                        model: saved.model,
                        messageCount: saved.messages.length,
                        ...(saved.branchOf ? { branchOf: saved.branchOf, branchAt: saved.branchAt } : {}),
                    });
            } catch {
                /* One damaged history file must not hide the rest. */
            }
        }
        return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }
    private async migrate(root: string | null) {
        const legacyKey = root ? createHash('sha256').update(root).digest('hex') : 'quick-chat';
        const legacyPath = path.join(this.legacyDirectory, `${legacyKey}.json`);
        const id = `legacy-${legacyKey}`;
        try {
            await fs.access(this.file(id));
            return;
        } catch {
            /* Check old layout. */
        }
        try {
            const stat = await fs.stat(legacyPath);
            if (stat.size > MAX_SESSION) return;
            const old = JSON.parse(await fs.readFile(legacyPath, 'utf8'));
            this.valid(old);
            const saved = {
                ...old,
                id,
                projectRoot: root,
                title:
                    old.messages.find((m: any) => m.role === 'user')?.content.slice(0, 90) ||
                    'Previous workspace conversation',
                createdAt: stat.birthtime.toISOString(),
                updatedAt: stat.mtime.toISOString(),
            };
            await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
            await fs.writeFile(this.file(id), JSON.stringify(saved), { mode: 0o600, flag: 'wx' });
        } catch (error) {
            if (!['ENOENT', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        }
    }
}
