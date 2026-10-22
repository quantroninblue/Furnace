// Background tasks in the IDE: approvals and results arrive as notifications, the Build page
// lists the tasks, and Review opens each changed file against how it was when the task started.
const vscode = require('vscode');
const path = require('node:path');
const { BackgroundTasks } = require('../../shared/assistant/background.cjs');

function createBackground({ context, provider, conversation, sandbox, root, status, broadcast, showEntries, text }) {
    let tasks;
    const decide = new Map();
    const ui = {
        approval: async (task, step) => {
            const answer = new Promise(resolve => decide.set(step.id, resolve));
            void vscode.window
                .showWarningMessage(
                    `Background task “${task.title}” wants to: ${step.title}`,
                    { detail: step.untrusted ? `Untrusted content: ${step.untrusted}` : undefined },
                    'Approve',
                    'Deny',
                )
                .then(choice => decide.get(step.id)?.(choice === 'Approve' ? 'approve' : 'deny'));
            const decision = await answer;
            decide.delete(step.id);
            return decision;
        },
        finished: async task => {
            const changed = task.files.length;
            const message =
                task.state === 'done'
                    ? `Background task “${task.title}” finished: ${changed ? `${changed} file${changed === 1 ? '' : 's'} changed` : 'no files changed'}.`
                    : `Background task “${task.title}” ${task.state === 'stopped' ? 'stopped' : `failed: ${task.error || ''}`}.`;
            const choice = await vscode.window.showInformationMessage(
                message,
                ...(changed ? ['Review', 'Apply', 'Discard'] : ['Discard']),
            );
            if (choice === 'Review') await handlers.backgroundReview({ id: task.id });
            if (choice === 'Apply')
                await handlers.backgroundApply({ id: task.id }).catch(error => status(error.message));
            if (choice === 'Discard')
                await handlers.backgroundDiscard({ id: task.id }).catch(error => status(error.message));
        },
    };
    tasks = new BackgroundTasks({
        directory: path.join(context.globalStorageUri.fsPath, 'background'),
        provider,
        sandbox: () => sandbox.path,
        ui,
        changed: broadcast,
        connections: () => conversation.connections,
        environment: () => `Command sandbox: ${sandbox.path ? 'available' : 'unavailable, so commands ask'}.`,
    });
    void tasks.load().then(broadcast);
    context.subscriptions.push({
        dispose: () => {
            void tasks.dispose();
        },
    });
    async function start(prompt) {
        if (!vscode.workspace.isTrusted) throw new Error('Trust this project before starting a background task.');
        const task = await tasks.start({
            root: root(),
            prompt,
            model: conversation.data.model,
            brief: conversation.sharePlan ? conversation.session.state.brief : '',
        });
        status(
            `Background task started in its own worktree. You can keep working; you will be notified when it needs you or finishes.`,
        );
        return task;
    }
    const handlers = {
        backgroundStart: message => start(text(message.value, 20000)),
        backgroundStop: message => tasks.stop(text(message.id, 100)),
        backgroundDecide: message => {
            const resolve = decide.get(text(message.stepId, 100));
            if (!resolve) throw new Error('This approval is no longer pending.');
            resolve(message.decision === 'approve' ? 'approve' : 'deny');
        },
        backgroundFollowUp: message => tasks.followUp(text(message.id, 100), text(message.value, 20000)),
        backgroundReview: async message => {
            const entries = await tasks.review(text(message.id, 100));
            if (!entries.length) throw new Error('The task changed no files.');
            await showEntries(entries, `background-${message.id.slice(0, 8)}`, 'background task');
        },
        backgroundApply: async message => {
            const id = text(message.id, 100);
            let task;
            try {
                task = await tasks.apply(id);
            } catch (error) {
                if (!error.conflicts) throw error;
                const choice = await vscode.window.showWarningMessage(
                    'You changed the same places while the task worked.',
                    {
                        modal: true,
                        detail: `${error.conflicts.join('\n')}\n\nMerge adds conflict markers (<<<<<<< project … >>>>>>> background task) where both changed; resolve them in the editor.`,
                    },
                    'Merge',
                );
                if (choice !== 'Merge') return status('Apply cancelled. The task and its worktree are kept.');
                task = await tasks.apply(id, { merge: true });
            }
            status(
                `Applied ${task.files.length} file${task.files.length === 1 ? '' : 's'} from the background task${task.conflicted?.length ? `; resolve conflicts in ${task.conflicted.join(', ')}` : ''}. Nothing was staged or committed; Discard removes its worktree.`,
            );
        },
        backgroundDiscard: async message => {
            const task = tasks.get(text(message.id, 100));
            if (
                task.state !== 'applied' &&
                task.files?.length &&
                (await vscode.window.showWarningMessage(
                    `Discard “${task.title}”?`,
                    {
                        modal: true,
                        detail: 'Its worktree and unapplied changes are deleted. Your project is not changed.',
                    },
                    'Discard',
                )) !== 'Discard'
            )
                return;
            await tasks.discard(task.id);
            status('Background task discarded.');
        },
    };
    return { tasks, handlers, start, list: () => tasks.list(root()) };
}
module.exports = { createBackground };
