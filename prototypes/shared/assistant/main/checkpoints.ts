import path from 'node:path';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { ToolHost } from './agent-tools';
import { diffStats } from './diff';

// Turn checkpoints: the first time a turn touches a path, its prior content is kept, so the
// user can revert one file, a whole turn, or rewind several turns. Command side effects are
// not tracked (run_command may change files outside these records).
export type FileChange = {
    file: string;
    path: string;
    /** Content before the turn (null: did not exist) and after the agent's last change. */
    before: string | null;
    after: string | null;
    /** False when the prior content could not be kept (binary, too large, too many files). */
    restorable: boolean;
    reverted?: boolean;
    /** Set once a change actually happened (a failed write leaves it unset). */
    touched?: boolean;
};
export type ChangeSummary = {
    path: string;
    status: 'added' | 'modified' | 'deleted';
    added: number;
    removed: number;
    restorable: boolean;
    reverted?: boolean;
};
export type Checkpoint = { files: FileChange[]; directories: string[] };

const FILE_LIMIT = 5 * 1024 * 1024,
    TURN_LIMIT = 48 * 1024 * 1024,
    TREE_LIMIT = 500;

export class TurnChanges {
    readonly files = new Map<string, FileChange>();
    /** Folders the agent created, deepest last; removed on restore when empty. */
    readonly directories: string[] = [];
    private bytes = 0;
    constructor(
        private display: (file: string) => string,
        private changed: () => void = () => {},
    ) {}

    private keep(text: string | null) {
        if (text === null) return true;
        if (text.length > FILE_LIMIT || this.bytes + text.length > TURN_LIMIT) return false;
        this.bytes += text.length;
        return true;
    }
    /** Records the current state of a file the first time this turn changes it. */
    async capture(host: ToolHost, file: string): Promise<FileChange> {
        const known = this.files.get(file);
        if (known) return known;
        const kind = await host.kind(file);
        let before: string | null = null,
            restorable = kind !== 'directory';
        if (kind === 'file') {
            try {
                before = await host.read(file);
            } catch {
                restorable = false;
            }
            if (restorable && !this.keep(before)) {
                before = null;
                restorable = false;
            }
        }
        const entry: FileChange = { file, path: this.display(file), before, after: before, restorable };
        this.files.set(file, entry);
        return entry;
    }
    /** Every file below a path (or the file itself), for deletes and moves. */
    async captureTree(host: ToolHost, target: string): Promise<FileChange[]> {
        if ((await host.kind(target)) !== 'directory') return [await this.capture(host, target)];
        const found: string[] = [];
        const walk = async (directory: string) => {
            for (const entry of await host.list(directory)) {
                if (found.length > TREE_LIMIT) return;
                const child = path.join(directory, entry.name);
                if (entry.directory) await walk(child);
                else found.push(child);
            }
        };
        await walk(target);
        if (found.length > TREE_LIMIT) {
            // Too large to keep: one marker that this folder's contents cannot be restored.
            const entry: FileChange = {
                file: target,
                path: this.display(target) + '/',
                before: null,
                after: null,
                restorable: false,
            };
            this.files.set(target, entry);
            return [entry];
        }
        const entries: FileChange[] = [];
        for (const file of found) entries.push(await this.capture(host, file));
        return entries;
    }
    async noteDirectories(host: ToolHost, directory: string) {
        const missing: string[] = [];
        for (let current = directory; !(await host.kind(current)); current = path.dirname(current)) {
            missing.unshift(current);
            if (path.dirname(current) === current) break;
        }
        for (const item of missing) if (!this.directories.includes(item)) this.directories.push(item);
    }
    record(entry: FileChange, after: string | null) {
        if (entry.restorable && after !== null && after !== entry.after && !this.keep(after)) entry.restorable = false;
        entry.after = after;
        entry.touched = true;
        this.changed();
    }
    summary(): ChangeSummary[] {
        return summarize([...this.files.values()]);
    }
    checkpoint(): Checkpoint {
        return { files: [...this.files.values()], directories: [...this.directories] };
    }
    get size() {
        return this.summary().length;
    }
}

const changedEntry = (entry: FileChange) => !!entry.touched && (!entry.restorable || entry.before !== entry.after);
export function summarize(files: FileChange[]): ChangeSummary[] {
    return files.filter(changedEntry).map(entry => {
        const stats = entry.restorable ? diffStats(entry.before ?? '', entry.after ?? '') : { added: 0, removed: 0 };
        return {
            path: entry.path,
            status:
                entry.before === null && entry.after !== null ? 'added' : entry.after === null ? 'deleted' : 'modified',
            ...stats,
            restorable: entry.restorable,
            ...(entry.reverted ? { reverted: true } : {}),
        };
    });
}

/** A ToolHost that records each change's prior state before passing it on. */
export function recordingHost(host: ToolHost, changes: TurnChanges): ToolHost {
    return {
        root: host.root,
        trusted: host.trusted,
        sandbox: host.sandbox,
        code: host.code,
        read: file => host.read(file),
        kind: file => host.kind(file),
        list: directory => host.list(directory),
        async write(file, text) {
            const entry = await changes.capture(host, file);
            await changes.noteDirectories(host, path.dirname(file));
            const note = await host.write(file, text);
            changes.record(entry, text);
            return note;
        },
        async remove(file, recursive) {
            const entries = await changes.captureTree(host, file);
            await host.remove(file, recursive);
            for (const entry of entries) changes.record(entry, null);
        },
        async move(from, to) {
            const folder = (await host.kind(from)) === 'directory';
            const sources = await changes.captureTree(host, from);
            // Content that could not be kept is reported as a non-restorable removal only.
            const targets: [FileChange, FileChange | null][] = [];
            for (const source of sources) {
                const target = source.file === from ? to : path.join(to, path.relative(from, source.file));
                targets.push([source, source.restorable ? await changes.capture(host, target) : null]);
            }
            await changes.noteDirectories(host, folder ? to : path.dirname(to));
            await host.move(from, to);
            for (const [source, target] of targets) {
                const content = source.after;
                changes.record(source, null);
                if (target) changes.record(target, content);
            }
        },
        async mkdir(directory) {
            await changes.noteDirectories(host, directory);
            await host.mkdir(directory);
        },
    };
}

