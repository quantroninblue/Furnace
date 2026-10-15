const vscode = require('vscode');
const fs = require('node:fs/promises');
const { content } = require('./interface.cjs');
const { AssistantClient } = require('./assistant-client.cjs');
const { Conversation } = require('../../shared/assistant/conversation.cjs');
const { AgentWorkspace, AgentFileReviews, IdeToolHost } = require('./agent-workspace.cjs');
const { execFile } = require('node:child_process');
const { buildFromPlanPrompt } = require('../../shared/assistant/main/plan-link.ts');
const path = require('node:path');
const { ResearchController } = require('./research-controller.cjs');
const { gitChanges, problemsText, selectionText, searchPaths } = require('./ide-context.cjs');
const { CommandTerminals } = require('./terminals.cjs');
const { AgentChanges } = require('./agent-scm.cjs');
const { createSupport } = require('./support.cjs');
const { createWindowOpacity } = require('./window-opacity.cjs');
const { createDiffViews } = require('./diff-views.cjs');
const { createBackground } = require('./background-tasks.cjs');
const { createInlineEdits } = require('./inline-edit.cjs');
const { createHistoryActions } = require('./history-actions.cjs');
const { createClaudeSignIn } = require('./claude-signin.cjs');
const { createTutorial } = require('./tutorial.cjs');
const { createThemes } = require('./theme-manager.cjs');
let activeResearch, activeConversation;
exports.deactivate = async () => { await activeConversation?.dispose(); await activeResearch?.dispose(); };
const { ProductSession, ProductReview, modes } = require('../../shared/product-core.cjs');
const { CodeOssDocuments } = require('./document-adapter.cjs');

