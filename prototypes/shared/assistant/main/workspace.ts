import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Attachment, Document, Entry } from '../shared/types';

const MAX_TEXT = 2 * 1024 * 1024;
export const revision = (text: string) => createHash('sha256').update(text).digest('hex');

export class Workspace {
    constructor(readonly root: string) {}

    async resolve(relative: string) {
        if (typeof relative !== 'string' || relative.includes('\0') || path.isAbsolute(relative))
            throw new Error('Expected a project-relative path.');
        const candidate = path.resolve(this.root, relative);
        const actual = await fs.realpath(candidate);
        if (actual !== this.root && !actual.startsWith(this.root + path.sep))
            throw new Error('This path is outside the project.');
        return actual;
    }

    async list(relative = ''): Promise<Entry[]> {
        const directory = await this.resolve(relative);
        const children = await fs.readdir(directory, { withFileTypes: true });
        return children
            .filter(
                e =>
                    !['.git', 'node_modules', 'out', 'dist', '.agent-workspace'].includes(e.name) &&
                    !e.isSymbolicLink(),
            )
            .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
            .slice(0, 1000)
            .map(e => ({
                name: e.name,
                path: path.join(relative, e.name),
                directory: e.isDirectory(),
            }));
    }

    async read(relative: string): Promise<Document> {
        const file = await this.resolve(relative);
        const stat = await fs.stat(file);
        if (!stat.isFile() || stat.size > MAX_TEXT) throw new Error('The editor supports text files up to 2 MB.');
        const data = await fs.readFile(file);
        if (data.includes(0)) throw new Error('This is a binary file. Text editing is unavailable.');
        const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
        return { path: relative, text, revision: revision(text) };
    }

    async save(document: Document): Promise<Document> {
        if (typeof document.text !== 'string' || Buffer.byteLength(document.text) > MAX_TEXT)
            throw new Error('File exceeds the editor limit.');
        const current = await this.read(document.path);
        if (current.revision !== document.revision)
            throw new Error('This file changed on disk. Reopen it before saving to avoid overwriting another edit.');
        const destination = await this.resolve(document.path);
        const stat = await fs.stat(destination);
        const temp = path.join(path.dirname(destination), `.ai-gui-${randomUUID()}.tmp`);
        try {
            await fs.writeFile(temp, document.text, { flag: 'wx', mode: stat.mode });
            if ((await this.read(document.path)).revision !== document.revision)
                throw new Error('File changed during save. Reopen it and retry.');
            await fs.rename(temp, destination);
        } finally {
            await fs.rm(temp, { force: true });
        }
        return { ...document, revision: revision(document.text) };
    }

    async newDestination(relative: string) {
        if (typeof relative !== 'string' || !relative || relative.includes('\0') || path.isAbsolute(relative))
            throw new Error('Expected a project-relative file path.');
        const candidate = path.resolve(this.root, relative);
        if (!candidate.startsWith(this.root + path.sep)) throw new Error('This path is outside the project.');
        const parent = await this.resolve(path.relative(this.root, path.dirname(candidate)));
        if (!(await fs.stat(parent)).isDirectory()) throw new Error('The parent must be an existing directory.');
        return path.join(parent, path.basename(candidate));
    }

    async create(relative: string, text: string): Promise<Document> {
        if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_TEXT)
            throw new Error('File exceeds the editor limit.');
        const destination = await this.newDestination(relative);
        const temp = path.join(path.dirname(destination), `.ai-gui-${randomUUID()}.tmp`);
        try {
            await fs.writeFile(temp, text, { flag: 'wx', mode: 0o600 });
            if ((await this.newDestination(relative)) !== destination)
                throw new Error('Destination changed during review.');
            // Hard-link publishes the complete file atomically and never replaces an existing file or symlink.
            await fs.link(temp, destination);
        } finally {
            await fs.rm(temp, { force: true });
        }
        return { path: relative, text, revision: revision(text) };
    }

    async importFiles(sources: string[]): Promise<Attachment[]> {
        if (!Array.isArray(sources) || sources.length > 20) throw new Error('Import up to 20 files at a time.');
        // Validate the batch before copying. Keep imported files separate and never overwrite.
        const items = await Promise.all(
            sources.map(async source => {
                const stat = await fs.stat(source);
                if (!stat.isFile() || stat.size > 25 * 1024 * 1024)
                    throw new Error('Attachments must be files smaller than 25 MB.');
                return { source, stat };
            }),
        );
        const attachmentsDir = path.join(this.root, 'attachments');
        await fs.mkdir(attachmentsDir, { recursive: true });
        await this.resolve('attachments');
        return Promise.all(
            items.map(async ({ source, stat }) => {
                const id = randomUUID();
                const name = path.basename(source);
                const relative = path.join('attachments', id, name);
                await fs.mkdir(path.join(attachmentsDir, id));
                await fs.copyFile(source, path.join(this.root, relative), constants.COPYFILE_EXCL);
                const attachment: Attachment = {
                    id,
                    name,
                    path: relative,
                    size: stat.size,
                };
                if (
                    /\.(txt|md|json|csv|ts|tsx|js|jsx|py|css|html|ya?ml|xml|sh|rs|go|c|cpp|h)$/i.test(name) &&
                    stat.size < 128 * 1024
                ) {
                    try {
                        attachment.text = (await this.read(relative)).text.slice(0, 20000);
                    } catch {
                        /* Binary attachments stay as files. */
                    }
                }
                return attachment;
            }),
        );
    }
}
