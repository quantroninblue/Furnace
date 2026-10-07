// Claude Code owns its sign-in: AI GUI opens it in an IDE terminal and rediscovers
// connections once that terminal exits, so the panel reflects the CLI's state.
const vscode = require('vscode');
const { findClaude } = require('../../shared/assistant/main/claude-discovery.ts');

function createClaudeSignIn({ context, conversation, status }) {
    let loginTerminal;
    context.subscriptions.push({ dispose: () => loginTerminal?.dispose() });
    context.subscriptions.push(vscode.window.onDidCloseTerminal(async terminal => {
        if (terminal !== loginTerminal) return;
        loginTerminal = undefined;
        try {
            await conversation.connect({ action: 'discover' });
            const claude = conversation.connections.connections?.find(item => item.provider === 'claude-code');
            status(claude?.connected ? 'Claude Code is connected. Choose a Claude model under Active model.' : `Claude Code is not signed in${claude?.error ? `: ${claude.error}` : '.'} Retry sign-in, then refresh connections.`);
        } catch (error) { status(`${error.message} Refresh connections when ready.`); }
    }));
    return async function claudeSignIn(type) {
        if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before launching a sign-in terminal.');
        // Never replace a running sign-in: its browser authorization would lose its callback.
        if (loginTerminal && !loginTerminal.exitStatus) { loginTerminal.show(); status('Claude Code sign-in is already open. Finish it in the terminal, or close that terminal to start again.'); return; }
        const executable = await findClaude(); if (!executable) throw new Error('Install Claude Code separately, then refresh Connections.');
        loginTerminal?.dispose();
        loginTerminal = vscode.window.createTerminal({ name: 'Claude Code sign-in', shellPath: executable, shellArgs: ['auth', 'login', ...(type === 'claudeConsole' ? ['--console'] : [])], cwd: context.globalStorageUri.fsPath });
        loginTerminal.show();
        status('Complete Claude Code sign-in in the terminal. If the browser shows a code, paste it there. Connections refresh when it finishes.');
    };
}
module.exports = { createClaudeSignIn };
