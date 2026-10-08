// Read-only before/after documents for approval, change and timeline comparisons.
const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');

function createDiffViews({ context, conversation, status, text }) {
    const previews = new Map();
    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('furnace-preview', { provideTextDocumentContent: uri => previews.get(uri.path) ?? '' }));
    const preview = (key, value) => { previews.set(key, value); return vscode.Uri.from({ scheme: 'furnace-preview', path: key }); };
    const exists = file => fs.stat(file).then(() => true, () => false);
    // Recorded content before against the file as it is now (or the recorded result if it is gone).
    async function showEntries(entries, id, label) {
        for (const [index, entry] of entries.slice(0, 10).entries()) {
            const key = `/${id}/${index}/${path.basename(entry.file)}`;
            const after = entry.after !== null && await exists(entry.file) ? vscode.Uri.file(entry.file) : preview(key + '.after', entry.after ?? '');
            await vscode.commands.executeCommand('vscode.diff', preview(key + '.before', entry.before ?? ''), after, `${entry.path} (${label})`, { preview: entries.length === 1 });
        }
        if (entries.length > 10) status(`Showing 10 of ${entries.length} changed files.`);
    }
    const handlers = {
        openDiff: async message => {
            const files = conversation.approvalFiles(message.id);
            if (!files?.length) throw new Error('This change is no longer pending.');
            for (const [index, file] of files.slice(0, 10).entries()) {
                const key = `/${message.id}/${index}/${path.basename(file.path)}`;
                await vscode.commands.executeCommand('vscode.diff', preview(key + '.before', file.before), preview(key + '.after', file.after), `Proposed: ${file.path}`, { preview: files.length === 1 });
            }
        },
        // Diff of a reply's change: recorded content before the reply against the file now.
        openChange: async message => {
            const changed = (await conversation.changedFiles(text(message.messageId, 100))).filter(entry => !message.path || entry.path === message.path);
            if (!changed.length) throw new Error('No recorded changes to show.');
            await showEntries(changed, message.messageId, 'agent changes');
        },
        // Timeline: every agent change from this message on, against the files now.
        compareFrom: async message => {
            const id = text(message.messageId, 100), changed = await conversation.compareFrom(id);
            if (!changed.length) throw new Error('The agent changed no files from this point on (or they were reverted).');
            await showEntries(changed, `${id}-since`, 'since this point');
            status(`${changed.length} file${changed.length === 1 ? '' : 's'} changed since this point. Rewind restores them.`);
        },
    };
    return { preview, handlers, showEntries };
}
module.exports = { createDiffViews };
