'use strict';
// Help → support: Copy Diagnostics, Send Feedback and the update check. Diagnostics hold
// facts for a bug report only: no conversation text, account names, keys or file contents.
const vscode = require('vscode');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

/** Compares dotted versions ("0.10.2" > "0.9"); non-numeric parts count as 0. */
function newer(candidate, current) {
    const parts = value => String(value).replace(/^v/, '').split(/[.+-]/).slice(0, 3).map(part => Number.parseInt(part, 10) || 0);
    const [a, b] = [parts(candidate), parts(current)];
    for (let index = 0; index < 3; index++) if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) > (b[index] || 0);
    return false;
}
/** Validates an update feed: { version, url, notes? } with an https download page. */
function readFeed(value) {
    if (!value || typeof value.version !== 'string' || !/^v?\d+(\.\d+){0,2}/.test(value.version)) throw new Error('The update feed has no version.');
    const url = new URL(String(value.url || ''));
    if (url.protocol !== 'https:') throw new Error('The update feed must link to an https page.');
    return { version: value.version.replace(/^v/, ''), url: url.toString(), notes: typeof value.notes === 'string' ? value.notes.slice(0, 300) : '' };
}

function createSupport({ context, conversation, session, root, permission, sandbox, recent, lastStatus, status, fetcher = globalThis.fetch }) {
    const product = async () => JSON.parse(await fs.readFile(path.join(context.extensionPath, 'package.json'), 'utf8'));
    const home = os.homedir();
    const redact = value => String(value).split(home).join('~').replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>').replace(/\b(sk|sk-ant|sk-admin)-[\w-]{6,}/g, '<key>');
    async function diagnostics() {
        const chat = conversation.snapshot(), info = await product(), usage = chat.usage;
        return [
            `Furnace ${info.version} · Code OSS ${vscode.version} · Electron ${process.versions.electron} · Node ${process.versions.node}`,
            `OS: ${os.type()} ${os.release()} ${os.arch()} · session ${process.env.XDG_SESSION_TYPE || 'unknown'} · zoom ${vscode.workspace.getConfiguration('window').get('zoomLevel')}`,
            `Project: ${root() ? `open, ${vscode.workspace.isTrusted ? 'trusted' : 'restricted'}` : 'none'} · permissions ${permission()} · sandbox ${sandbox.path ? 'available' : 'unavailable'} · mode ${session.state.mode}`,
            `Model: ${chat.model || 'none'} · context ${usage ? `~${usage.used} of ${usage.window} tokens (${usage.source || 'estimated'}), ${usage.condensed} summaries` : 'n/a'}`,
            `Connections: ${(chat.connections.connections || []).map(item => `${item.provider}=${item.connected ? 'connected' : 'not connected'}${item.error ? ` (${redact(item.error).slice(0, 160)})` : ''}`).join('; ') || 'not discovered'}`,
            `Conversation: ${chat.messages.length} messages · busy ${chat.busy} · queued ${chat.queue.length} · background processes ${chat.processes.filter(item => item.status === 'running').length} · rules ${chat.rules.length}`,
            chat.error ? `Last error: ${redact(chat.error).slice(0, 300)}` : `Last status: ${redact(lastStatus() || 'none').slice(0, 300)}`,
            '', 'Recent log:', ...recent.slice(-80).map(redact),
        ].join('\n');
    }
    async function copyDiagnostics() {
        await vscode.env.clipboard.writeText(await diagnostics());
        status('Diagnostics copied to the clipboard. They contain no conversation text, keys or account names; check before sharing.');
    }
    // Feedback goes to the product's issue page or email (package.json "support"); without
    // either it is copied for the user to send. Nothing is sent without the user's action.
    async function sendFeedback() {
        const summary = await vscode.window.showInputBox({ title: 'Send Feedback', prompt: 'What happened, or what would you like changed?', placeHolder: 'For example: the approval card hid my last message', ignoreFocusOut: true, validateInput: value => value.trim().length < 5 ? 'Describe it in a few words.' : value.length > 2000 ? 'Keep it under 2,000 characters.' : null });
        if (!summary) return;
        const include = await vscode.window.showQuickPick([
            { label: 'Include diagnostics', description: 'Versions, settings and recent log lines; no conversation text, keys or account names', value: true },
            { label: 'Only my message', value: false }], { title: 'Send Feedback', ignoreFocusOut: true });
        if (!include) return;
        const info = await product(), support = info.support || {};
        const body = `${summary.trim()}\n\n${include.value ? `---\n${await diagnostics()}` : `Furnace ${info.version} · ${os.type()} ${os.arch()}`}`;
        const title = `Feedback: ${summary.trim().split('\n')[0].slice(0, 80)}`;
        if (support.issues) {
            const url = new URL(support.issues); url.searchParams.set('title', title); url.searchParams.set('body', body.slice(0, 6000));
            if (await vscode.env.openExternal(vscode.Uri.parse(url.toString()))) return status('Feedback opened in your browser. Check it, then submit it there.');
        }
        if (support.email) {
            const mail = `mailto:${support.email}?subject=${encodeURIComponent(title)}&body=${encodeURIComponent(body.slice(0, 1800))}`;
            if (await vscode.env.openExternal(vscode.Uri.parse(mail))) return status('Feedback opened in your email app. Check it, then send it.');
        }
        await vscode.env.clipboard.writeText(body);
        status('Feedback copied to the clipboard; paste it wherever you report issues.');
    }
    // Daily check of a JSON feed ({ version, url, notes }) named in package.json "updates.feed".
    // No feed configured, or aiGui.updates.check off: nothing is fetched.
    async function checkForUpdates(manual = false) {
        const info = await product(), feed = info.updates?.feed;
        if (!feed) { if (manual) status('This build has no update feed. Download new versions from where you got Furnace.'); return null; }
        if (!manual && !vscode.workspace.getConfiguration('aiGui.updates').get('check', true)) return null;
        if (!manual && Date.now() - (context.globalState.get('updateCheckedAt') || 0) < 20 * 3600 * 1000) return null;
        let latest;
        try {
            const response = await fetcher(feed, { signal: AbortSignal.timeout(10000), headers: { accept: 'application/json' } });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            latest = readFeed(await response.json());
        } catch (error) { if (manual) status(`Could not check for updates: ${error.message}`); return null; }
        await context.globalState.update('updateCheckedAt', Date.now());
        if (!newer(latest.version, info.version)) { if (manual) status(`Furnace ${info.version} is up to date.`); return null; }
        if (!manual && context.globalState.get('updateSkipped') === latest.version) return latest;
        const choice = await vscode.window.showInformationMessage(`Furnace ${latest.version} is available (you have ${info.version}).${latest.notes ? ` ${latest.notes}` : ''}`, 'Download', 'Skip This Version');
        if (choice === 'Download') await vscode.env.openExternal(vscode.Uri.parse(latest.url));
        if (choice === 'Skip This Version') await context.globalState.update('updateSkipped', latest.version);
        return latest;
    }
    return { diagnostics, copyDiagnostics, sendFeedback, checkForUpdates, redact };
}
module.exports = { createSupport, newer, readFeed };
