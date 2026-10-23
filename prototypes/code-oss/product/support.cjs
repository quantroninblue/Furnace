'use strict';
// Help → support: Copy Diagnostics, Send Feedback and the update check. Diagnostics hold
// facts for a bug report only: no conversation text, account names, keys or file contents.
const vscode = require('vscode');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const updater = require('./updater.cjs');
const { newer, readFeed } = updater;

function createSupport({
    context,
    conversation,
    session,
    root,
    permission,
    sandbox,
    recent,
    lastStatus,
    status,
    fetcher = globalThis.fetch,
    spawner,
}) {
    const product = async () => JSON.parse(await fs.readFile(path.join(context.extensionPath, 'package.json'), 'utf8'));
    const home = os.homedir();
    const redact = value =>
        String(value)
            .split(home)
            .join('~')
            .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>')
            .replace(/\b(sk|sk-ant|sk-admin)-[\w-]{6,}/g, '<key>');
    async function diagnostics() {
        const chat = conversation.snapshot(),
            info = await product(),
            usage = chat.usage;
        return [
            `Furnace ${info.version} · Code OSS ${vscode.version} · Electron ${process.versions.electron} · Node ${process.versions.node}`,
            `OS: ${os.type()} ${os.release()} ${os.arch()} · session ${process.env.XDG_SESSION_TYPE || 'unknown'} · zoom ${vscode.workspace.getConfiguration('window').get('zoomLevel')}`,
            `Project: ${root() ? `open, ${vscode.workspace.isTrusted ? 'trusted' : 'restricted'}` : 'none'} · permissions ${permission()} · sandbox ${sandbox.path ? 'available' : 'unavailable'} · mode ${session.state.mode}`,
            `Model: ${chat.model || 'none'} · context ${usage ? `~${usage.used} of ${usage.window} tokens (${usage.source || 'estimated'}), ${usage.condensed} summaries` : 'n/a'}`,
            `Connections: ${(chat.connections.connections || []).map(item => `${item.provider}=${item.connected ? 'connected' : 'not connected'}${item.error ? ` (${redact(item.error).slice(0, 160)})` : ''}`).join('; ') || 'not discovered'}`,
            `Conversation: ${chat.messages.length} messages · busy ${chat.busy} · queued ${chat.queue.length} · background processes ${chat.processes.filter(item => item.status === 'running').length} · rules ${chat.rules.length}`,
            chat.error
                ? `Last error: ${redact(chat.error).slice(0, 300)}`
                : `Last status: ${redact(lastStatus() || 'none').slice(0, 300)}`,
            '',
            'Recent log:',
            ...recent.slice(-80).map(redact),
        ].join('\n');
    }
    async function copyDiagnostics() {
        await vscode.env.clipboard.writeText(await diagnostics());
        status(
            'Diagnostics copied to the clipboard. They contain no conversation text, keys or account names; check before sharing.',
        );
    }
    // Feedback goes to the product's issue page or email (package.json "support"); without
    // either it is copied for the user to send. Nothing is sent without the user's action.
    async function sendFeedback() {
        const summary = await vscode.window.showInputBox({
            title: 'Send Feedback',
            prompt: 'What happened, or what would you like changed?',
            placeHolder: 'For example: the approval card hid my last message',
            ignoreFocusOut: true,
            validateInput: value =>
                value.trim().length < 5
                    ? 'Describe it in a few words.'
                    : value.length > 2000
                      ? 'Keep it under 2,000 characters.'
                      : null,
        });
        if (!summary) return;
        const include = await vscode.window.showQuickPick(
            [
                {
                    label: 'Include diagnostics',
                    description: 'Versions, settings and recent log lines; no conversation text, keys or account names',
                    value: true,
                },
                { label: 'Only my message', value: false },
            ],
            { title: 'Send Feedback', ignoreFocusOut: true },
        );
        if (!include) return;
        const info = await product(),
            support = info.support || {};
        const body = `${summary.trim()}\n\n${include.value ? `---\n${await diagnostics()}` : `Furnace ${info.version} · ${os.type()} ${os.arch()}`}`;
        const title = `Feedback: ${summary.trim().split('\n')[0].slice(0, 80)}`;
        if (support.issues) {
            const url = new URL(support.issues);
            url.searchParams.set('title', title);
            url.searchParams.set('body', body.slice(0, 6000));
            if (await vscode.env.openExternal(vscode.Uri.parse(url.toString())))
                return status('Feedback opened in your browser. Check it, then submit it there.');
        }
        if (support.email) {
            const mail = `mailto:${support.email}?subject=${encodeURIComponent(title)}&body=${encodeURIComponent(body.slice(0, 1800))}`;
            if (await vscode.env.openExternal(vscode.Uri.parse(mail)))
                return status('Feedback opened in your email app. Check it, then send it.');
        }
        await vscode.env.clipboard.writeText(body);
        status('Feedback copied to the clipboard; paste it wherever you report issues.');
    }
    // Daily check of the update feed named in package.json "updates" (release builds only). With a
    // public key the feed must be signed, and Update downloads, verifies and installs the new version
    // in place (updater.cjs); otherwise, or where Furnace can't replace itself, Download opens the
    // release page. No feed configured, or aiGui.updates.check off: nothing is fetched.
    const updatesDir = () => path.join(context.globalStorageUri.fsPath, 'updates');
    let ready = null; // { version, dir } once an update is staged and its installer is waiting.
    async function checkForUpdates(manual = false) {
        const info = await product(),
            updates = info.updates || {};
        if (!updates.feed) {
            if (manual) status('This build has no update feed. Download new versions from where you got Furnace.');
            return null;
        }
        if (!manual && !vscode.workspace.getConfiguration('aiGui.updates').get('check', true)) return null;
        if (!manual && Date.now() - (context.globalState.get('updateCheckedAt') || 0) < 20 * 3600 * 1000) return null;
        let latest;
        try {
            latest = await updater.fetchFeed(updates, fetcher);
        } catch (error) {
            if (manual) status(`Could not check for updates: ${error.message}`);
            return null;
        }
        await context.globalState.update('updateCheckedAt', Date.now());
        if (!newer(latest.version, info.version)) {
            if (manual) status(`Furnace ${info.version} is up to date.`);
            return null;
        }
        if (ready?.version === latest.version) {
            await offerRestart(latest.version);
            return latest;
        }
        if (!manual && context.globalState.get('updateSkipped') === latest.version) return latest;
        // A release can ship before every platform's build (CI publishes what passed): until this
        // platform's download is added, the release page has nothing for it, so don't offer it yet.
        if (!updater.releasedFor(latest)) {
            if (manual) status(`Furnace ${latest.version} is out, but not for this computer yet. It follows soon.`);
            return null;
        }
        const target = updater.installTarget({ appRoot: vscode.env.appRoot });
        const asset = target.ok ? latest.assets[updater.assetKey(target)] : latest.assets[updater.platformKey()];
        const inPlace = Boolean(updates.publicKey && asset && target.ok);
        const message = `Furnace ${latest.version} is available (you have ${info.version}).${latest.notes ? ` ${latest.notes}` : ''}`;
        for (;;) {
            const choice = await vscode.window.showInformationMessage(
                message,
                ...(inPlace ? ['Update', 'Release Notes'] : ['Download']),
                'Skip This Version',
            );
            if (choice === 'Release Notes') {
                await vscode.env.openExternal(vscode.Uri.parse(latest.url));
                continue;
            }
            if (choice === 'Download') await vscode.env.openExternal(vscode.Uri.parse(latest.url));
            if (choice === 'Skip This Version') await context.globalState.update('updateSkipped', latest.version);
            if (choice === 'Update') await installUpdate(latest, asset, target);
            if (choice === 'Download' && asset && !target.ok) status(target.reason);
            return latest;
        }
    }
    async function installUpdate(latest, asset, target) {
        const dir = path.join(updatesDir(), latest.version),
            file = path.join(dir, asset.file);
        try {
            if (!(await updater.verified(asset, file))) {
                const done = await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: `Downloading Furnace ${latest.version}`,
                        cancellable: true,
                    },
                    async (progress, token) => {
                        const abort = new AbortController(),
                            cancel = token.onCancellationRequested(() => abort.abort());
                        let reported = 0;
                        try {
                            await updater.download(asset, file, {
                                fetcher,
                                signal: abort.signal,
                                onProgress: (received, total) => {
                                    const percent = Math.floor((received / total) * 100);
                                    if (percent > reported) {
                                        progress.report({
                                            increment: percent - reported,
                                            message: `${Math.round(received / 1048576)} of ${Math.round(total / 1048576)} MB`,
                                        });
                                        reported = percent;
                                    }
                                },
                            });
                            return true;
                        } catch (error) {
                            if (token.isCancellationRequested) return false;
                            throw error;
                        } finally {
                            cancel.dispose();
                        }
                    },
                );
                if (!done) return status('Update cancelled.');
            }
            const staged = await updater.stage(target, file, dir);
            await updater.startInstaller({ target, staged, dir, pid: process.ppid, spawner });
            ready = { version: latest.version, dir, platform: target.platform };
            await context.globalState.update('updateStaged', { version: latest.version });
            await offerRestart(latest.version);
        } catch (error) {
            const choice = await vscode.window.showErrorMessage(
                `Furnace couldn't update itself: ${error.message}`,
                'Download Instead',
            );
            if (choice === 'Download Instead') await vscode.env.openExternal(vscode.Uri.parse(latest.url));
        }
    }
    async function offerRestart(version) {
        const password = ready.platform === 'linux' ? ' Linux will ask for your password to install it.' : '';
        const choice = await vscode.window.showInformationMessage(
            `Furnace ${version} is ready. Restart now to finish updating, or it installs the next time you quit Furnace.${password}`,
            'Restart Now',
            'Later',
        );
        if (choice !== 'Restart Now') return;
        await updater.requestRelaunch(ready.dir);
        await vscode.commands.executeCommand('workbench.action.quit');
    }
    // After an update (or a staged one that is no longer newer), remove its downloads.
    async function cleanUpdates() {
        const info = await product(),
            staged = context.globalState.get('updateStaged');
        if (!staged || newer(staged.version, info.version)) return;
        await fs.rm(updatesDir(), { recursive: true, force: true });
        await context.globalState.update('updateStaged', undefined);
    }
    return { diagnostics, copyDiagnostics, sendFeedback, checkForUpdates, cleanUpdates, redact };
}
module.exports = { createSupport, newer, readFeed };
