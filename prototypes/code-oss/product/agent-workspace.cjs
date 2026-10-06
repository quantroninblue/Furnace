'use strict';
const vscode = require('vscode');
const path = require('node:path');
const fs = require('node:fs/promises');
const { Workspace, revision } = require('../../shared/assistant/main/workspace.ts');
const { randomUUID } = require('node:crypto');
class AgentWorkspace extends Workspace {
    constructor(root, documents) { super(root); this.documents = documents; }
    async read(relative) {
        const actual = await this.resolve(relative);
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(actual));
        const snapshot = this.documents.snapshot(document);
        if (snapshot.text.length > 2 * 1024 * 1024 || snapshot.text.includes('\0')) throw new Error('Read supports text files up to 2 MB.');
        return { path: relative, text: snapshot.text, revision: revision(snapshot.text), snapshot };
    }
}
class AgentFileReviews {
    constructor(documents, reviews) { this.documents = documents; this.reviews = reviews; this.pending = new Map(); }
    clear() { this.pending.clear(); this.reviews.discard(); }
    async propose(workspace, relative, text, reason, observed) {
        if (!text || text.length > 24000) throw new Error('File proposal must contain 1–24,000 characters.');
        let snapshot;
        try {
            await workspace.resolve(relative);
            if (!observed?.snapshot) throw new Error('Read the complete current file before proposing a change.');
            snapshot = observed.snapshot;
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            const destination = await workspace.newDestination(relative);
            const document = await vscode.workspace.openTextDocument(vscode.Uri.from({ scheme: 'untitled', path: vscode.Uri.file(destination).path }));
            if (document.getText()) throw new Error('This new file already has an unsaved draft. Preserve it and retry.');
            snapshot = this.documents.snapshot(document);
        }
        if (this.pending.size >= 8) throw new Error('Review or discard pending changes before requesting more.');
        const id = randomUUID();
        this.pending.set(id, { snapshot, text });
        return { kind: 'file', id, path: relative, text, original: snapshot.text, revision: observed?.revision || null, reason: reason.slice(0, 1000), status: 'pending' };
    }
    async open(id) {
        const item = this.pending.get(id);
        if (!item) throw new Error('This proposal expired. Request a new change.');
        const document = vscode.workspace.textDocuments.find(doc => !doc.isClosed && doc.uri.toString() === item.snapshot.uri);
        const current = document && this.documents.snapshot(document);
        if (!current || ['instance', 'version', 'text'].some(key => current[key] !== item.snapshot[key])) throw new Error('Document changed since this proposal. Request a new change.');
        await this.reviews.propose(item.snapshot, item.text); this.active = id;
    }
    invalidate(uri) {
        for (const [id, item] of this.pending) if (!uri || item.snapshot.uri === uri) this.pending.delete(id);
    }
}
// File operations for agent tools. Changes go through WorkspaceEdit so open editors,
// undo and file watchers stay consistent; deletions honour files.enableTrash.
class IdeToolHost {
    constructor({ root, trusted, sandbox }) { this.root = root; this.trusted = trusted; this.sandbox = sandbox; }
    open(file) { return vscode.workspace.textDocuments.find(doc => !doc.isClosed && doc.uri.scheme === 'file' && doc.uri.fsPath === file); }
    async read(file) {
        const document = this.open(file);
        if (document) return document.getText();
        const info = await fs.stat(file);
        if (!info.isFile()) throw new Error(`${file} is not a file.`);
        if (info.size > 5 * 1024 * 1024) throw new Error('The file is larger than 5 MB. Use grep, or read part of it with run_command.');
        const data = await fs.readFile(file);
        if (data.includes(0)) throw new Error('This is a binary file; it cannot be read as text.');
        return data.toString('utf8');
    }
    async kind(file) {
        try { const info = await fs.stat(file); return info.isDirectory() ? 'directory' : info.isFile() ? 'file' : null; }
        catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null; throw error; }
    }
    async list(directory) {
        const entries = await fs.readdir(directory, { withFileTypes: true });
        return entries.map(entry => ({ name: entry.name, directory: entry.isDirectory() }))
            .sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
    }
    async write(file, text) {
        const uri = vscode.Uri.file(file);
        if (!await this.kind(file)) {
            await fs.mkdir(path.dirname(file), { recursive: true });
            const edit = new vscode.WorkspaceEdit(); edit.createFile(uri, { contents: Buffer.from(text, 'utf8') });
            if (!await vscode.workspace.applyEdit(edit)) throw new Error('The IDE refused to create the file.');
            return '';
        }
        const document = this.open(file) || await vscode.workspace.openTextDocument(uri);
        const unsaved = document.isDirty;
        const edit = new vscode.WorkspaceEdit();
        edit.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text);
        if (!await vscode.workspace.applyEdit(edit)) throw new Error('The IDE refused the edit.');
        if (unsaved) return 'The file had unsaved editor changes, so the result is in the open editor but not yet saved to disk.';
        if (!await document.save()) throw new Error('The edit was applied but saving failed.');
        return '';
    }
    async remove(file, recursive) {
        const edit = new vscode.WorkspaceEdit(); edit.deleteFile(vscode.Uri.file(file), { recursive, ignoreIfNotExists: false });
        if (!await vscode.workspace.applyEdit(edit)) throw new Error('The IDE refused to delete it.');
    }
    async move(from, to) {
        await fs.mkdir(path.dirname(to), { recursive: true });
        const edit = new vscode.WorkspaceEdit(); edit.renameFile(vscode.Uri.file(from), vscode.Uri.file(to), { overwrite: false });
        if (!await vscode.workspace.applyEdit(edit)) throw new Error('The IDE refused the move.');
    }
    async mkdir(directory) { await fs.mkdir(directory, { recursive: true }); }
}
module.exports = { AgentWorkspace, AgentFileReviews, IdeToolHost };
