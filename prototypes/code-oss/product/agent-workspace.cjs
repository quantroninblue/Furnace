'use strict';
const vscode = require('vscode');
const path = require('node:path');
const fs = require('node:fs/promises');
const { Workspace, revision } = require('../../shared/assistant/main/workspace.ts');
const { randomUUID } = require('node:crypto');
class AgentWorkspace extends Workspace {
    constructor(root, documents) {
        super(root);
        this.documents = documents;
    }
    async read(relative) {
        const actual = await this.resolve(relative);
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(actual));
        const snapshot = this.documents.snapshot(document);
        if (snapshot.text.length > 2 * 1024 * 1024 || snapshot.text.includes('\0'))
            throw new Error('Read supports text files up to 2 MB.');
        return { path: relative, text: snapshot.text, revision: revision(snapshot.text), snapshot };
    }
}
class AgentFileReviews {
    constructor(documents, reviews) {
        this.documents = documents;
        this.reviews = reviews;
        this.pending = new Map();
    }
    clear() {
        this.pending.clear();
        this.reviews.discard();
    }
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
            const document = await vscode.workspace.openTextDocument(
                vscode.Uri.from({ scheme: 'untitled', path: vscode.Uri.file(destination).path }),
            );
            if (document.getText())
                throw new Error('This new file already has an unsaved draft. Preserve it and retry.');
            snapshot = this.documents.snapshot(document);
        }
        if (this.pending.size >= 8) throw new Error('Review or discard pending changes before requesting more.');
        const id = randomUUID();
        this.pending.set(id, { snapshot, text });
        return {
            kind: 'file',
            id,
            path: relative,
            text,
            original: snapshot.text,
            revision: observed?.revision || null,
            reason: reason.slice(0, 1000),
            status: 'pending',
        };
    }
    async open(id) {
        const item = this.pending.get(id);
        if (!item) throw new Error('This proposal expired. Request a new change.');
        const document = vscode.workspace.textDocuments.find(
            doc => !doc.isClosed && doc.uri.toString() === item.snapshot.uri,
        );
        const current = document && this.documents.snapshot(document);
        if (!current || ['instance', 'version', 'text'].some(key => current[key] !== item.snapshot[key]))
            throw new Error('Document changed since this proposal. Request a new change.');
        await this.reviews.propose(item.snapshot, item.text);
        this.active = id;
    }
    invalidate(uri) {
        for (const [id, item] of this.pending) if (!uri || item.snapshot.uri === uri) this.pending.delete(id);
    }
}
// The IDE's language intelligence for agent tools (see CodeIntel in agent-tools.ts). Positions
// are 1-based for the model and 0-based for the IDE.
const symbolKinds = Object.fromEntries(
    Object.entries(vscode.SymbolKind).map(([name, value]) => [value, name.toLowerCase()]),
);
class IdeCodeIntel {
    async document(file) {
        return vscode.workspace.openTextDocument(vscode.Uri.file(file));
    }
    async at(file, line, column) {
        const document = await this.document(file);
        return [document.uri, new vscode.Position(line - 1, column - 1)];
    }
    location(item) {
        const uri = item.targetUri || item.uri,
            range = item.targetSelectionRange || item.targetRange || item.range;
        return uri?.scheme === 'file' && range
            ? { file: uri.fsPath, line: range.start.line + 1, column: range.start.character + 1 }
            : null;
    }
    async definition(file, line, column) {
        const found =
            (await vscode.commands.executeCommand(
                'vscode.executeDefinitionProvider',
                ...(await this.at(file, line, column)),
            )) || [];
        return found.map(item => this.location(item)).filter(Boolean);
    }
    async references(file, line, column) {
        const found =
            (await vscode.commands.executeCommand(
                'vscode.executeReferenceProvider',
                ...(await this.at(file, line, column)),
            )) || [];
        return found.map(item => this.location(item)).filter(Boolean);
    }
    async rename(file, line, column, name) {
        let edit;
        try {
            edit = await vscode.commands.executeCommand(
                'vscode.executeDocumentRenameProvider',
                ...(await this.at(file, line, column)),
                name,
            );
        } catch (error) {
            throw new Error(`The language server refused the rename: ${error.message}`);
        }
        const result = [];
        for (const [uri, edits] of edit?.entries() || []) {
            if (uri.scheme !== 'file')
                throw new Error('The rename touches a file outside the file system; edit the files directly.');
            const document = await vscode.workspace.openTextDocument(uri);
            let text = document.getText();
            for (const item of [...edits].sort(
                (a, b) => document.offsetAt(b.range.start) - document.offsetAt(a.range.start),
            ))
                text =
                    text.slice(0, document.offsetAt(item.range.start)) +
                    item.newText +
                    text.slice(document.offsetAt(item.range.end));
            result.push({ file: uri.fsPath, after: text });
        }
        return result;
    }
    async symbols(query) {
        const found = (await vscode.commands.executeCommand('vscode.executeWorkspaceSymbolProvider', query)) || [];
        return found
            .filter(item => item.location?.uri.scheme === 'file')
            .map(item => ({
                name: item.name,
                kind: symbolKinds[item.kind] || 'symbol',
                container: item.containerName || undefined,
                file: item.location.uri.fsPath,
                line: item.location.range.start.line + 1,
                column: item.location.range.start.character + 1,
            }));
    }
    async outline(file) {
        const document = await this.document(file);
        const found =
                (await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', document.uri)) || [],
            result = [];
        const walk = (items, depth) => {
            for (const item of items) {
                if (result.length >= 1000) return;
                result.push({
                    name: item.name,
                    kind: symbolKinds[item.kind] || 'symbol',
                    line: (item.selectionRange || item.range || item.location.range).start.line + 1,
                    depth,
                });
                walk(item.children || [], depth + 1);
            }
        };
        walk(found, 0);
        return result;
    }
    async problems(files) {
        const wanted = files && new Set(files),
            result = [];
        for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
            if (uri.scheme !== 'file' || (wanted && !wanted.has(uri.fsPath))) continue;
            for (const item of diagnostics)
                if (item.severity <= vscode.DiagnosticSeverity.Warning)
                    result.push({
                        file: uri.fsPath,
                        line: item.range.start.line + 1,
                        column: item.range.start.character + 1,
                        severity: item.severity === vscode.DiagnosticSeverity.Error ? 'error' : 'warning',
                        message: item.message.replace(/\s+/g, ' ').slice(0, 400),
                        source: item.source,
                    });
        }
        return result.sort(
            (a, b) =>
                (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1) ||
                a.file.localeCompare(b.file) ||
                a.line - b.line,
        );
    }
    // Language servers report diagnostics shortly after a change: wait for the first report on
    // these files (up to 1.5 s), then for 300 ms without more, at most 5 s in all.
    async settle(files) {
        const wanted = new Set(files);
        for (const file of files) await this.document(file).catch(() => {});
        await new Promise(resolve => {
            let quiet,
                seen = false;
            const finish = () => {
                clearTimeout(quiet);
                clearTimeout(first);
                clearTimeout(cap);
                listener.dispose();
                resolve();
            };
            const first = setTimeout(() => {
                    if (!seen) finish();
                }, 1500),
                cap = setTimeout(finish, 5000);
            const listener = vscode.languages.onDidChangeDiagnostics(event => {
                if (!event.uris.some(uri => wanted.has(uri.fsPath))) return;
                seen = true;
                clearTimeout(quiet);
                quiet = setTimeout(finish, 300);
            });
        });
    }
}
// File operations for agent tools. Changes go through WorkspaceEdit so open editors,
// undo and file watchers stay consistent; deletions honour files.enableTrash.
class IdeToolHost {
    constructor({ root, trusted, sandbox }) {
        this.root = root;
        this.trusted = trusted;
        this.sandbox = sandbox;
        this.code = new IdeCodeIntel();
    }
    open(file) {
        return vscode.workspace.textDocuments.find(
            doc => !doc.isClosed && doc.uri.scheme === 'file' && doc.uri.fsPath === file,
        );
    }
    async read(file) {
        const document = this.open(file);
        if (document) return document.getText();
        const info = await fs.stat(file);
        if (!info.isFile()) throw new Error(`${file} is not a file.`);
        if (info.size > 5 * 1024 * 1024)
            throw new Error('The file is larger than 5 MB. Use grep, or read part of it with run_command.');
        const data = await fs.readFile(file);
        if (data.includes(0)) throw new Error('This is a binary file; it cannot be read as text.');
        return data.toString('utf8');
    }
    async kind(file) {
        try {
            const info = await fs.stat(file);
            return info.isDirectory() ? 'directory' : info.isFile() ? 'file' : null;
        } catch (error) {
            if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null;
            throw error;
        }
    }
    async list(directory) {
        const entries = await fs.readdir(directory, { withFileTypes: true });
        return entries
            .map(entry => ({ name: entry.name, directory: entry.isDirectory() }))
            .sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
    }
    async write(file, text) {
        const uri = vscode.Uri.file(file);
        if (!(await this.kind(file))) {
            await fs.mkdir(path.dirname(file), { recursive: true });
            const edit = new vscode.WorkspaceEdit();
            edit.createFile(uri, { contents: Buffer.from(text, 'utf8') });
            if (!(await vscode.workspace.applyEdit(edit))) throw new Error('The IDE refused to create the file.');
            return '';
        }
        const document = this.open(file) || (await vscode.workspace.openTextDocument(uri));
        const unsaved = document.isDirty;
        const edit = new vscode.WorkspaceEdit();
        edit.replace(
            uri,
            new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
            text,
        );
        if (!(await vscode.workspace.applyEdit(edit))) throw new Error('The IDE refused the edit.');
        if (unsaved)
            return 'The file had unsaved editor changes, so the result is in the open editor but not yet saved to disk.';
        if (!(await document.save())) throw new Error('The edit was applied but saving failed.');
        return '';
    }
    async remove(file, recursive) {
        const edit = new vscode.WorkspaceEdit();
        edit.deleteFile(vscode.Uri.file(file), { recursive, ignoreIfNotExists: false });
        if (!(await vscode.workspace.applyEdit(edit))) throw new Error('The IDE refused to delete it.');
    }
    async move(from, to) {
        await fs.mkdir(path.dirname(to), { recursive: true });
        const edit = new vscode.WorkspaceEdit();
        edit.renameFile(vscode.Uri.file(from), vscode.Uri.file(to), { overwrite: false });
        if (!(await vscode.workspace.applyEdit(edit))) throw new Error('The IDE refused the move.');
    }
    async mkdir(directory) {
        await fs.mkdir(directory, { recursive: true });
    }
}
module.exports = { AgentWorkspace, AgentFileReviews, IdeToolHost };
