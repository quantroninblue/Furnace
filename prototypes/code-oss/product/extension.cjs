const vscode = require('vscode');
const fs = require('node:fs/promises');
const { content } = require('./interface.cjs');
const { AssistantClient } = require('./assistant-client.cjs');
const { Conversation } = require('../../shared/assistant/conversation.cjs');
const { AgentWorkspace, AgentFileReviews, IdeToolHost } = require('./agent-workspace.cjs');
const { execFile } = require('node:child_process');
const { findClaude } = require('../../shared/assistant/main/claude-discovery.ts');
const path = require('node:path');
const { ResearchController } = require('./research-controller.cjs');
let activeResearch, activeConversation;
exports.deactivate = async () => { await activeConversation?.dispose(); await activeResearch?.dispose(); };
const { ProductSession, ProductReview } = require('../../shared/product-core.cjs');
const { CodeOssDocuments } = require('./document-adapter.cjs');

exports.activate = async context => {
    await fs.mkdir(context.globalStorageUri.fsPath, { recursive: true });
    const session = new ProductSession(context.workspaceState.get('session'));
    const views = new Set();
    let home;
    let lastStatus = '';
    let saveQueue = Promise.resolve();
    const scope = () => vscode.workspace.workspaceFolders?.map(folder => folder.name).join(', ') || 'No project needed';
    let conversation, files;
    // Status bar mirrors the original app's connection indicator; it opens Connections.
    const indicator = vscode.window.createStatusBarItem('aiGui.model', vscode.StatusBarAlignment.Left, 100);
    indicator.name = 'AI GUI Model'; indicator.command = 'aiGui.connections'; indicator.show();
    context.subscriptions.push(indicator);
    const showIndicator = chat => {
        const model = chat?.connections.models?.find(item => item.id === chat.model);
        indicator.text = model ? `$(circle-filled) ${model.name}` : chat?.connections.models?.length ? '$(circle-outline) Choose a model' : '$(plug) Connect a model';
        indicator.tooltip = model ? `Active model: ${model.name}. Click to manage connections.` : 'Open AI GUI connections';
    };
    const broadcast = () => {
        const chat = conversation?.snapshot(); showIndicator(chat);
        for (const view of views) void view.postMessage({ type: 'state', state: session.snapshot(), scope: scope(), review: reviews.state(), research: research.snapshot(), chat, status: lastStatus });
    };
    const status = text => { lastStatus = text; broadcast(); };
    const documents = new CodeOssDocuments(context, uri => {
        files?.invalidate(uri);
        if (!uri || session.proposal?.uri === uri) {
            reviews.discard();
            status('Review expired because the document or workspace closed.');
        }
    });
    const reviews = new ProductReview(session, documents, broadcast);
    const research = new ResearchController({ executable: process.execPath, entry: path.join(context.extensionPath, 'research/entry.cjs') }, broadcast);
    activeResearch = research;
    context.subscriptions.push({ dispose: () => { void research.dispose(); } });
    context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => { void conversation.switch().catch(error => status(error.message)); }));
    context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => {
        if (event.reason === vscode.TextDocumentChangeReason.Undo || event.reason === vscode.TextDocumentChangeReason.Redo) {
            if (!documents.isSource(event.document)) return;
            conversation.record(`User ${event.reason === vscode.TextDocumentChangeReason.Undo ? 'undid' : 'redid'} an editor change in ${event.document.uri.toString()}. Read the current document before proposing another edit.`);
            void conversation.save(); broadcast();
        }
    }));
    context.subscriptions.push({ dispose: () => reviews.discard() });
    files = new AgentFileReviews(documents, reviews);
    const provider = new AssistantClient({ executable: process.execPath, entry: path.join(context.extensionPath, 'assistant/entry.cjs'), directory: path.join(context.globalStorageUri.fsPath, 'connections') });
    const root = () => vscode.workspace.workspaceFolders?.[0]?.uri.scheme === 'file' ? vscode.workspace.workspaceFolders[0].uri.fsPath : null;
    // Agent permissions (Codex-style) and the optional Landlock command sandbox.
    const permission = () => { const value = vscode.workspace.getConfiguration('aiGui.agent').get('permissions'); return ['ask', 'auto', 'full'].includes(value) ? value : 'auto'; };
    const sandbox = { path: null };
    const helper = path.join(context.extensionPath, 'sandbox/ai-gui-sandbox');
    execFile(helper, ['--probe'], { timeout: 5000 }, (error, stdout) => { if (!error && stdout.startsWith('ok')) { sandbox.path = helper; broadcast(); } });
    context.subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(() => broadcast()));
    // VS Code's own trust dialog (proposed workspaceTrust API), with the trust editor as fallback.
    async function requestTrust() {
        if (vscode.workspace.isTrusted) return true;
        if (typeof vscode.workspace.requestWorkspaceTrust === 'function') {
            try { await vscode.workspace.requestWorkspaceTrust({ message: `Trust ${path.basename(root() || 'this folder')} so the AI GUI agent can read, edit and create files and run commands in it (within your permission mode).` }); }
            catch { await vscode.commands.executeCommand('workbench.trust.manage'); }
        } else await vscode.commands.executeCommand('workbench.trust.manage');
        broadcast(); return vscode.workspace.isTrusted;
    }
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('aiGui.agent')) broadcast(); }));
    // Read-only before/after documents for approval previews.
    const previews = new Map();
    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('ai-gui-preview', { provideTextDocumentContent: uri => previews.get(uri.path) ?? '' }));
    conversation = new Conversation({ directory: path.join(context.globalStorageUri.fsPath, 'conversations'), session, research, provider,
        adapter: { root, trusted: () => vscode.workspace.isTrusted, captureActive: () => documents.captureActive(), files,
            workspace: () => root() && vscode.workspace.isTrusted ? new AgentWorkspace(root(), documents) : null,
            permission, toolHost: () => new IdeToolHost({ root: root(), trusted: vscode.workspace.isTrusted, sandbox: sandbox.path }),
            agentState: () => ({ sandbox: !!sandbox.path, project: root() ? { name: path.basename(root()), trusted: vscode.workspace.isTrusted } : null }),
            environment: () => !root() ? 'No project folder is open: file tools accept absolute paths only, and commands start in the home folder. Suggest Open Folder (above the message box) for project work.'
                : vscode.workspace.isTrusted ? `Project folder: ${root()} (trusted). Command sandbox: ${sandbox.path ? 'available' : 'unavailable, so commands ask in Auto mode'}.`
                : `Project folder: ${root()} is in Restricted Mode (not trusted), so file and command tools are disabled. Tell the user to click "Trust Folder" above the message box, then ask again.`,
            clear: () => files.clear() }, changed: broadcast });
    activeConversation = conversation;
    let loginTerminal;
    context.subscriptions.push({ dispose: () => { loginTerminal?.dispose(); void conversation.dispose(); } });
    // Claude Code owns its sign-in; rediscover once its terminal exits so the panel reflects the CLI's state.
    context.subscriptions.push(vscode.window.onDidCloseTerminal(async terminal => {
        if (terminal !== loginTerminal) return;
        loginTerminal = undefined;
        try {
            await conversation.connect({ action: 'discover' });
            const claude = conversation.connections.connections?.find(item => item.provider === 'claude-code');
            status(claude?.connected ? 'Claude Code is connected. Choose a Claude model under Active model.' : `Claude Code is not signed in${claude?.error ? `: ${claude.error}` : '.'} Retry sign-in, then refresh connections.`);
        } catch (error) { status(`${error.message} Refresh connections when ready.`); }
    }));
    const save = () => {
        const snapshot = session.snapshot(); void conversation.save();
        saveQueue = saveQueue.then(() => context.workspaceState.update('session', snapshot)).catch(error => status(`Could not save draft: ${error.message}`));
    };
    function attach(webview, surface, disposables) {
        webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')] };
        views.add(webview);
        disposables.push({ dispose: () => views.delete(webview) });
        disposables.push(webview.onDidReceiveMessage(async message => {
            try {
                if (!message || typeof message.type !== 'string') return;
                if (message.sessionId && message.sessionId !== conversation.data.id) throw new Error('Conversation changed. Use its current controls.');
                if (['mode', 'draft', 'brief'].includes(message.type)) {
                    session.update(message.type, message.value); save(); broadcast();
                    if (message.type === 'mode') await showHome();
                } else if (message.type === 'ready') broadcast();
                else if (message.type === 'home') await showHome();
                else if (message.type === 'openFolder') await vscode.commands.executeCommand('workbench.action.files.openFolder');
                else if (message.type === 'openFile') await vscode.commands.executeCommand('workbench.action.files.openFile');
                else if (message.type === 'researchOpen') await research.open(message.value);
                else if (message.type === 'researchClose') await research.close();
                else if (message.type === 'captureSelection' || message.type === 'capturePage') { await research.capture(message.type === 'capturePage' ? 'page' : 'selection'); await conversation.save(); }
                else if (message.type === 'sourceShare') research.share(message.id, message.enabled);
                else if (message.type === 'sourceRemove') { research.remove(message.id); await conversation.save(); }
                else if (message.type === 'send') {
                    if (['Build', 'Plan'].includes(session.state.mode) && root() && !vscode.workspace.isTrusted) await requestTrust();
                    await conversation.send(message.value);
                }
                else if (message.type === 'stop') await conversation.stop();
                else if (message.type === 'model') conversation.selectModel(message.value);
                else if (message.type === 'context') {
                    if (!['sharePlan', 'shareEditor'].includes(message.field) || typeof message.enabled !== 'boolean') throw new Error('Invalid sharing control.');
                    conversation[message.field] = message.enabled; broadcast();
                }
                else if (message.type === 'connections') await showConnections();
                else if (message.type === 'connection') { await conversation.connect(message.value); status('Connection details updated.'); }
                else if (message.type === 'newChat') { await conversation.switch(); save(); }
                else if (message.type === 'resumeChat') {
                    const list = await conversation.list();
                    const item = await vscode.window.showQuickPick(list.map(item => ({ label: item.title, description: `${item.messageCount} messages · ${item.updatedAt}`, id: item.id })), { placeHolder: 'Search saved conversations for this project' });
                    if (item) { await conversation.switch(item.id); save(); }
                }
                else if (message.type === 'approveProposal') await conversation.approve(message.id);
                else if (message.type === 'approval') conversation.decide(message.id, message.decision);
                else if (message.type === 'permission') {
                    if (!['ask', 'auto', 'full'].includes(message.value)) throw new Error('Unknown permission mode.');
                    if (message.value === 'full' && await vscode.window.showWarningMessage('Give the agent full access?', { modal: true, detail: 'The agent will edit and delete files anywhere and run commands without asking or a sandbox. Use only for projects you trust and tasks you supervise.' }, 'Allow Full Access') !== 'Allow Full Access') { broadcast(); return; }
                    await vscode.workspace.getConfiguration('aiGui.agent').update('permissions', message.value, vscode.ConfigurationTarget.Global);
                    status({ ask: 'Ask: the agent asks before each change and command.', auto: `Auto: project edits apply directly${sandbox.path ? '; commands run sandboxed' : '; commands ask first (sandbox unavailable)'}.`, full: 'Full access: no approvals and no sandbox.' }[message.value]);
                }
                else if (message.type === 'trustFolder') await requestTrust();
                else if (message.type === 'openDiff') {
                    const files = conversation.approvalFiles(message.id);
                    if (!files?.length) throw new Error('This change is no longer pending.');
                    for (const [index, file] of files.slice(0, 10).entries()) {
                        const key = `/${message.id}/${index}/${path.basename(file.path)}`;
                        previews.set(key + '.before', file.before); previews.set(key + '.after', file.after);
                        await vscode.commands.executeCommand('vscode.diff', vscode.Uri.from({ scheme: 'ai-gui-preview', path: key + '.before' }), vscode.Uri.from({ scheme: 'ai-gui-preview', path: key + '.after' }), `Proposed: ${file.path}`, { preview: files.length === 1 });
                    }
                }
                else if (message.type === 'discardProposal') await conversation.discard(message.id);
                else if (message.type === 'run') await conversation.run(message.value);
                else if (message.type === 'attach') {
                    const chosen = await vscode.window.showOpenDialog({ canSelectMany: true, canSelectFiles: true, canSelectFolders: false, title: 'Import context attachments' });
                    if (chosen) await conversation.attach(chosen.map(uri => uri.fsPath));
                }
                else if (message.type === 'attachmentShare') {
                    const item = conversation.attachments.find(a => a.id === message.id);
                    if (!item || typeof message.enabled !== 'boolean' || typeof item.text !== 'string') throw new Error('This attachment has no extracted text.');
                    item.shared = message.enabled; broadcast();
                }
                else if (message.type === 'attachmentRemove') { conversation.attachments = conversation.attachments.filter(a => a.id !== message.id); await conversation.save(); broadcast(); }
                else if (message.type === 'chatgptUsage') await vscode.env.openExternal(vscode.Uri.parse('https://chatgpt.com/settings/usage'));
                else if (message.type === 'claudeLogin' || message.type === 'claudeConsole') {
                    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before launching a sign-in terminal.');
                    // Never replace a running sign-in: its browser authorization would lose its callback.
                    if (loginTerminal && !loginTerminal.exitStatus) { loginTerminal.show(); status('Claude Code sign-in is already open. Finish it in the terminal, or close that terminal to start again.'); return; }
                    const executable = await findClaude(); if (!executable) throw new Error('Install Claude Code separately, then refresh Connections.');
                    loginTerminal?.dispose();
                    loginTerminal = vscode.window.createTerminal({ name: 'Claude Code sign-in', shellPath: executable, shellArgs: ['auth', 'login', ...(message.type === 'claudeConsole' ? ['--console'] : [])], cwd: context.globalStorageUri.fsPath });
                    loginTerminal.show();
                    status('Complete Claude Code sign-in in the terminal. If the browser shows a code, paste it there. Connections refresh when it finishes.');
                }
                else if (message.type === 'propose') await vscode.commands.executeCommand('aiGui.proposeFixture');
                else if (['apply', 'discard'].includes(message.type)) {
                    if (message.generation !== reviews.generation) throw new Error('Review expired. Use the current review controls.');
                    await vscode.commands.executeCommand(message.type === 'apply' ? 'aiGui.applyReview' : 'aiGui.discardReview');
                }
            } catch (error) { status(error.message); }
        }));
        webview.html = content(webview, context.extensionUri, surface);
    }
    async function showHome() {
        if (home) home.reveal(vscode.ViewColumn.One, true);
        else {
            home = vscode.window.createWebviewPanel('aiGui.workspace', 'Workspace', { viewColumn: vscode.ViewColumn.One, preserveFocus: true }, { retainContextWhenHidden: true });
            const disposables = [];
            attach(home.webview, 'home', disposables);
            home.onDidDispose(() => { for (const disposable of disposables) disposable.dispose(); home = undefined; });
        }
        broadcast();
    }
    context.subscriptions.push(vscode.window.registerWebviewViewProvider('aiGui.conversation', {
        resolveWebviewView(view) {
            const disposables = [];
            attach(view.webview, 'conversation', disposables);
            view.onDidDispose(() => { for (const disposable of disposables) disposable.dispose(); });
        }
    }, { webviewOptions: { retainContextWhenHidden: true } }));
    async function showConnections() {
        await showHome(); void home.webview.postMessage({ type: 'connections' });
        if (!conversation.connecting) { conversation.connections = await provider.status(); broadcast(); }
    }
    context.subscriptions.push(vscode.commands.registerCommand('aiGui.home', showHome));
    context.subscriptions.push(vscode.commands.registerCommand('aiGui.connections', () => showConnections().catch(error => status(error.message))));
    const command = (name, action) => context.subscriptions.push(vscode.commands.registerCommand(name, async () => {
        try { return await action(); } catch (error) { status(error.message); throw error; }
    }));
    command('aiGui.proposeFixture', async () => {
        const proposal = await reviews.proposeFixture();
        status('Review the proposed side and edit it if needed. Apply changes to the editor buffer when ready.');
        return proposal;
    });
    command('aiGui.applyReview', async () => {
        await reviews.apply(); await conversation.reviewResult('applied');
        status('Applied to the editor buffer. Use Undo to reverse it; save normally when ready.');
    });
    command('aiGui.discardReview', () => {
        if (reviews.busy) throw new Error('A review operation is already in progress.');
        reviews.discard(); void conversation.reviewResult('discarded'); status('Proposal discarded. Your source document is unchanged.');
    });
    context.subscriptions.push(vscode.commands.registerCommand('aiGui.openResearch', async () => {
        session.update('mode', 'Research'); save(); await showHome();
    }));
    context.subscriptions.push({ dispose: () => home?.dispose() });
    if (vscode.workspace.getConfiguration('aiGui').get('openOnStartup')) {
        void showHome();
        void vscode.commands.executeCommand('aiGui.conversation.focus');
    }
    return { session, reviews, research, conversation, documents, showHome, status, save: async () => { await saveQueue; await conversation.save(); } };
};
