const vscode = require('vscode');
const fs = require('node:fs/promises');
const os = require('node:os');
const { content } = require('./interface.cjs');
const { AssistantClient } = require('./assistant-client.cjs');
const { Conversation } = require('../../shared/assistant/conversation.cjs');
const { AgentWorkspace, AgentFileReviews, IdeToolHost } = require('./agent-workspace.cjs');
const { execFile } = require('node:child_process');
const { findClaude } = require('../../shared/assistant/main/claude-discovery.ts');
const { buildFromPlanPrompt } = require('../../shared/assistant/main/plan-link.ts');
const path = require('node:path');
const { ResearchController } = require('./research-controller.cjs');
const { gitChanges, problemsText, selectionText, searchPaths } = require('./ide-context.cjs');
const { CommandTerminals } = require('./terminals.cjs');
const { AgentChanges } = require('./agent-scm.cjs');
let activeResearch, activeConversation;
exports.deactivate = async () => { await activeConversation?.dispose(); await activeResearch?.dispose(); };
const { ProductSession, ProductReview, modes } = require('../../shared/product-core.cjs');
const { CodeOssDocuments } = require('./document-adapter.cjs');

exports.activate = async context => {
    await fs.mkdir(context.globalStorageUri.fsPath, { recursive: true });
    const session = new ProductSession(context.workspaceState.get('session'));
    // In-app log (Output → AI GUI); the newest lines also go into "Copy Diagnostics".
    const output = vscode.window.createOutputChannel('AI GUI', { log: true });
    context.subscriptions.push(output);
    const recent = [];
    const log = (level, text) => { recent.push(`${new Date().toISOString()} ${level} ${text}`); if (recent.length > 200) recent.shift(); output[level]?.(text); };
    // Webview → per-view sync state (see webview/protocol.ts): the conversation surface gets
    // only the messages that changed since its last update.
    const views = new Map();
    let homeView;
    let lastStatus = '';
    let saveQueue = Promise.resolve();
    const scope = () => vscode.workspace.workspaceFolders?.map(folder => folder.name).join(', ') || 'No project needed';
    let conversation, files, scm;
    // Status bar mirrors the original app's connection indicator; it opens Connections.
    const indicator = vscode.window.createStatusBarItem('aiGui.model', vscode.StatusBarAlignment.Left, 100);
    indicator.name = 'AI GUI Model'; indicator.command = 'aiGui.connections'; indicator.show();
    context.subscriptions.push(indicator);
    const showIndicator = chat => {
        const model = chat?.connections.models?.find(item => item.id === chat.model);
        indicator.text = model ? `$(circle-filled) ${model.name}` : chat?.connections.models?.length ? '$(circle-outline) Choose a model' : '$(plug) Connect a model';
        indicator.tooltip = model ? `Active model: ${model.name}. Click to manage connections.` : 'Open AI GUI connections';
    };
    // First-run tutorial progress (global, survives restarts). The first agent reply
    // with tool steps completes the "first task" step.
    let tour = { dismissed: false, seen: {}, ...context.globalState.get('tour') };
    const updateTour = changes => { tour = { ...tour, ...changes, seen: { ...tour.seen, ...changes.seen } }; void context.globalState.update('tour', tour); };
    // The model last chosen in each mode is selected again when switching to that mode.
    const modeModels = { ...context.globalState.get('modeModels') };
    // Context keys drive keyboard shortcuts (approve/deny/stop only when they apply).
    const keys = {};
    const setKey = (name, value) => { if (keys[name] !== value) { keys[name] = value; void vscode.commands.executeCommand('setContext', name, value); } };
    // Streaming produces many changes per second; views are updated at most once a frame.
    let flushTimer;
    const broadcast = () => { flushTimer ??= setTimeout(flush, 16); };
    function flush() {
        flushTimer = undefined;
        const chat = conversation?.snapshot(); showIndicator(chat);
        if (!tour.seen.task && chat?.messages.some(message => message.role === 'assistant' && message.steps?.length && message.state === 'complete')) updateTour({ seen: { task: true } });
        setKey('aiGui.busy', !!chat?.busy); setKey('aiGui.approvalPending', !!conversation?.approvals.size);
        scm?.update();
        const { messages = [], ...meta } = chat || {};
        const base = { type: 'state', state: session.snapshot(), scope: scope(), review: reviews.state(), research: research.snapshot(), chat: chat ? meta : null, status: lastStatus, tour, modeModels };
        const serialized = new Map();
        const json = message => { if (!serialized.has(message.id)) serialized.set(message.id, JSON.stringify(message)); return serialized.get(message.id); };
        for (const [webview, view] of views) {
            if (view.surface !== 'conversation') { void webview.postMessage(base); continue; }
            const sent = new Map(), upsert = [];
            for (const message of messages) { sent.set(message.id, json(message)); if (view.reset || view.sent.get(message.id) !== sent.get(message.id)) upsert.push(message); }
            void webview.postMessage({ ...base, messages: { reset: view.reset, order: messages.map(message => message.id), upsert } });
            view.sent = sent; view.reset = false;
        }
    }
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
    context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => { void conversation.switch().then(discoverConnections, error => status(error.message)); }));
    context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => {
        if (event.reason === vscode.TextDocumentChangeReason.Undo || event.reason === vscode.TextDocumentChangeReason.Redo) {
            if (!documents.isSource(event.document)) return;
            conversation.record(`User ${event.reason === vscode.TextDocumentChangeReason.Undo ? 'undid' : 'redid'} an editor change in ${vscode.workspace.asRelativePath(event.document.uri, false)}. Read the current document before proposing another edit.`);
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
    // Read-only before/after documents for approval and change previews.
    const previews = new Map();
    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('ai-gui-preview', { provideTextDocumentContent: uri => previews.get(uri.path) ?? '' }));
    const preview = (key, text) => { previews.set(key, text); return vscode.Uri.from({ scheme: 'ai-gui-preview', path: key }); };
    // Context the user can share: selection, Problems and Git changes. Sizes feed the context meter.
    const contextCache = { problems: null, diff: null };
    context.subscriptions.push(vscode.languages.onDidChangeDiagnostics(() => { contextCache.problems = null; broadcast(); }));
    context.subscriptions.push(vscode.window.onDidChangeTextEditorSelection(event => { if (documents.isSource(event.textEditor.document)) broadcast(); }));
    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => broadcast()));
    const contextInfo = () => {
        const editor = vscode.window.activeTextEditor, document = editor && documents.isSource(editor.document) ? editor.document : null;
        const selected = document ? editor.selections.filter(selection => !selection.isEmpty) : [];
        contextCache.problems ??= problemsText(root());
        return {
            editor: document ? document.offsetAt(document.lineAt(document.lineCount - 1).range.end) : 0,
            selection: selected.length ? { label: `${path.basename(document.uri.path)}:${selected[0].start.line + 1}${selected[0].end.line > selected[0].start.line ? `–${selected[0].end.line + 1}` : ''}${selected.length > 1 ? ` +${selected.length - 1}` : ''}`,
                chars: selected.reduce((sum, selection) => sum + document.offsetAt(selection.end) - document.offsetAt(selection.start), 0) } : null,
            problems: { count: contextCache.problems.count, errors: contextCache.problems.errors, chars: contextCache.problems.text.length },
            diff: contextCache.diff,
        };
    };
    const gather = async kind => {
        if (kind === 'selection') return selectionText(vscode.window.activeTextEditor, documents);
        if (kind === 'problems') { contextCache.problems = problemsText(root()); return contextCache.problems.text; }
        if (kind === 'diff') { const text = await gitChanges(root()); contextCache.diff = { chars: text.length }; broadcast(); return text; }
        return null;
    };
    const terminals = new CommandTerminals(() => vscode.workspace.getConfiguration('aiGui.agent').get('showCommandsInTerminal', true));
    context.subscriptions.push(terminals);
    const persist = () => {
        const snapshot = session.snapshot();
        saveQueue = saveQueue.then(() => context.workspaceState.update('session', snapshot)).catch(error => status(`Could not save draft: ${error.message}`));
    };
    conversation = new Conversation({ directory: path.join(context.globalStorageUri.fsPath, 'conversations'), session, research, provider,
        adapter: { root, trusted: () => vscode.workspace.isTrusted, captureActive: () => documents.captureActive(), files,
            workspace: () => root() && vscode.workspace.isTrusted ? new AgentWorkspace(root(), documents) : null,
            permission, toolHost: () => new IdeToolHost({ root: root(), trusted: vscode.workspace.isTrusted, sandbox: sandbox.path }),
            agentState: () => ({ sandbox: !!sandbox.path, project: root() ? { name: path.basename(root()), trusted: vscode.workspace.isTrusted } : null }),
            environment: () => !root() ? 'No project folder is open: file tools accept absolute paths only, and commands start in the home folder. Suggest Open Folder (above the message box) for project work.'
                : vscode.workspace.isTrusted ? `Project folder: ${root()} (trusted). Command sandbox: ${sandbox.path ? 'available' : 'unavailable, so commands ask in Auto mode'}.`
                : `Project folder: ${root()} is in Restricted Mode (not trusted), so file and command tools are disabled. Tell the user to click "Trust Folder" above the message box, then ask again.`,
            contextInfo, gather, terminals, persistSession: persist,
            clear: () => files.clear() }, changed: broadcast });
    activeConversation = conversation;
    // Agent changes in the built-in Source Control view, with diffs, revert and Git staging.
    scm = new AgentChanges(context, conversation, { root, preview, status, confirmConflicts: (run, action) => confirmConflicts(run, action), restored: (result, verb) => restored(result, verb) });
    // Connections are discovered on startup and after a folder change, not only on Refresh.
    const discoverConnections = () => conversation.connecting ? Promise.resolve()
        : conversation.connect({ action: 'discover' }).catch(error => status(`${error.message} Refresh connections when ready.`));
    // Desktop tests start without this machine's real connections unless they opt in.
    const connectionsReady = process.env.AI_GUI_TEST_NO_DISCOVERY ? Promise.resolve() : discoverConnections();
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
    const save = () => { void conversation.save(); persist(); };
    const text = (value, limit) => { if (typeof value !== 'string' || value.length > limit) throw new Error('Invalid message.'); return value; };
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
    const selectModeModel = mode => {
        const preferred = modeModels[mode];
        if (preferred && preferred !== conversation.data.model && !conversation.turn && conversation.connections.models.some(model => model.id === preferred)) conversation.selectModel(preferred);
    };
    const setMode = mode => { session.update('mode', mode); selectModeModel(mode); save(); broadcast(); };
    const startTurn = async (send) => {
        if (['Build', 'Plan'].includes(session.state.mode) && root() && !vscode.workspace.isTrusted) await requestTrust();
        await send();
    };
    // Every webview message is validated here; webview/protocol.ts lists them.
    const handlers = {
        ready: (_message, view) => { view.reset = true; broadcast(); },
        mode: message => setMode(message.value),
        draft: message => { session.update('draft', message.value); save(); broadcast(); },
        brief: message => { session.update('brief', message.value); save(); broadcast(); },
        home: () => showHome(),
        openFolder: () => vscode.commands.executeCommand('workbench.action.files.openFolder'),
        openFile: () => vscode.commands.executeCommand('workbench.action.files.openFile'),
        researchOpen: message => research.open(message.value),
        researchClose: () => research.close(),
        captureSelection: async () => { await research.capture('selection'); await conversation.save(); },
        capturePage: async () => { await research.capture('page'); await conversation.save(); },
        sourceShare: message => research.share(message.id, message.enabled),
        sourceRemove: async message => { research.remove(message.id); await conversation.save(); },
        // While the agent works, a sent message waits in the queue.
        send: message => conversation.busy() ? conversation.enqueue(text(message.value, 20000)) : startTurn(() => conversation.send(message.value)),
        enqueue: message => conversation.enqueue(text(message.value, 20000)),
        dequeue: message => conversation.dequeue(text(message.id, 100)),
        sendQueued: message => startTurn(() => conversation.sendQueued(text(message.id, 100))),
        stop: () => conversation.stop(),
        compact: async () => { await conversation.compact(); status(conversation.error || 'Earlier messages condensed into a summary.'); },
        model: message => { conversation.selectModel(message.value); modeModels[session.state.mode] = message.value; void context.globalState.update('modeModels', modeModels); },
        context: message => {
            if (!['sharePlan', 'shareEditor', 'shareSelection', 'shareDiff', 'shareProblems'].includes(message.field) || typeof message.enabled !== 'boolean') throw new Error('Invalid sharing control.');
            conversation[message.field] = message.enabled; broadcast();
            if (message.field === 'shareDiff' && message.enabled) void gather('diff').catch(() => {});
        },
        mentionSearch: async (message, view) => { void view.webview.postMessage({ type: 'mentions', query: message.value, items: await searchPaths(root(), text(message.value, 300)) }); },
        pasteImage: message => conversation.addImage({ name: text(message.name, 200), mime: text(message.mime, 40), data: text(message.data, 7000000) }),
        removeImage: message => conversation.removeImage(text(message.id, 100)),
        connections: () => showConnections(),
        connection: async message => { await conversation.connect(message.value); status('Connection details updated.'); },
        newChat: async () => { await conversation.switch(); save(); },
        resumeChat: () => showHistory(),
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
        buildPlan: async () => {
            if (!session.state.brief.trim()) throw new Error('Write a brief with a checklist (- [ ] step) on the Plan page first.');
            setMode('Build'); conversation.sharePlan = true;
            await startTurn(() => conversation.send(buildFromPlanPrompt(session.state.brief), { fromDraft: false }));
        },
        approveProposal: message => conversation.approve(message.id),
        approval: message => conversation.decide(message.id, message.decision),
        permission: async message => {
            if (!['ask', 'auto', 'full'].includes(message.value)) throw new Error('Unknown permission mode.');
            if (message.value === 'full' && await vscode.window.showWarningMessage('Give the agent full access?', { modal: true, detail: 'The agent will edit and delete files anywhere and run commands without asking or a sandbox. Use only for projects you trust and tasks you supervise.' }, 'Allow Full Access') !== 'Allow Full Access') { broadcast(); return; }
            await vscode.workspace.getConfiguration('aiGui.agent').update('permissions', message.value, vscode.ConfigurationTarget.Global);
            status({ ask: 'Ask: the agent asks before each change and command.', auto: `Auto: project edits apply directly${sandbox.path ? '; commands run sandboxed' : '; commands ask first (sandbox unavailable)'}.`, full: 'Full access: no approvals and no sandbox.' }[message.value]);
        },
        ruleAdd: async message => { const rule = await conversation.addRule({ effect: message.effect, kind: message.kind, pattern: text(message.pattern, 500) }); status(`Saved: ${rule.effect} ${rule.kind} ${rule.pattern}.`); },
        ruleRemove: message => conversation.removeRule(text(message.id, 100)),
        auditLoad: async (_message, view) => { void view.webview.postMessage({ type: 'audit', entries: await conversation.audit.read(root(), 300) }); },
        auditOpen: async () => {
            const file = conversation.audit.file(root());
            if (!await fs.stat(file).then(() => true, () => false)) throw new Error('Nothing has been recorded for this project yet.');
            await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: true });
        },
        auditClear: async (_message, view) => {
            if (await vscode.window.showWarningMessage('Clear the activity log for this project?', { modal: true }, 'Clear') !== 'Clear') return;
            await conversation.audit.clear(root()); void view.webview.postMessage({ type: 'audit', entries: [] });
        },
        processStop: message => conversation.processes.stop(text(message.id, 100)),
        processShow: message => conversation.processes.show(text(message.id, 100)),
        openScm: () => vscode.commands.executeCommand('workbench.view.scm'),
        keys: () => vscode.commands.executeCommand('workbench.action.openGlobalKeybindings', 'AI GUI'),
        diagnostics: () => copyDiagnostics(),
        trustFolder: () => requestTrust(),
        tour: message => { if (message.action === 'ack' && ['permissions', 'review'].includes(message.step)) updateTour({ seen: { [message.step]: true } }); broadcast(); },
        tourDismiss: () => { updateTour({ dismissed: true }); broadcast(); },
        tourShow: () => showTour(),
        tourExample: async () => {
            session.update('mode', 'Build'); session.update('draft', 'Create a file named hello.txt that says "Hello from AI GUI", then list the files in the project.'); save(); broadcast();
            await vscode.commands.executeCommand('aiGui.conversation.focus');
            status('Example ready in the message box. Press Enter to send it.');
        },
        focusConversation: () => vscode.commands.executeCommand('aiGui.conversation.focus'),
        textSmaller: () => textSize('textSmaller'), textLarger: () => textSize('textLarger'), textReset: () => textSize('textReset'),
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
            for (const [index, entry] of changed.slice(0, 10).entries()) {
                const key = `/${message.messageId}/${index}/${path.basename(entry.file)}`;
                const after = entry.after !== null && await fs.stat(entry.file).then(() => true, () => false) ? vscode.Uri.file(entry.file) : preview(key + '.after', entry.after ?? '');
                await vscode.commands.executeCommand('vscode.diff', preview(key + '.before', entry.before ?? ''), after, `${entry.path} (agent changes)`, { preview: changed.length === 1 });
            }
            if (changed.length > 10) status(`Showing 10 of ${changed.length} changed files.`);
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
        copy: async message => { await vscode.env.clipboard.writeText(text(message.text, 1000000)); },
        insertSnippet: async message => {
            const snippet = text(message.text, 1000000);
            const editor = vscode.window.activeTextEditor || vscode.window.visibleTextEditors[0];
            if (!editor) throw new Error('Open a file, place the cursor, then choose Insert.');
            if (!await editor.edit(edit => { for (const selection of editor.selections) edit.replace(selection, snippet); })) throw new Error('The editor refused the insertion.');
            await vscode.window.showTextDocument(editor.document, editor.viewColumn);
            status(`Inserted into ${path.basename(editor.document.uri.path)}. Undo (Ctrl+Z) reverses it.`);
        },
        discardProposal: message => conversation.discard(message.id),
        run: message => conversation.run(message.value),
        attach: async () => {
            const chosen = await vscode.window.showOpenDialog({ canSelectMany: true, canSelectFiles: true, canSelectFolders: false, title: 'Import context attachments' });
            if (chosen) await conversation.attach(chosen.map(uri => uri.fsPath));
        },
        attachmentShare: message => {
            const item = conversation.attachments.find(a => a.id === message.id);
            if (!item || typeof message.enabled !== 'boolean' || typeof item.text !== 'string') throw new Error('This attachment has no extracted text.');
            item.shared = message.enabled; broadcast();
        },
        attachmentRemove: async message => { conversation.attachments = conversation.attachments.filter(a => a.id !== message.id); await conversation.save(); broadcast(); },
        chatgptUsage: () => vscode.env.openExternal(vscode.Uri.parse('https://chatgpt.com/settings/usage')),
        claudeLogin: message => claudeSignIn(message.type), claudeConsole: message => claudeSignIn(message.type),
        propose: () => vscode.commands.executeCommand('aiGui.proposeFixture'),
        apply: message => reviewCommand(message, 'aiGui.applyReview'),
        discard: message => reviewCommand(message, 'aiGui.discardReview'),
    };
    async function reviewCommand(message, command) {
        if (message.generation !== reviews.generation) throw new Error('Review expired. Use the current review controls.');
        await vscode.commands.executeCommand(command);
    }
    async function claudeSignIn(type) {
        if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before launching a sign-in terminal.');
        // Never replace a running sign-in: its browser authorization would lose its callback.
        if (loginTerminal && !loginTerminal.exitStatus) { loginTerminal.show(); status('Claude Code sign-in is already open. Finish it in the terminal, or close that terminal to start again.'); return; }
        const executable = await findClaude(); if (!executable) throw new Error('Install Claude Code separately, then refresh Connections.');
        loginTerminal?.dispose();
        loginTerminal = vscode.window.createTerminal({ name: 'Claude Code sign-in', shellPath: executable, shellArgs: ['auth', 'login', ...(type === 'claudeConsole' ? ['--console'] : [])], cwd: context.globalStorageUri.fsPath });
        loginTerminal.show();
        status('Complete Claude Code sign-in in the terminal. If the browser shows a code, paste it there. Connections refresh when it finishes.');
    }
    function attach(webview, surface, disposables) {
        webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')] };
        const view = { surface, webview, sent: new Map(), reset: true };
        views.set(webview, view);
        disposables.push({ dispose: () => views.delete(webview) });
        disposables.push(webview.onDidReceiveMessage(async message => {
            try {
                if (!message || typeof message.type !== 'string' || !Object.hasOwn(handlers, message.type)) return;
                if (message.sessionId && message.sessionId !== conversation.data.id && !message.type.startsWith('history')) throw new Error('Conversation changed. Use its current controls.');
                if (message.type === 'mode' && !modes.includes(message.value)) throw new Error('Unknown mode.');
                await handlers[message.type](message, view);
            } catch (error) { log('error', `${message?.type}: ${error.message}`); status(error.message); }
        }));
        webview.html = content(webview, context.extensionUri, surface);
    }
    // The workspace page (start, plan, research, rules, activity, connections) is a side
    // bar view, so it never takes the editor area away from code.
    const revealHome = async (preserveFocus = false) => {
        if (homeView) homeView.show(preserveFocus);
        else await vscode.commands.executeCommand('aiGui.workspace.focus');
        if (preserveFocus) await vscode.commands.executeCommand('aiGui.conversation.focus');
    };
    async function showHome(page) {
        await revealHome();
        if (page) for (const [webview, view] of views) if (view.surface === 'home') void webview.postMessage({ type: 'page', page });
        broadcast();
    }
    async function showHistory() {
        await vscode.commands.executeCommand('aiGui.conversation.focus');
        for (const [webview, view] of views) if (view.surface === 'conversation') void webview.postMessage({ type: 'showHistory' });
    }
    context.subscriptions.push(vscode.window.registerWebviewViewProvider('aiGui.workspace', {
        resolveWebviewView(view) {
            homeView = view;
            const disposables = [];
            attach(view.webview, 'home', disposables);
            view.onDidDispose(() => { for (const disposable of disposables) disposable.dispose(); if (homeView === view) homeView = undefined; });
        }
    }, { webviewOptions: { retainContextWhenHidden: true } }));
    context.subscriptions.push(vscode.window.registerWebviewViewProvider('aiGui.conversation', {
        resolveWebviewView(view) {
            const disposables = [];
            attach(view.webview, 'conversation', disposables);
            view.onDidDispose(() => { for (const disposable of disposables) disposable.dispose(); });
        }
    }, { webviewOptions: { retainContextWhenHidden: true } }));
    async function showTour() { updateTour({ dismissed: false }); await showHome('start'); }
    // Whole-window zoom: the workbench has no general UI font size setting.
    async function textSize(action) {
        const config = vscode.workspace.getConfiguration('window'), current = Number(config.get('zoomLevel')) || 0;
        const next = action === 'textReset' ? 1 : Math.min(4, Math.max(-2, current + (action === 'textLarger' ? 0.5 : -0.5)));
        await config.update('zoomLevel', next, vscode.ConfigurationTarget.Global);
        status(`Text size ${Math.round(Math.pow(1.2, next) * 100)}%.`);
    }
    async function showConnections() {
        await showHome('connections');
        if (!conversation.connecting) { conversation.connections = await provider.status(); broadcast(); }
    }
    // Facts for a bug report. No conversation text, account names, keys or file contents.
    async function copyDiagnostics() {
        const chat = conversation.snapshot(), home = os.homedir(), product = JSON.parse(await fs.readFile(path.join(context.extensionPath, 'package.json'), 'utf8'));
        const redact = value => String(value).split(home).join('~').replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>');
        const usage = chat.usage;
        const lines = [
            `AI GUI ${product.version} · Code OSS ${vscode.version} · Electron ${process.versions.electron} · Node ${process.versions.node}`,
            `OS: ${os.type()} ${os.release()} ${os.arch()} · session ${process.env.XDG_SESSION_TYPE || 'unknown'} · zoom ${vscode.workspace.getConfiguration('window').get('zoomLevel')}`,
            `Project: ${root() ? `open, ${vscode.workspace.isTrusted ? 'trusted' : 'restricted'}` : 'none'} · permissions ${permission()} · sandbox ${sandbox.path ? 'available' : 'unavailable'} · mode ${session.state.mode}`,
            `Model: ${chat.model || 'none'} · context ${usage ? `~${usage.used} of ${usage.window} tokens, ${usage.condensed} summaries` : 'n/a'}`,
            `Connections: ${(chat.connections.connections || []).map(item => `${item.provider}=${item.connected ? 'connected' : 'not connected'}${item.error ? ` (${redact(item.error).slice(0, 160)})` : ''}`).join('; ') || 'not discovered'}`,
            `Conversation: ${chat.messages.length} messages · busy ${chat.busy} · queued ${chat.queue.length} · background processes ${chat.processes.filter(item => item.status === 'running').length} · rules ${chat.rules.length}`,
            `Last error: ${redact(chat.error || lastStatus || 'none').slice(0, 300)}`,
            '', 'Recent log:', ...recent.slice(-80).map(redact),
        ];
        await vscode.env.clipboard.writeText(lines.join('\n'));
        status('Diagnostics copied to the clipboard. They contain no conversation text, keys or account names; check before sharing.');
    }
    context.subscriptions.push(vscode.commands.registerCommand('aiGui.home', () => showHome()));
    context.subscriptions.push(vscode.commands.registerCommand('aiGui.tour', () => showTour().catch(error => status(error.message))));
    context.subscriptions.push(vscode.commands.registerCommand('aiGui.connections', () => showConnections().catch(error => status(error.message))));
    const command = (name, action) => context.subscriptions.push(vscode.commands.registerCommand(name, async (...args) => {
        try { return await action(...args); } catch (error) { log('error', `${name}: ${error.message}`); status(error.message); throw error; }
    }));
    // Keyboard shortcuts (package.json keybindings) and command palette entries.
    command('aiGui.focusConversation', () => vscode.commands.executeCommand('aiGui.conversation.focus'));
    command('aiGui.newChat', async () => { await conversation.switch(); save(); await vscode.commands.executeCommand('aiGui.conversation.focus'); });
    command('aiGui.history', () => showHistory());
    command('aiGui.nextMode', () => { const next = modes[(modes.indexOf(session.state.mode) + 1) % modes.length]; setMode(next); status(`${next} mode.`); });
    command('aiGui.stop', () => conversation.stop());
    command('aiGui.approve', () => { const id = conversation.approvals.keys().next().value; if (id) conversation.decide(id, 'approve'); });
    command('aiGui.deny', () => { const id = conversation.approvals.keys().next().value; if (id) conversation.decide(id, 'deny'); });
    command('aiGui.compact', () => handlers.compact());
    command('aiGui.copyDiagnostics', () => copyDiagnostics());
    command('aiGui.showLog', () => output.show(true));
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
    context.subscriptions.push(vscode.commands.registerCommand('aiGui.openResearch', async () => { setMode('Research'); await showHome('research'); }));
    context.subscriptions.push({ dispose: () => { clearTimeout(flushTimer); } });
    if (vscode.workspace.getConfiguration('aiGui').get('openOnStartup')) {
        // First run without a project: show the getting-started page (it opens one). With a
        // project the side bar keeps Explorer (or whatever the user opens), and the empty chat
        // links to the tour; afterwards keep the layout the user left.
        if (!tour.dismissed && !vscode.workspace.workspaceFolders?.length) void revealHome(true);
        else void vscode.commands.executeCommand('aiGui.conversation.focus');
    }
    log('info', `Activated (Code OSS ${vscode.version}).`);
    return { session, reviews, research, conversation, documents, showHome, status, connectionsReady, scm, terminals, save: async () => { await saveQueue; await conversation.save(); } };
};
