// Edits in the editor. Inline edit: select code, describe a change, and the model's replacement
// is shown in place (green) with the original on hover, Accept / Reject lenses and keys.
// Agent hunks: files the agent changed get Keep / Revert lenses per changed block.
const vscode = require('vscode');
const { randomUUID } = require('node:crypto');
const {
    inlineEditInstruction,
    inlineEditPrompt,
    parseReplacement,
} = require('../../shared/assistant/main/inline-edit.ts');
const { lineHunks } = require('../../shared/assistant/main/diff.ts');

function createInlineEdits({ context, provider, conversation, documents, status, preview, setKey }) {
    const added = vscode.window.createTextEditorDecorationType({
        backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
        isWholeLine: true,
        overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.addedForeground'),
        overviewRulerLane: vscode.OverviewRulerLane.Left,
    });
    const removedMarker = vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        borderWidth: '1px 0 0 0',
        borderStyle: 'dashed',
        borderColor: new vscode.ThemeColor('editorOverviewRuler.deletedForeground'),
    });
    context.subscriptions.push(added, removedMarker);
    const pending = new Map(); // document uri → { id, start, end (offsets), original, replacement, controller? }
    let running;
    const lensChanged = new vscode.EventEmitter();
    context.subscriptions.push(lensChanged);
    const update = () => {
        setKey('aiGui.inlineEditPending', !!pending.get(vscode.window.activeTextEditor?.document.uri.toString()));
        for (const editor of vscode.window.visibleTextEditors) {
            const edit = pending.get(editor.document.uri.toString());
            if (!edit) {
                editor.setDecorations(added, []);
                editor.setDecorations(removedMarker, []);
                continue;
            }
            const range = rangeOf(editor.document, edit);
            const hover = new vscode.MarkdownString();
            hover.appendMarkdown('**Replaced by inline edit.** Original:\n');
            hover.appendCodeblock(edit.original.slice(0, 4000), editor.document.languageId);
            editor.setDecorations(added, edit.replacement ? [{ range, hoverMessage: hover }] : []);
            editor.setDecorations(
                removedMarker,
                edit.replacement ? [] : [{ range: new vscode.Range(range.start, range.start), hoverMessage: hover }],
            );
        }
        lensChanged.fire();
    };
    const rangeOf = (document, edit) =>
        new vscode.Range(document.positionAt(edit.start), document.positionAt(edit.end));

    /** options.instruction skips the input box (commands from other features and tests). */
    async function start(options = {}) {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !documents.isSource(editor.document))
            throw new Error('Open a file and select the code to change.');
        if (running) throw new Error('An inline edit is already running.');
        const document = editor.document,
            key = document.uri.toString();
        if (pending.has(key)) throw new Error('Accept or reject the current inline edit first.');
        let selection = editor.selection;
        if (selection.isEmpty)
            selection = new vscode.Selection(
                document.lineAt(selection.active.line).range.start,
                document.lineAt(selection.active.line).rangeIncludingLineBreak.end,
            );
        const model = conversation.data.model;
        if (!conversation.connections.models.some(item => item.id === model))
            throw new Error('Open Connections and select a model first.');
        const instruction =
            typeof options.instruction === 'string'
                ? options.instruction
                : await vscode.window.showInputBox({
                      title: 'Inline Edit',
                      prompt: `Describe the change to ${selection.end.line - selection.start.line + 1} selected line${selection.end.line === selection.start.line ? '' : 's'}`,
                      placeHolder: 'For example: handle the empty list',
                      ignoreFocusOut: true,
                      validateInput: value => (value.length > 4000 ? 'Keep it under 4,000 characters.' : null),
                  });
        if (!instruction?.trim()) return;
        const start = document.offsetAt(selection.start),
            end = document.offsetAt(selection.end),
            text = document.getText(),
            version = document.version;
        const original = text.slice(start, end),
            controller = new AbortController();
        running = { controller, key };
        setKey('aiGui.inlineEditRunning', true);
        let reply = '';
        try {
            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: 'Inline edit', cancellable: true },
                async (progress, token) => {
                    token.onCancellationRequested(() => controller.abort());
                    progress.report({
                        message: `Asking ${conversation.connections.models.find(item => item.id === model)?.name || model}…`,
                    });
                    await provider.run(
                        {
                            id: `inline-${randomUUID()}`,
                            model,
                            mode: 'discuss',
                            permission: 'ask',
                            environment: '',
                            context: '',
                            messages: [
                                { id: 'inline-instructions', role: 'user', content: inlineEditInstruction },
                                {
                                    id: 'inline',
                                    role: 'user',
                                    content: inlineEditPrompt({
                                        file: vscode.workspace.asRelativePath(document.uri, false),
                                        language: document.languageId,
                                        before: text.slice(Math.max(0, start - 20000), start),
                                        selection: original,
                                        after: text.slice(end, end + 8000),
                                        instruction,
                                    }),
                                },
                            ],
                        },
                        {
                            definitions: [],
                            execute: async () => {
                                throw new Error('Inline edits have no tools.');
                            },
                        },
                        controller.signal,
                        event => {
                            if (event.delta) reply += event.delta;
                        },
                    );
                },
            );
        } finally {
            running = undefined;
            setKey('aiGui.inlineEditRunning', false);
        }
        if (controller.signal.aborted) return status('Inline edit cancelled.');
        if (document.version !== version)
            throw new Error('The file changed while the model worked; run the inline edit again.');
        const replacement = parseReplacement(reply, original);
        if (replacement === original) return status('The model suggested no change.');
        const edit = new vscode.WorkspaceEdit();
        edit.replace(document.uri, new vscode.Range(selection.start, selection.end), replacement);
        pending.set(key, {
            id: randomUUID(),
            start,
            end: start + replacement.length,
            original,
            replacement,
            applying: true,
        });
        if (!(await vscode.workspace.applyEdit(edit))) {
            pending.delete(key);
            throw new Error('The editor refused the edit.');
        }
        pending.get(key).applying = false;
        update();
        status(
            'Inline edit shown in the editor: Accept (Ctrl+Enter) or Reject (Escape). Hover the green lines for the original.',
        );
    }
    async function finish(accept, uri) {
        const editor = vscode.window.activeTextEditor,
            key = uri ? String(uri) : editor?.document.uri.toString();
        const edit = key && pending.get(key);
        if (!edit) return;
        pending.delete(key);
        if (!accept) {
            const document = vscode.workspace.textDocuments.find(item => item.uri.toString() === key);
            if (document) {
                const change = new vscode.WorkspaceEdit();
                change.replace(document.uri, rangeOf(document, edit), edit.original);
                await vscode.workspace.applyEdit(change);
            }
        }
        update();
        status(
            accept
                ? 'Inline edit accepted. Save the file when ready; Undo still reverses it.'
                : 'Inline edit rejected; the original is back.',
        );
    }
    async function showDiff(uri) {
        const edit = pending.get(String(uri));
        if (!edit) return;
        const document = vscode.workspace.textDocuments.find(item => item.uri.toString() === String(uri));
        if (!document) return;
        const text = document.getText(),
            before = text.slice(0, edit.start) + edit.original + text.slice(edit.end);
        await vscode.commands.executeCommand(
            'vscode.diff',
            preview(`/inline/${edit.id}/${document.uri.path.split('/').pop()}`, before),
            document.uri,
            `${vscode.workspace.asRelativePath(document.uri, false)} (inline edit)`,
        );
    }
    // Track the pending range through other edits; an edit inside it accepts the change as it is.
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(event => {
            const key = event.document.uri.toString(),
                edit = pending.get(key);
            if (!edit || edit.applying) {
                if (agentFiles.has(event.document.uri.fsPath)) lensChanged.fire();
                return;
            }
            for (const change of event.contentChanges) {
                const delta = change.text.length - change.rangeLength;
                if (change.rangeOffset + change.rangeLength <= edit.start) {
                    edit.start += delta;
                    edit.end += delta;
                } else if (change.rangeOffset >= edit.end) continue;
                else {
                    pending.delete(key);
                    break;
                }
            }
            update();
        }),
    );
    context.subscriptions.push(
        vscode.workspace.onDidCloseTextDocument(document => {
            if (pending.delete(document.uri.toString())) update();
        }),
    );
    context.subscriptions.push(
        vscode.window.onDidChangeVisibleTextEditors(update),
        vscode.window.onDidChangeActiveTextEditor(update),
    );

    // ---- Keep / Revert per changed block in files the agent changed ----
    const agentFiles = new Map(); // absolute path → { path, before }
    const kept = new Map(); // absolute path → Set of hunk signatures the user kept
    async function refreshAgentFiles() {
        const next = new Map();
        for (const file of conversation.agentFiles?.() || []) {
            if (!file.restorable || file.status === 'deleted') continue;
            try {
                const original = await conversation.agentFileOriginal(file.path);
                if (original.before !== null && original.before !== undefined)
                    next.set(original.file, { path: file.path, before: original.before });
            } catch {}
        }
        agentFiles.clear();
        for (const [key, value] of next) agentFiles.set(key, value);
        lensChanged.fire();
    }
    const signature = hunk => JSON.stringify([hunk.before, hunk.after]);
    const hunksFor = document => {
        const entry = agentFiles.get(document.uri.fsPath);
        if (!entry || document.uri.scheme !== 'file') return [];
        const hunks = lineHunks(entry.before, document.getText()) || [];
        return hunks.filter(hunk => !kept.get(document.uri.fsPath)?.has(signature(hunk))).slice(0, 200);
    };
    context.subscriptions.push(
        vscode.languages.registerCodeLensProvider(
            { scheme: 'file' },
            {
                onDidChangeCodeLenses: lensChanged.event,
                provideCodeLenses(document) {
                    const lenses = [],
                        edit = pending.get(document.uri.toString());
                    if (edit) {
                        const range = new vscode.Range(
                            document.positionAt(edit.start),
                            document.positionAt(edit.start),
                        );
                        lenses.push(
                            new vscode.CodeLens(range, {
                                title: '$(check) Accept (Ctrl+Enter)',
                                command: 'aiGui.inlineEdit.accept',
                                arguments: [document.uri.toString()],
                            }),
                            new vscode.CodeLens(range, {
                                title: '$(close) Reject (Esc)',
                                command: 'aiGui.inlineEdit.reject',
                                arguments: [document.uri.toString()],
                            }),
                            new vscode.CodeLens(range, {
                                title: 'Show Diff',
                                command: 'aiGui.inlineEdit.diff',
                                arguments: [document.uri.toString()],
                            }),
                        );
                    }
                    for (const hunk of hunksFor(document)) {
                        const line = Math.min(hunk.afterStart, document.lineCount - 1),
                            range = new vscode.Range(line, 0, line, 0);
                        const label =
                            `${hunk.after.length ? `+${hunk.after.length}` : ''}${hunk.before.length ? ` −${hunk.before.length}` : ''}`.trim();
                        lenses.push(
                            new vscode.CodeLens(range, {
                                title: `Agent change ${label}: Keep`,
                                command: 'aiGui.agentHunk.keep',
                                arguments: [document.uri.toString(), signature(hunk)],
                            }),
                            new vscode.CodeLens(range, {
                                title: 'Revert',
                                command: 'aiGui.agentHunk.revert',
                                arguments: [document.uri.toString(), signature(hunk)],
                            }),
                        );
                    }
                    return lenses;
                },
            },
        ),
    );
    function keepHunk(uri, sig) {
        const file = vscode.Uri.parse(uri).fsPath;
        if (!kept.has(file)) kept.set(file, new Set());
        kept.get(file).add(sig);
        lensChanged.fire();
    }
    async function revertHunk(uri, sig) {
        const document = vscode.workspace.textDocuments.find(item => item.uri.toString() === uri);
        const hunk = document && hunksFor(document).find(item => signature(item) === sig);
        if (!hunk) throw new Error('That change is no longer in the file.');
        const lines = document.getText().split('\n');
        const startOffset = lines.slice(0, hunk.afterStart).reduce((sum, line) => sum + line.length + 1, 0);
        const removed = hunk.after.reduce((sum, line) => sum + line.length + 1, 0);
        const original = hunk.before.map(line => line + '\n').join('');
        const text = document.getText(),
            endOffset = Math.min(text.length, startOffset + removed);
        // At the end of the file there is no newline after the last line.
        const replacement =
            endOffset === text.length && !text.slice(startOffset, endOffset).endsWith('\n')
                ? original.replace(/\n$/, '')
                : original;
        const edit = new vscode.WorkspaceEdit();
        edit.replace(
            document.uri,
            new vscode.Range(document.positionAt(startOffset), document.positionAt(endOffset)),
            replacement,
        );
        if (!(await vscode.workspace.applyEdit(edit))) throw new Error('The editor refused the revert.');
        status('Reverted that block in the editor. Save to keep it; Undo brings the agent change back.');
    }
    return {
        start,
        finish,
        showDiff,
        keepHunk,
        revertHunk,
        refreshAgentFiles,
        cancel: () => running?.controller.abort(),
    };
}
module.exports = { createInlineEdits };
