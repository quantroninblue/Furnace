// Conversation history and restores: open, rename, delete, branch, regenerate, revert and
// rewind. Restores that would overwrite the user's later edits ask first.
const vscode = require('vscode');

function createHistoryActions({ conversation, status, save, text }) {
    // Restores that would overwrite later edits need the user's explicit go-ahead.
    async function confirmConflicts(run, action) {
        try { return await run(false); } catch (error) {
            if (!error.conflicts) throw error;
            const choice = await vscode.window.showWarningMessage(`${error.conflicts.length === 1 ? 'A file has' : `${error.conflicts.length} files have`} changed since the agent edited ${error.conflicts.length === 1 ? 'it' : 'them'}.`,
                { modal: true, detail: `${error.conflicts.slice(0, 12).join('\n')}${error.conflicts.length > 12 ? '\n…' : ''}\n\n${action} replaces those later changes too. Open files can be restored with Undo; deleted files go to the trash.` }, `${action} Anyway`);
            return choice ? run(true) : null;
        }
    }
    const restored = (result, verb) => {
        if (!result) return status(`${verb} cancelled.`);
        status(`${verb}: ${result.restored.length} file${result.restored.length === 1 ? '' : 's'} restored.${result.skipped.length ? ` Not restorable: ${result.skipped.join(', ')}.` : ''} Undo works in open editors.`);
    };
    const handlers = {
        historyList: async (message, view) => { void view.webview.postMessage({ type: 'history', query: message.value, items: await conversation.list(text(message.value, 200)), current: conversation.data.id }); },
        historyOpen: async message => { if (message.id !== conversation.data.id) { await conversation.switch(text(message.id, 100)); save(); } },
        historyRename: async message => { await conversation.rename(text(message.id, 100), text(message.title, 200)); status('Conversation renamed.'); },
        historyDelete: async message => {
            const id = text(message.id, 100);
            if (await vscode.window.showWarningMessage('Delete this conversation?', { modal: true, detail: 'Its messages and saved checkpoints are removed. Files in your project are not changed.' }, 'Delete') !== 'Delete') return;
            await conversation.remove(id); save(); status('Conversation deleted.');
        },
        branch: async message => { await conversation.branch(text(message.messageId, 100)); save(); status('Branched into a new conversation. Files were not changed; the original conversation is in History.'); },
        regenerate: async message => {
            const result = await confirmConflicts(force => conversation.regenerate(text(message.messageId, 100), force), 'Regenerate');
            if (!result) return status('Regenerate cancelled.');
            if (result.restored.length) restored(result, 'Regenerating');
            await result.turn;
        },
        revertChanges: async message => {
            const file = message.path === undefined ? null : text(message.path, 4096);
            restored(await confirmConflicts(force => conversation.revert(text(message.messageId, 100), file && [file], force), 'Revert'), file ? `Reverted ${file}` : 'Reverted this reply');
        },
        rewind: async message => {
            const id = text(message.messageId, 100), at = conversation.data.messages.findIndex(item => item.id === id);
            if (at < 0 || conversation.turn || conversation.command) throw new Error(at < 0 ? 'That message is no longer in this conversation.' : 'Finish or stop the current task first.');
            const later = conversation.data.messages.slice(at), changed = later.filter(item => item.changes?.files.some(file => !file.reverted)).length;
            const choice = await vscode.window.showWarningMessage('Rewind the conversation to this message?', { modal: true,
                detail: `${later.length} message${later.length === 1 ? '' : 's'} from this point on will be removed${changed ? `, and files changed by ${changed} agent repl${changed === 1 ? 'y' : 'ies'} restored to how they were before` : ''}. Your message goes back into the box so you can edit and resend it. Changes made by commands are not undone.` }, 'Rewind');
            if (choice !== 'Rewind') return;
            restored(await confirmConflicts(force => conversation.rewind(id, force), 'Rewind'), 'Rewound');
            await vscode.commands.executeCommand('aiGui.conversation.focus');
        },
    };
    return { confirmConflicts, restored, handlers };
}
module.exports = { createHistoryActions };
