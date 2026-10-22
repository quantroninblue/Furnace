'use strict';
const { mergeCheckpoints, restoreChanges, summarize } = require('../main/checkpoints.ts');
// Going back: revert a reply's files, rewind, regenerate, branch, and manage saved conversations.
class HistoryMethods {
    idle() {
        if (this.busy()) throw new Error('Finish or stop the current task first.');
    }
    restoreHost() {
        const host = this.adapter.toolHost?.();
        if (!host?.root || !host.trusted)
            throw new Error("Open and trust this conversation's project to restore files.");
        return host;
    }
    // Reverts files one reply changed (all of them, or the listed paths). A conflict (the file
    // changed since) throws with `conflicts` unless forced, so the caller can ask the user.
    async revert(messageId, paths = null, force = false) {
        this.idle();
        const message = this.data.messages.find(item => item.id === messageId && item.role === 'assistant');
        if (!message?.changes) throw new Error('That reply has no file changes to revert.');
        const host = this.restoreHost(),
            checkpoint = await this.checkpoints.load(this.data.id, messageId);
        const selected = {
            files: checkpoint.files.filter(entry => !paths || paths.includes(entry.path)),
            directories: paths ? [] : checkpoint.directories,
        };
        const result = await restoreChanges(host, selected, force);
        if (result.conflicts.length && !force)
            throw Object.assign(
                new Error(
                    `${result.conflicts.join(', ')} changed after the agent edited ${result.conflicts.length === 1 ? 'it' : 'them'}.`,
                ),
                { conflicts: result.conflicts },
            );
        await this.checkpoints.save(this.data.id, messageId, checkpoint);
        message.changes = { files: summarize(checkpoint.files) };
        if (result.restored.length) {
            this.record(
                `User reverted ${result.restored.length} file${result.restored.length === 1 ? '' : 's'} changed by an earlier reply (${result.restored.slice(0, 20).join(', ')}). They are back to their earlier content; read them again before editing.`,
            );
            this.log({
                event: 'revert',
                title: `Reverted ${result.restored.length} file${result.restored.length === 1 ? '' : 's'}`,
                detail: result.restored.slice(0, 20).join(', '),
            });
        }
        await this.save();
        this.changed();
        return result;
    }
    // Rewinds the conversation to just before a user message: files changed by later replies
    // are restored, those messages are removed and the message text returns to the draft.
    async rewind(messageId, force = false) {
        this.idle();
        const index = this.data.messages.findIndex(item => item.id === messageId && item.role === 'user' && !item.kind);
        if (index < 0) throw new Error('Choose one of your messages to rewind to.');
        const later = this.data.messages
            .slice(index)
            .filter(item => item.role === 'assistant' && item.changes?.files.some(file => !file.reverted));
        let result = { conflicts: [], restored: [], skipped: [] };
        if (later.length) {
            const host = this.restoreHost(),
                checkpoints = [];
            for (const item of later) checkpoints.push(await this.checkpoints.load(this.data.id, item.id));
            result = await restoreChanges(host, mergeCheckpoints(checkpoints), force);
            if (result.conflicts.length && !force)
                throw Object.assign(
                    new Error(
                        `${result.conflicts.join(', ')} changed after the agent edited ${result.conflicts.length === 1 ? 'it' : 'them'}.`,
                    ),
                    { conflicts: result.conflicts },
                );
        }
        const removed = this.data.messages.splice(index);
        for (const item of removed) {
            for (const proposal of item.proposals || []) {
                this.proposals.delete(proposal.id);
                this.adapter.files?.pending?.delete(proposal.id);
            }
            if (item.role === 'assistant') await this.checkpoints.remove(this.data.id, item.id).catch(() => {});
        }
        this.session.update('draft', removed[0].content.slice(0, 20000));
        this.log({
            event: 'rewind',
            title: `Rewound ${removed.length} message${removed.length === 1 ? '' : 's'}`,
            detail: result.restored.length ? `restored ${result.restored.slice(0, 20).join(', ')}` : undefined,
        });
        await this.save();
        this.changed();
        return result;
    }
    /** Rewinds to the user message before a reply and sends it again. `turn` settles when the new reply ends. */
    async regenerate(messageId, force = false) {
        this.idle();
        const index = this.data.messages.findIndex(item => item.id === messageId && item.role === 'assistant');
        const user =
            index < 0 ? null : this.data.messages.slice(0, index).findLast(item => item.role === 'user' && !item.kind);
        if (!user) throw new Error('There is no message of yours to answer again.');
        const draft = this.session.state.draft;
        const result = await this.rewind(user.id, force);
        this.session.update('draft', draft);
        return { ...result, turn: this.send(user.content, { fromDraft: false }) };
    }
    /** Starts a new conversation with the messages up to and including this one. Files are not changed. */
    async branch(messageId) {
        this.idle();
        const index = this.data.messages.findIndex(item => item.id === messageId);
        if (index < 0) throw new Error('That message is no longer in this conversation.');
        if ((await this.save()) === false) throw new Error(this.persistenceError);
        const source = this.data,
            messages = structuredClone(source.messages.slice(0, index + 1));
        for (const message of messages)
            for (const proposal of message.proposals || [])
                if (proposal.status === 'pending') proposal.status = 'expired';
        this.reset();
        this.data = this.storage.branch(source, messages, this.adapter.root());
        for (const message of messages)
            if (message.role === 'assistant' && message.changes)
                await this.checkpoints.copy(source.id, this.data.id, message.id).catch(() => {});
        await this.save();
        this.changed();
    }
    async rename(id, title) {
        if (typeof title !== 'string' || !title.trim() || title.length > 200)
            throw new Error('Enter a name up to 200 characters.');
        if (id === this.data.id) {
            this.data.customTitle = title.trim().slice(0, 90);
            await this.save();
            this.changed();
            return;
        }
        await this.storage.rename(id, title.trim().slice(0, 90));
    }
    async remove(id) {
        if (id === this.data.id) await this.switch();
        await this.storage.remove(id);
        await this.checkpoints.removeSession(id).catch(() => {});
        this.changed();
    }
    /**
     * The conversation as a timeline: each of the user's messages with what its reply did, the
     * branches started from this conversation (at the message they copied up to) and the
     * conversation this one branched from.
     */
    async timeline() {
        const sessions = await this.list();
        const branches = sessions.filter(item => item.branchOf === this.data.id);
        const parent = this.data.branchOf ? sessions.find(item => item.id === this.data.branchOf) : null;
        const points = [],
            messages = this.data.messages;
        messages.forEach((message, index) => {
            if (message.role !== 'user' || message.kind) return;
            const next = messages.slice(index + 1).findIndex(item => item.role === 'user' && !item.kind);
            const replies = messages
                .slice(index + 1, next < 0 ? undefined : index + 1 + next)
                .filter(item => item.role === 'assistant');
            const files = new Set(
                replies.flatMap(reply =>
                    (reply.changes?.files || []).filter(file => !file.reverted).map(file => file.path),
                ),
            );
            const later = messages
                .slice(index)
                .some(
                    item =>
                        item.role === 'assistant' &&
                        item.changes?.files.some(file => !file.reverted && file.restorable),
                );
            points.push({
                id: message.id,
                text: message.content.slice(0, 160),
                at: message.createdAt || replies[0]?.startedAt || null,
                reply: replies.length
                    ? {
                          state: replies.at(-1).state || 'complete',
                          files: [...files],
                          steps: replies.reduce((sum, reply) => sum + (reply.steps?.length || 0), 0),
                          verified: replies.some(reply =>
                              reply.steps?.some(step => step.tool === 'verify_step' && step.status === 'done'),
                          ),
                      }
                    : null,
                checkpoint: files.size > 0,
                comparable: later,
                branches: branches
                    .filter(item => replies.some(reply => reply.id === item.branchAt) || item.branchAt === message.id)
                    .map(item => ({ id: item.id, title: item.title, messageCount: item.messageCount })),
            });
        });
        const placed = new Set(points.flatMap(point => point.branches.map(item => item.id)));
        return {
            id: this.data.id,
            title: this.snapshot().title,
            parent: parent ? { id: parent.id, title: parent.title } : null,
            points,
            otherBranches: branches
                .filter(item => !placed.has(item.id))
                .map(item => ({ id: item.id, title: item.title, messageCount: item.messageCount })),
        };
    }
    /** Files the agent changed from this message on, with their content just before it (to compare with now). */
    async compareFrom(messageId) {
        const index = this.data.messages.findIndex(item => item.id === messageId);
        if (index < 0) throw new Error('That message is no longer in this conversation.');
        const later = this.data.messages
            .slice(index)
            .filter(item => item.role === 'assistant' && item.changes?.files.some(file => !file.reverted));
        const checkpoints = [];
        for (const item of later) checkpoints.push(await this.checkpoints.load(this.data.id, item.id));
        return mergeCheckpoints(checkpoints).files.filter(
            entry => entry.touched && entry.restorable && !entry.reverted,
        );
    }
    // Recorded before/after content of a reply's changed files (still revertible ones).
    async changedFiles(messageId) {
        const { files } = await this.checkpoints.load(this.data.id, messageId);
        return files.filter(
            entry => entry.touched && entry.restorable && !entry.reverted && entry.before !== entry.after,
        );
    }
    /** Every file the agent changed in this conversation and has not reverted, newest reply first. */
    agentFiles() {
        const files = new Map();
        for (const message of [...this.data.messages].reverse()) {
            if (message.role !== 'assistant' || !message.changes) continue;
            for (const file of message.changes.files)
                if (!file.reverted && !files.has(file.path)) files.set(file.path, { ...file, messageId: message.id });
        }
        return [...files.values()];
    }
    /** Content of a file before the agent first changed it in this conversation (null: the agent created it). */
    async agentFileOriginal(file) {
        for (const message of this.data.messages) {
            if (
                message.role !== 'assistant' ||
                !message.changes?.files.some(item => item.path === file && !item.reverted)
            )
                continue;
            const entry = (await this.checkpoints.load(this.data.id, message.id)).files.find(
                item => item.path === file && !item.reverted,
            );
            if (entry?.restorable) return { before: entry.before, file: entry.file };
        }
        throw new Error(`No recorded agent change for ${file}.`);
    }
    /** Reverts every agent change to one file, newest reply first, back to its original content. */
    async revertFile(file, force = false) {
        const replies = this.data.messages
            .filter(
                message =>
                    message.role === 'assistant' &&
                    message.changes?.files.some(item => item.path === file && !item.reverted && item.restorable),
            )
            .reverse();
        if (!replies.length) throw new Error(`${file} has no revertible agent changes.`);
        const result = { conflicts: [], restored: [], skipped: [] };
        for (const [index, message] of replies.entries()) {
            const step = await this.revert(message.id, [file], force || index > 0);
            result.restored.push(...step.restored.filter(item => !result.restored.includes(item)));
            result.skipped.push(...step.skipped);
        }
        return result;
    }
}
module.exports = { HistoryMethods };