/** Combines several turns' records (oldest first) into one per file: earliest before, latest after. */
export function mergeCheckpoints(checkpoints: Checkpoint[]): Checkpoint {
    const files = new Map<string, FileChange>(),
        directories: string[] = [];
    for (const checkpoint of checkpoints) {
        for (const entry of checkpoint.files) {
            if (entry.reverted) continue;
            const known = files.get(entry.file);
            if (!known) files.set(entry.file, { ...entry });
            else {
                known.after = entry.after;
                known.restorable &&= entry.restorable;
                known.touched ||= entry.touched;
            }
        }
        for (const directory of checkpoint.directories)
            if (!directories.includes(directory)) directories.push(directory);
    }
    return { files: [...files.values()], directories };
}

async function current(host: ToolHost, file: string): Promise<string | null | undefined> {
    try {
        const kind = await host.kind(file);
        return kind === 'file' ? await host.read(file) : kind === null ? null : undefined;
    } catch {
        return undefined;
    }
}

export type RestoreResult = { conflicts: string[]; restored: string[]; skipped: string[] };
/**
 * Puts files back to their recorded prior state. A file whose current content differs from
 * what the agent left (edited since, or changed by a command) is a conflict: nothing is
 * changed unless `force` is set.
 */
export async function restoreChanges(host: ToolHost, checkpoint: Checkpoint, force = false): Promise<RestoreResult> {
    const result: RestoreResult = { conflicts: [], restored: [], skipped: [] };
    const entries = checkpoint.files.filter(entry => !entry.reverted && changedEntry(entry));
    const work: FileChange[] = [];
    for (const entry of entries) {
        if (!entry.restorable) {
            result.skipped.push(entry.path);
            continue;
        }
        if ((await current(host, entry.file)) !== entry.after) result.conflicts.push(entry.path);
        work.push(entry);
    }
    if (result.conflicts.length && !force) return result;
    // Remove files the agent created before restoring others, so moves back cannot collide.
    for (const entry of work.filter(item => item.before === null)) {
        if ((await host.kind(entry.file)) === 'file') await host.remove(entry.file, false);
        entry.reverted = true;
        result.restored.push(entry.path);
    }
    for (const entry of work.filter(item => item.before !== null)) {
        if ((await host.kind(entry.file)) === 'directory') {
            result.skipped.push(entry.path);
            continue;
        }
        await host.write(entry.file, entry.before!);
        entry.reverted = true;
        result.restored.push(entry.path);
    }
    // Folders the agent created go too, but only while they hold no files at all.
    const empty = async (directory: string): Promise<boolean> => {
        for (const entry of await host.list(directory))
            if (!entry.directory || !(await empty(path.join(directory, entry.name)))) return false;
        return true;
    };
    for (const directory of [...checkpoint.directories].reverse()) {
        try {
            if ((await host.kind(directory)) === 'directory' && (await empty(directory)))
                await host.remove(directory, true);
        } catch {
            /* A folder that cannot be removed is left in place. */
        }
    }
    return result;
}

/** Checkpoint files, one per assistant reply, beside the conversation history. */
export class Checkpoints {
    constructor(
        private directory: string,
        private keep = 60,
    ) {}
    private file(session: string, turn: string) {
        if (![session, turn].every(id => /^[a-zA-Z0-9-]{1,100}$/.test(id))) throw new Error('Invalid checkpoint ID.');
        return path.join(this.directory, session, `${turn}.json`);
    }
    async save(session: string, turn: string, checkpoint: Checkpoint) {
        const file = this.file(session, turn),
            temp = `${file}.${randomUUID()}.tmp`;
        await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        try {
            await fs.writeFile(temp, JSON.stringify(checkpoint), { mode: 0o600 });
            await fs.rename(temp, file);
        } finally {
            await fs.rm(temp, { force: true });
        }
        await this.prune(session);
    }
    async load(session: string, turn: string): Promise<Checkpoint> {
        try {
            return JSON.parse(await fs.readFile(this.file(session, turn), 'utf8')) as Checkpoint;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT')
                throw new Error('This checkpoint is no longer available.');
            throw error;
        }
    }
    async remove(session: string, turn: string) {
        await fs.rm(this.file(session, turn), { force: true });
    }
    async removeSession(session: string) {
        await fs.rm(path.dirname(this.file(session, 'x')), { recursive: true, force: true });
    }
    /** Copies a reply's checkpoint into another conversation (a branch). Missing ones are skipped. */
    async copy(from: string, to: string, turn: string) {
        const source = this.file(from, turn),
            target = this.file(to, turn);
        await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await fs.copyFile(source, target).catch(error => {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        });
    }
    /** Keeps the newest checkpoints of a conversation. */
    async prune(session: string) {
        const directory = path.dirname(this.file(session, 'x'));
        const names = (await fs.readdir(directory).catch(() => [] as string[])).filter(name => name.endsWith('.json'));
        if (names.length <= this.keep) return;
        const dated = await Promise.all(
            names.map(async name => ({ name, time: (await fs.stat(path.join(directory, name))).mtimeMs })),
        );
        dated.sort((a, b) => a.time - b.time);
        for (const { name } of dated.slice(0, dated.length - this.keep))
            await fs.rm(path.join(directory, name), { force: true });
    }
}
