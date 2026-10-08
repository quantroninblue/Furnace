const vscode = require('vscode');
const { randomUUID } = require('node:crypto');

// Review files exist only in memory. The base is read-only and the proposed
// side is a normal editable IDE document, including its unsaved buffer.
class ReviewFiles {
    constructor() {
        this.entries = new Map();
        this.events = new vscode.EventEmitter();
        this.onDidChangeFile = this.events.event;
    }
    dispose() { this.entries.clear(); this.events.dispose(); }
    watch() { return new vscode.Disposable(() => {}); }
    entry(uri) {
        const entry = this.entries.get(uri.toString());
        if (!entry) throw vscode.FileSystemError.FileNotFound(uri);
        return entry;
    }
    stat(uri) {
        const entry = this.entry(uri);
        return { type: vscode.FileType.File, ctime: entry.time, mtime: entry.time,
            size: entry.bytes.length, permissions: entry.readonly ? vscode.FilePermission.Readonly : undefined };
    }
    readFile(uri) { return this.entry(uri).bytes; }
    writeFile(uri, bytes) {
        const entry = this.entry(uri);
        if (entry.readonly) throw vscode.FileSystemError.NoPermissions('The captured base is read-only.');
        if (bytes.length > 400000) throw vscode.FileSystemError.Unavailable('Review exceeds prototype limit.');
        entry.bytes = Buffer.from(bytes); entry.time = Date.now();
        this.events.fire([{ type: vscode.FileChangeType.Changed, uri }]);
    }
    readDirectory() { return []; }
    createDirectory() { throw vscode.FileSystemError.NoPermissions(); }
    delete() { throw vscode.FileSystemError.NoPermissions(); }
    rename() { throw vscode.FileSystemError.NoPermissions(); }
    add(uri, text, readonly) {
        this.entries.set(uri.toString(), { bytes: Buffer.from(text), readonly, time: Date.now(), retained: true });
    }
    release(uri) {
        const entry = this.entries.get(uri.toString());
        if (entry) entry.retained = false;
        this.collect(uri);
    }
    collect(uri) {
        if (!this.entries.get(uri.toString())?.retained
            && !vscode.workspace.textDocuments.some(doc => !doc.isClosed && doc.uri.toString() === uri.toString())) {
            this.entries.delete(uri.toString());
        }
    }
}

class CodeOssDocuments {
    constructor(context, invalidate) {
        this.files = new ReviewFiles();
        this.instances = new WeakMap();
        this.lastDocument = undefined;
        const remember = editor => {
            if (editor && this.isSource(editor.document)) this.lastDocument = editor.document;
        };
        remember(vscode.window.activeTextEditor);
        context.subscriptions.push(this.files,
            vscode.workspace.registerFileSystemProvider('furnace-review', this.files, { isCaseSensitive: true }),
            vscode.window.onDidChangeActiveTextEditor(remember),
            vscode.window.tabGroups.onDidChangeTabs(event => {
                for (const tab of event.closed) {
                    if (!(tab.input instanceof vscode.TabInputText)) continue;
                    const uri = tab.input.uri.toString();
                    const stillOpen = vscode.window.tabGroups.all.some(group => group.tabs.some(other =>
                        other.input instanceof vscode.TabInputText && other.input.uri.toString() === uri));
                    if (!stillOpen && ['file', 'untitled'].includes(tab.input.uri.scheme)) {
                        if (this.lastDocument?.uri.toString() === uri) this.lastDocument = undefined;
                        invalidate(uri);
                    }
                }
            }),
            vscode.workspace.onDidCloseTextDocument(document => {
                if (this.isSource(document)) invalidate(document.uri.toString());
                this.files.collect(document.uri);
            }),
            vscode.workspace.onDidChangeWorkspaceFolders(() => { this.lastDocument = undefined; invalidate(); }));
    }
    isSource(document) { return ['file', 'untitled'].includes(document.uri.scheme); }
    snapshot(document) {
        if (!document || document.isClosed) throw new Error('Open a text file before proposing an edit.');
        if (!this.instances.has(document)) this.instances.set(document, randomUUID());
        return { uri: document.uri.toString(), instance: this.instances.get(document),
            version: document.version, text: document.getText() };
    }
    captureActive() {
        const active = vscode.window.activeTextEditor?.document;
        const document = active && this.isSource(active) ? active : this.lastDocument;
        return this.snapshot(document);
    }
    async openReview(proposal) {
        const source = vscode.workspace.textDocuments.find(doc => !doc.isClosed && doc.uri.toString() === proposal.uri);
        if (!source) throw new Error('Source document closed. Generate a new proposal.');
        // Pin a preview source tab before opening the diff so replacement of a
        // preview tab cannot discard the document being reviewed.
        await vscode.window.showTextDocument(source, { preview: false, preserveFocus: true });
        const id = randomUUID();
        const name = vscode.Uri.parse(proposal.uri).path.split('/').pop() || 'document.txt';
        const base = vscode.Uri.from({ scheme: 'furnace-review', path: `/${id}/base/${name}` });
        const proposed = vscode.Uri.from({ scheme: 'furnace-review', path: `/${id}/proposed/${name}` });
        const review = { base, proposed };
        this.files.add(base, proposal.text, true);
        this.files.add(proposed, proposal.replacement, false);
        try {
            await vscode.commands.executeCommand('vscode.diff', base, proposed, `Review: ${name}`, { preview: false });
            return review;
        } catch (error) { this.releaseReview(review); throw error; }
    }
    readReview(review) {
        const document = vscode.workspace.textDocuments.find(doc => !doc.isClosed && doc.uri.toString() === review.proposed.toString());
        if (!document) throw new Error('Review document closed. Generate a new proposal.');
        return document.getText();
    }
    releaseReview(review) {
        // Keep any open draft available for inspection. It is no longer an
        // approval, and can never be applied after discard or extension reload.
        this.files.release(review.base); this.files.release(review.proposed);
    }
    async apply(proposal, replacement, validate) {
        const document = vscode.workspace.textDocuments.find(doc => !doc.isClosed && doc.uri.toString() === proposal.uri);
        validate(document ? this.snapshot(document) : undefined);
        const editor = await vscode.window.showTextDocument(document, { preview: false });
        // No await between validation and edit construction. TextEditor.edit
        // captures the version, and Code OSS checks it again in the main side
        // before changing the model (mainThreadEditor.applyEdits).
        validate(this.snapshot(document));
        return editor.edit(edit => edit.replace(new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), replacement),
            { undoStopBefore: true, undoStopAfter: true });
    }
}
module.exports = { CodeOssDocuments };