exports.activate = async context => {
    await fs.mkdir(context.globalStorageUri.fsPath, { recursive: true });
    const session = new ProductSession(context.workspaceState.get('session'));
    // In-app log (Output → Furnace); the newest lines also go into "Copy Diagnostics".
    const output = vscode.window.createOutputChannel('Furnace', { log: true });
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
    let conversation, files, scm, background, inline, themes, agentFilesKey = '';
    // Status bar mirrors the original app's connection indicator; it opens Connections.
    const indicator = vscode.window.createStatusBarItem('aiGui.model', vscode.StatusBarAlignment.Left, 100);
    indicator.name = 'Furnace Model'; indicator.command = 'aiGui.connections'; indicator.show();
    context.subscriptions.push(indicator);
    const showIndicator = chat => {
        const model = chat?.connections.models?.find(item => item.id === chat.model);
        indicator.text = model ? `$(circle-filled) ${model.name}` : chat?.connections.models?.length ? '$(circle-outline) Choose a model' : '$(plug) Connect a model';
        indicator.tooltip = model ? `Active model: ${model.name}. Click to manage connections.` : 'Open Furnace connections';
    };
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
        setKey('aiGui.busy', !!chat?.busy); setKey('aiGui.approvalPending', !!conversation?.approvals.size);
        scm?.update();
        const { messages = [], ...meta } = chat || {};
        // Agent glow (Themes → Agent Glow): working, waiting for an approval, or an error.
        const glow = !themes?.glow() ? 'off' : conversation?.approvals.size ? 'waiting' : chat?.busy ? 'working' : chat?.error ? 'error' : 'idle';
        const base = { type: 'state', state: session.snapshot(), scope: scope(), review: reviews.state(), research: research.snapshot(), chat: chat ? meta : null, status: lastStatus, modeModels, background: background?.list() || [], glow };
        // Files the agent changed get Keep / Revert lenses in their editors.
        const filesKey = conversation ? `${conversation.data.id}:${conversation.agentFiles().map(file => `${file.path}@${file.messageId}`).join('|')}` : '';
        if (filesKey !== agentFilesKey) { agentFilesKey = filesKey; void inline?.refreshAgentFiles(); }
        const serialized = new Map();
        const json = message => { if (!serialized.has(message.id)) serialized.set(message.id, JSON.stringify(message)); return serialized.get(message.id); };
        for (const [webview, view] of views) {
            if (view.surface === 'help' || view.surface === 'themes') continue;
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
    // Agent permissions (Codex-style) and the optional command sandbox
    // (Landlock on Linux, Seatbelt on macOS; see product/sandbox).
    const permission = () => { const value = vscode.workspace.getConfiguration('aiGui.agent').get('permissions'); return ['ask', 'auto', 'full'].includes(value) ? value : 'auto'; };
    const sandbox = { path: null };
    const helper = path.join(context.extensionPath, 'sandbox/ai-gui-sandbox');
    execFile(helper, ['--probe'], { timeout: 5000 }, (error, stdout) => { if (!error && stdout.startsWith('ok')) { sandbox.path = helper; broadcast(); } });
    context.subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(() => broadcast()));
    // VS Code's own trust dialog (proposed workspaceTrust API), with the trust editor as fallback.
    async function requestTrust() {
        if (vscode.workspace.isTrusted) return true;
        if (typeof vscode.workspace.requestWorkspaceTrust === 'function') {
            try { await vscode.workspace.requestWorkspaceTrust({ message: `Trust ${path.basename(root() || 'this folder')} so the Furnace agent can read, edit and create files and run commands in it (within your permission mode).` }); }
            catch { await vscode.commands.executeCommand('workbench.trust.manage'); }
        } else await vscode.commands.executeCommand('workbench.trust.manage');
        broadcast(); return vscode.workspace.isTrusted;
    }
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('aiGui')) broadcast(); }));
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
            // Cost: price overrides ($ per million tokens), monthly budget and the second-model review.
            pricing: () => vscode.workspace.getConfiguration('aiGui').get('pricing') || {},
            budget: () => Number(vscode.workspace.getConfiguration('aiGui.budget').get('monthlyUsd')) || 0,
            reviewSettings: () => { const config = vscode.workspace.getConfiguration('aiGui.review'); return { automatic: config.get('automatic', false), model: config.get('model', '') }; },
            clear: () => files.clear() }, changed: broadcast });
    activeConversation = conversation;
    const save = () => { void conversation.save(); persist(); };
    const text = (value, limit) => { if (typeof value !== 'string' || value.length > limit) throw new Error('Invalid message.'); return value; };
    createWindowOpacity(context);
    const support = createSupport({ context, conversation, session, root, permission, sandbox, recent, lastStatus: () => lastStatus, status });
    const diffViews = createDiffViews({ context, conversation, status, text });
    const preview = diffViews.preview;
    background = createBackground({ context, provider, conversation, sandbox, root, status, broadcast, showEntries: diffViews.showEntries, text });
    inline = createInlineEdits({ context, provider, conversation, documents, status, preview, setKey });
    // Agent changes in the built-in Source Control view, with diffs, revert and Git staging.
    scm = new AgentChanges(context, conversation, { root, preview, status, confirmConflicts: (run, action) => confirmConflicts(run, action), restored: (result, verb) => restored(result, verb) });
    // Connections are discovered on startup and after a folder change, not only on Refresh.
    const discoverConnections = () => conversation.connecting ? Promise.resolve()
        : conversation.connect({ action: 'discover' }).catch(error => status(`${error.message} Refresh connections when ready.`));
    // Desktop tests start without this machine's real connections unless they opt in.
    const connectionsReady = process.env.AI_GUI_TEST_NO_DISCOVERY ? Promise.resolve() : discoverConnections();
    context.subscriptions.push({ dispose: () => { void conversation.dispose(); } });
    const claudeSignIn = createClaudeSignIn({ context, conversation, status });
    const { confirmConflicts, restored, handlers: historyHandlers } = createHistoryActions({ conversation, status, save, text });
    const selectModeModel = mode => {
        const preferred = modeModels[mode];
        if (preferred && preferred !== conversation.data.model && !conversation.turn && conversation.connections.models.some(model => model.id === preferred)) conversation.selectModel(preferred);
    };
    const setMode = mode => { session.update('mode', mode); selectModeModel(mode); save(); broadcast(); };
    // The interactive tutorial (Furnace → Begin Tutorial, /tour, the welcome card on startup).
    const tutorial = createTutorial({ vscode, context, views, getMode: () => session.state.mode, setMode, showHome, log });
    context.subscriptions.push({ dispose: () => tutorial.stop() });
    // Themes (the Themes menu, patches/themes-menu.patch): this window's look and Furnace's panels.
    themes = createThemes({ context, views, root, status, log, attach: (...args) => attach(...args) });
    const startTurn = async (send) => {
        if (['Build', 'Plan'].includes(session.state.mode) && root() && !vscode.workspace.isTrusted) await requestTrust();
        await send();
    };
    // Every webview message is validated here; webview/protocol.ts lists them.
    const handlers = {
        ready: async (_message, view) => {
            view.ready = true;
            themes.sendTo(view.webview);
            if (view.surface === 'themes') return themes.handlers.themeReady();
            if (view.surface === 'help') { void view.webview.postMessage({ type: 'help', docs: await helpDocs(), section: view.section }); return; }
            view.reset = true; broadcast();
        },
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
            conversation[message.field] = message.enabled; broadcast(); conversation.measureSoon();
            if (message.field === 'shareDiff' && message.enabled) void gather('diff').catch(() => {});
        },
        mentionSearch: async (message, view) => { void view.webview.postMessage({ type: 'mentions', query: message.value, items: await searchPaths(root(), text(message.value, 300)) }); },
        pasteImage: message => conversation.addImage({ name: text(message.name, 200), mime: text(message.mime, 40), data: text(message.data, 7000000) }),
        removeImage: message => conversation.removeImage(text(message.id, 100)),
        connections: () => showConnections(),
        connection: async message => { await conversation.connect(message.value); status('Connection details updated.'); },
        newChat: async () => { await conversation.switch(); save(); },
        resumeChat: () => showHistory(),
        buildPlan: async () => {
            if (!session.state.brief.trim()) throw new Error('Write a brief with a checklist (- [ ] step) on the Plan page first.');
            setMode('Build'); conversation.sharePlan = true;
            await startTurn(() => conversation.send(buildFromPlanPrompt(session.state.brief), { fromDraft: false }));
        },
        approveProposal: message => conversation.approve(message.id),
        approval: message => conversation.decide(message.id, message.decision),
        autocompute: message => { if (typeof message.enabled !== 'boolean') throw new Error('Invalid Autocompute setting.'); return conversation.setAutocompute(message.enabled); },
        autocomputeReset: async () => { await conversation.resetAutocompute(); status('Local model records cleared: each model can take every kind of task again until it earns a new record.'); },
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
        keys: () => vscode.commands.executeCommand('workbench.action.openGlobalKeybindings', 'Furnace'),
        diagnostics: () => support.copyDiagnostics(),
        feedback: () => support.sendFeedback(),
        checkUpdates: () => support.checkForUpdates(true),
        // Plan checks (Q7), second-model review (Q8), timeline (Q9) and spend (Q5).
        checkStep: async message => { const passed = await conversation.checkStep(text(message.key, 500)); status(passed ? 'Check passed; the step is ticked.' : 'Check failed; see the output on the Plan page.'); },
        confirmStep: message => { if (typeof message.passed !== 'boolean') throw new Error('Invalid check result.'); conversation.confirmStep(text(message.key, 500), message.passed); },
        reviewChanges: async message => { await conversation.reviewChanges(text(message.messageId, 100)); status(conversation.data.messages.find(item => item.id === message.messageId)?.review?.state === 'complete' ? 'Second-model review finished; notes are under the changed files.' : 'The review did not finish.'); },
        addressReview: message => startTurn(() => conversation.addressReview(text(message.messageId, 100))),
        timeline: async (_message, view) => { void view.webview.postMessage({ type: 'timeline', timeline: await conversation.timeline() }); },
        spendRefresh: async (_message, view) => { void view.webview.postMessage({ type: 'spend', spend: await provider.spend() }); },
        inlineEdit: () => inline.start(),
        trustFolder: () => requestTrust(),
        tutorial: () => { void tutorial.begin().catch(error => status(error.message)); },
        tutorialAction: message => tutorial.action(message),
        help: () => showHelp(),
        openLink: message => {
            const url = vscode.Uri.parse(text(message.url, 2000));
            if (!['https', 'http'].includes(url.scheme)) throw new Error('Only web links open from Help.');
            return vscode.env.openExternal(url);
        },
        focusConversation: () => vscode.commands.executeCommand('aiGui.conversation.focus'),
        textSmaller: () => textSize('textSmaller'), textLarger: () => textSize('textLarger'), textReset: () => textSize('textReset'),
        ...historyHandlers,
        ...themes.handlers,
        ...diffViews.handlers,
        ...background.handlers,
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
    function attach(webview, surface, disposables, roots = []) {
        webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media'), ...roots] };
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
    // Furnace Help: the user guide and data usage page that ship with the app, in the editor area.
    let helpPanel;
    async function helpDocs() {
        const read = name => fs.readFile(vscode.Uri.joinPath(context.extensionUri, 'help', name).fsPath, 'utf8').catch(() => '');
        return [{ id: 'guide', title: 'User Guide', markdown: await read('guide.md') }, { id: 'data', title: 'Data and Privacy', markdown: await read('data.md') }];
    }
    async function showHelp() {
        if (helpPanel) { helpPanel.reveal(); return; }
        helpPanel = vscode.window.createWebviewPanel('aiGui.help', 'Furnace Help', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
        helpPanel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'workspace.svg');
        const disposables = [];
        attach(helpPanel.webview, 'help', disposables);
        helpPanel.onDidDispose(() => { for (const disposable of disposables) disposable.dispose(); helpPanel = undefined; });
    }
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
    context.subscriptions.push(vscode.commands.registerCommand('aiGui.home', () => showHome()));
    context.subscriptions.push(vscode.commands.registerCommand('aiGui.tour', () => tutorial.begin().catch(error => status(error.message))));
    context.subscriptions.push(vscode.commands.registerCommand('aiGui.help', () => showHelp().catch(error => status(error.message))));
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
    command('aiGui.copyDiagnostics', () => support.copyDiagnostics());
    command('aiGui.sendFeedback', () => support.sendFeedback());
    command('aiGui.checkForUpdates', () => support.checkForUpdates(true));
    command('aiGui.inlineEdit', () => inline.start());
    command('aiGui.inlineEdit.accept', uri => inline.finish(true, uri));
    command('aiGui.inlineEdit.reject', uri => inline.finish(false, uri));
    command('aiGui.inlineEdit.cancel', () => inline.cancel());
    command('aiGui.inlineEdit.diff', uri => inline.showDiff(uri || vscode.window.activeTextEditor?.document.uri.toString()));
    command('aiGui.agentHunk.keep', (uri, hunk) => inline.keepHunk(uri, hunk));
    command('aiGui.agentHunk.revert', (uri, hunk) => inline.revertHunk(uri, hunk));
    command('aiGui.background.start', async () => {
        const prompt = await vscode.window.showInputBox({ title: 'Start Background Task', prompt: 'The agent works on this in a separate Git worktree while you keep editing. Review and apply the result when it finishes.', placeHolder: 'For example: add tests for the parser', ignoreFocusOut: true });
        if (prompt?.trim()) await background.start(prompt.trim());
    });
    command('aiGui.timeline', async () => { await vscode.commands.executeCommand('aiGui.conversation.focus'); for (const [webview, view] of views) if (view.surface === 'conversation') void webview.postMessage({ type: 'showTimeline' }); });
    command('aiGui.reviewLastChanges', () => {
        const reply = conversation.data.messages.findLast(message => message.role === 'assistant' && message.changes?.files.some(file => !file.reverted));
        if (!reply) throw new Error('No agent reply with changes to review.');
        return handlers.reviewChanges({ messageId: reply.id });
    });
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
        // First run without a project: show the Start page (it opens one). With a project the
        // side bar keeps Explorer (or whatever the user opens); afterwards keep the layout the user left.
        if (!context.globalState.get('tutorial') && !vscode.workspace.workspaceFolders?.length) void revealHome(true);
        else void vscode.commands.executeCommand('aiGui.conversation.focus');
    }
    // Offer the tutorial once the window has settled (desktop tests opt in with { welcome: true }).
    if (!process.env.AI_GUI_TEST_NO_WELCOME) {
        const timer = setTimeout(() => { void tutorial.welcome().catch(error => log('warn', `Tutorial: ${error.message}`)); }, 1500);
        context.subscriptions.push({ dispose: () => clearTimeout(timer) });
    }
    // Daily update check, only when this build names a feed (package.json "updates.feed").
    if (!process.env.AI_GUI_TEST_NO_DISCOVERY) { const timer = setTimeout(() => { void support.checkForUpdates(false).catch(() => {}); }, 30000); context.subscriptions.push({ dispose: () => clearTimeout(timer) }); }
    void themes.start().catch(error => log('warn', `Themes: ${error.message}`));
    log('info', `Activated (Code OSS ${vscode.version}).`);
    return { session, reviews, research, conversation, documents, showHome, status, connectionsReady, scm, terminals, background: background.tasks, inline, support, themes, save: async () => { await saveQueue; await conversation.save(); } };
};
