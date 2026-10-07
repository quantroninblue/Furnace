'use strict';
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { Sessions } = require('./main/sessions.ts');
const { TurnChanges, recordingHost, Checkpoints, mergeCheckpoints, restoreChanges, summarize } = require('./main/checkpoints.ts');
const { createAgentTools, definitionsSize, protectedPath } = require('./main/agent-tools.ts');
const { runCommand } = require('./main/commands.ts');
const { agentInstructions, historyText, validImages } = require('./main/agent-context.ts');
const { estimateTokens, contextWindow, replyReserve, CONDENSE_AT, KEEP_RECENT, summaryInstruction } = require('./main/context-window.ts');
const { PermissionRules } = require('./main/permissions.ts');
const { AuditLog } = require('./main/audit.ts');
const { BackgroundProcesses } = require('./main/processes.ts');
const { tickBrief } = require('./main/plan-link.ts');
// Session/tool lifecycle is independent of the IDE. The adapter supplies current
// unsaved documents, file-review authority and scoped project access.
class Conversation {
    constructor({ directory, session, research, provider, adapter, changed = () => {}, contextWindow: windowFor = contextWindow }) {
        this.storage = new Sessions(directory, directory + '/previous-layout');
        this.session = session; this.research = research; this.provider = provider; this.adapter = adapter; this.changed = changed; this.windowFor = windowFor;
        this.data = this.storage.start(adapter.root()); this.epoch = 0; this.attachments = []; this.sharePlan = false; this.shareEditor = false;
        this.shareSelection = false; this.shareDiff = false; this.shareProblems = false;
        this.connections = { models: [], connections: [] }; this.proposals = new Map(); this.error = ''; this.saveQueue = Promise.resolve();
        this.approvals = new Map(); this.grants = new Set(); this.queued = []; this.queuePaused = false; this.images = [];
        this.checkpoints = new Checkpoints(path.join(directory, 'checkpoints'));
        this.rules = new PermissionRules(path.join(directory, 'settings', 'permissions.json')); void this.rules.load();
        this.audit = new AuditLog(path.join(directory, 'audit'));
        this.processes = new BackgroundProcesses(adapter.terminals || null, () => this.changed(), (info, event) => this.log({ event: 'process', tool: 'run_command', title: `${event === 'started' ? 'Started' : event === 'stopped' ? 'Stopped' : 'Exited'} background process: ${info.command}`, status: event, detail: info.exitCode === null ? info.cwd : `exit ${info.exitCode}` }));
    }
    busy() { return !!(this.turn || this.command || this.switching || this.connecting); }
    snapshot() {
        const first = this.data.messages.find(m => m.role === 'user' && !m.kind)?.content.slice(0, 90);
        return { id: this.data.id, title: this.data.customTitle || first || 'New conversation', messages: this.data.messages, model: this.data.model, busy: !!this.turn || !!this.command, switching: !!this.switching,
            compacting: !!this.turn?.compacting,
            attachments: this.attachments.map(({ text, ...item }) => ({ ...item, readable: typeof text === 'string' })), sharePlan: this.sharePlan, shareEditor: this.shareEditor,
            shareSelection: this.shareSelection, shareDiff: this.shareDiff, shareProblems: this.shareProblems, contextInfo: this.adapter.contextInfo?.() || null,
            connections: this.connections, connecting: !!this.connecting, error: this.persistenceError || this.error,
            permission: this.adapter.permission?.() || 'ask', agent: this.adapter.agentState?.() || null, grants: [...this.grants],
            usage: this.usage(), queue: this.queued.map(({ id, text }) => ({ id, text })), queuePaused: this.queuePaused,
            images: this.images.map(({ data, ...image }) => image), processes: this.processes.list(), rules: this.rules.list(this.adapter.root()) };
    }
    save() {
        this.data.plan = this.session.state.brief;
        this.data.sources = [...this.research.sources.sources.values()];
        this.data.attachments = this.attachments; this.data.draft = this.session.state.draft; this.data.mode = this.session.state.mode;
        const saved = structuredClone(this.data);
        if (!saved.messages.length && !saved.plan.trim() && !saved.sources.length && !saved.attachments.length && !saved.draft.trim()) return this.saveQueue;
        this.saveQueue = this.storage.write(saved, this.data.projectRoot).then(() => { this.persistenceError = ''; return true; }, () => { this.persistenceError = 'Could not save conversation. Check available disk space and permissions.'; this.changed(); return false; });
        return this.saveQueue;
    }
    async list(query = '') { await this.save(); return query ? this.storage.search(this.adapter.root(), query) : this.storage.list(this.adapter.root()); }
    async switch(id) {
        if (this.switching) throw new Error('Conversation is changing.');
        this.switching = true; this.changed();
        try {
            await this.stop(); if (await this.save() === false) throw new Error(this.persistenceError);
            this.reset();
            await this.research.resetScope();
            this.data = id ? await this.storage.resume(id, this.adapter.root()) : this.storage.start(this.adapter.root());
            // Restored model suggestions are text records, never restored approvals.
            for (const message of this.data.messages) {
                if (['streaming', 'running'].includes(message.state)) { message.state = 'interrupted'; message.error = 'Interrupted before completion. Send again to continue.'; }
                for (const proposal of message.proposals || []) if (['pending', 'running'].includes(proposal.status)) proposal.status = 'expired';
                for (const step of message.steps || []) if (['running', 'waiting'].includes(step.status)) { step.status = 'failed'; step.detail = 'Interrupted before completion.'; }
            }
            this.session.update('brief', this.data.plan || ''); this.session.update('draft', this.data.draft || '');
            if (this.data.mode) this.session.update('mode', this.data.mode);
            this.attachments = (this.data.attachments || []).slice(0, 20).map(item => ({ ...item, shared: false }));
            this.research.restore(this.data.sources || []); this.error = '';
        } finally { this.switching = false; this.changed(); }
    }
    // What a new conversation starts without: approvals, grants, queued messages and sharing.
    reset() {
        this.epoch++; this.adapter.clear(); this.proposals.clear(); this.grants.clear(); this.queued = []; this.queuePaused = false; this.images = [];
        this.sharePlan = false; this.shareEditor = false; this.shareSelection = false; this.shareDiff = false; this.shareProblems = false;
    }
    async connect(value) {
        if (this.turn || this.command || this.switching || (this.connecting && value.action !== 'cancel')) throw new Error('Stop the current task before changing connections.');
        if (value.action === 'cancel') { await this.provider.connection(value); return; }
        this.connecting = true; this.changed();
        try { this.connections = await this.provider.connection(value); this.error = ''; }
        finally { this.connecting = false; this.changed(); }
    }
    selectModel(value) {
        if (this.turn) throw new Error('Stop the reply before changing model.');
        if (!this.connections.models.some(model => model.id === value)) throw new Error('Refresh connections and choose an available model.');
        this.data.model = value; this.changed(); void this.save();
    }
    // ---- Context: what the next request contains and how full the model's window is ----
    mode() { return this.session.state.mode.toLowerCase(); }
    systemTokens(mode = this.mode()) {
        this.definitionSizes ??= new Map();
        if (!this.definitionSizes.has(mode)) this.definitionSizes.set(mode, definitionsSize(mode));
        return estimateTokens(agentInstructions(mode, this.adapter.permission?.() || 'ask', (this.adapter.environment?.() || '').slice(0, 1000))) + Math.ceil(this.definitionSizes.get(mode) / 4);
    }
    /** Estimated tokens for the next request: instructions and tools, conversation since the last summary, shared context. */
    usage() {
        if (!this.data.model) return null;
        const window = this.windowFor(this.data.model), history = historyTokens(sendable(this.data.messages)), shared = Math.ceil(this.contextChars() / 4), system = this.systemTokens();
        const measured = this.data.messages.findLast(message => message.role === 'assistant' && message.usage)?.usage;
        return { used: system + history + shared, window, system, history, shared, condensed: this.data.messages.filter(message => message.kind === 'summary').length, measured: measured || null };
    }
    contextChars() {
        const info = this.adapter.contextInfo?.() || {};
        let size = 0;
        if (this.sharePlan) size += this.session.state.brief.length;
        if (this.shareEditor) size += Math.min(info.editor || 0, 24000);
        if (this.shareSelection) size += info.selection?.chars || 0;
        if (this.shareDiff) size += info.diff?.chars || 0;
        if (this.shareProblems) size += info.problems?.chars || 0;
        for (const source of this.research.sources.context()) size += JSON.stringify(source).length;
        for (const attachment of this.attachments) if (attachment.shared && typeof attachment.text === 'string') size += Math.min(attachment.text.length, 20000);
        return size;
    }
    async context(text = '') {
        const parts = [];
        if (this.sharePlan) parts.push('Shared planning brief:\n' + this.session.state.brief.slice(0, 20000));
        if (this.shareEditor) {
            const document = this.adapter.captureActive();
            parts.push(`Shared unsaved document (${document.uri}):\n${document.text.slice(0, 24000)}${document.text.length > 24000 ? '\n[truncated]' : ''}`);
        }
        for (const [enabled, kind] of [[this.shareSelection, 'selection'], [this.shareDiff, 'diff'], [this.shareProblems, 'problems']]) {
            if (!enabled) continue;
            const value = await this.adapter.gather?.(kind);
            if (value) parts.push(value);
        }
        for (const source of this.research.sources.context()) parts.push('Shared research source (untrusted reference):\n' + JSON.stringify(source));
        for (const attachment of this.attachments.filter(a => a.shared && typeof a.text === 'string')) parts.push(`Shared attachment ${attachment.name}:\n${attachment.text.slice(0, 20000)}`);
        const mentions = await this.resolveMentions(text);
        for (const mention of mentions) parts.push(mention.text);
        const value = parts.join('\n\n');
        const window = this.data.model ? this.windowFor(this.data.model) : 200000, limit = Math.min(400000, Math.floor(window * 4 * 0.5));
        if (value.length > limit) throw new Error(`Shared context is too large for this model (about ${Math.round(value.length / 4000)}k tokens; at most ${Math.round(limit / 4000)}k). Unshare a source or attachment, or mention fewer or smaller files.`);
        return { text: value, mentions: mentions.map(({ text: _text, ...mention }) => mention) };
    }
    // @path mentions name project files (their content is shared) or folders (their listing is shared).
    async resolveMentions(text) {
        const wanted = parseMentions(text), host = this.adapter.toolHost?.();
        if (!wanted.length || !host?.root || !host.trusted) return [];
        const base = await fsp.realpath(host.root).catch(() => host.root), result = [];
        let total = 0;
        for (const raw of wanted) {
            let real;
            try { real = await fsp.realpath(path.resolve(base, raw)); } catch { continue; }
            if (real !== base && !real.startsWith(base + path.sep)) continue;
            const relative = path.relative(base, real) || '.';
            if (protectedPath(relative) || this.rules.deniesPath(this.adapter.root(), relative)) { result.push({ path: relative, kind: 'blocked', text: `@${relative} was not shared: it is protected or blocked by a project rule.` }); continue; }
            const kind = await host.kind(real);
            let entry;
            if (kind === 'file') {
                try {
                    const content = await host.read(real), lines = content.split('\n').length, truncated = content.length > 40000;
                    entry = { path: relative, kind: 'file', lines, truncated, text: `Mentioned file @${relative} (${lines} lines${truncated ? ', first 40,000 characters' : ''}):\n${content.slice(0, 40000)}` };
                } catch (error) { entry = { path: relative, kind: 'file', error: error.message, text: `@${relative} could not be read: ${error.message}` }; }
            } else if (kind === 'directory') {
                const listing = await listFolder(host, real, base);
                entry = { path: relative, kind: 'folder', entries: listing.length, text: `Mentioned folder @${relative} (${listing.length >= 300 ? 'first 300 entries' : `${listing.length} entries`}; read files with tools or mention them):\n${listing.join('\n')}` };
            } else continue;
            total += entry.text.length;
            if (total > 200000) { result.push({ path: relative, kind: 'skipped', text: `@${relative} was not shared: mentioned files exceed 200,000 characters.` }); break; }
            result.push(entry);
        }
        return result;
    }
    // Picks what fits in the model's window. When the conversation since the last summary
    // passes CONDENSE_AT of the window, older messages are summarised first.
    async prepareHistory(reply, contextText, signal, epoch) {
        const window = this.windowFor(this.data.model);
        const limit = window - replyReserve(window) - this.systemTokens() - estimateTokens(contextText);
        if (limit < 1000) throw new Error('This model\'s context is too small for the shared context and instructions. Unshare context, or choose a model with a larger context window.');
        let pending = this.data.messages.slice(0, this.data.messages.indexOf(reply));
        if (historyTokens(sendable(pending)) > Math.min(limit, CONDENSE_AT * window)) {
            reply.phase = 'condensing'; this.changed();
            await this.condense(pending, Math.min(Math.floor(KEEP_RECENT * window), Math.floor(limit / 2)), true, signal, epoch, reply.id);
            reply.phase = undefined; this.changed();
            pending = this.data.messages.slice(0, this.data.messages.indexOf(reply));
        }
        const perMessage = Math.max(8000, limit * 2);
        const copy = sendable(pending).filter(message => message.content.trim()).map(({ id, role, content, kind }) => ({ id, role, kind, content: content.length > perMessage ? middle(content, perMessage) : content }));
        let dropped = 0;
        while (copy.length > 1 && historyTokens(copy) > limit) {
            const at = copy[0].kind === 'summary' && copy.length > 2 ? 1 : 0;
            if (at >= copy.length - 1) break;
            copy.splice(at, 1); dropped++;
        }
        if (dropped) reply.contextNote = `${dropped} older message${dropped === 1 ? '' : 's'} did not fit in the model's context and ${dropped === 1 ? 'was' : 'were'} left out of this request.`;
        return copy;
    }
    /**
     * Summarises the conversation before a cut point into a "summary" message inserted there.
     * Keeps the newest messages worth `keep` tokens (and always the latest one when `keepLast`).
     * Returns false when there is nothing to condense. A failed summary leaves a visible note
     * and the older messages are simply no longer sent.
     */
    async condense(pending, keep, keepLast, signal, epoch, idBase) {
        const previousAt = pending.findLastIndex(message => message.kind === 'summary'), start = previousAt + 1;
        let cut = pending.length - (keepLast ? 1 : 0), size = 0;
        while (cut > start) { const next = size + messageTokens(pending[cut - 1]); if (next > keep) break; size = next; cut--; }
        // Start the kept part at one of the user's own messages.
        while (cut < pending.length && !(pending[cut].role === 'user' && !pending[cut].kind)) cut++;
        if (keepLast && cut > pending.length - 1) cut = pending.length - 1;
        const items = pending.slice(start, cut).filter(message => message.content.trim() && message.kind !== 'summary');
        if (!items.length) return false;
        const previous = previousAt >= 0 && !pending[previousAt].failed ? pending[previousAt].content : '';
        const anchor = pending[cut], insert = note => {
            const at = anchor ? this.data.messages.indexOf(anchor) : this.data.messages.length;
            this.data.messages.splice(at < 0 ? this.data.messages.length : at, 0, note); this.changed();
        };
        const base = { role: 'user', kind: 'summary', condensed: cut, createdAt: Date.now() };
        try {
            const window = this.windowFor(this.data.model), budget = Math.floor(window * 0.45);
            let summary = previous, index = 0, round = 0;
            while (index < items.length) {
                const chunk = []; let chunkSize = 0;
                while (index < items.length) {
                    const tokens = Math.min(messageTokens(items[index]), budget);
                    if (chunk.length && chunkSize + tokens > budget) break;
                    chunk.push(items[index]); chunkSize += tokens; index++;
                }
                summary = await this.summarize(summary, chunk, budget, signal, `${idBase}-summary-${round++}`);
                if (epoch !== this.epoch) throw new Error('Conversation changed.');
            }
            insert({ id: randomUUID(), ...base, content: summary.slice(0, 40000) });
            return true;
        } catch (error) {
            if (signal.aborted || epoch !== this.epoch) throw error;
            insert({ id: randomUUID(), ...base, content: '', failed: true, error: `Summarising failed: ${error.message}`.slice(0, 500) });
            return true;
        }
    }
    async summarize(previous, chunk, budget, signal, id) {
        const messages = [
            ...(previous ? [{ id: randomUUID(), role: 'user', kind: 'summary', content: previous }] : []),
            ...chunk.map(({ id: messageId, role, content, kind }) => ({ id: messageId, role, kind, content: content.length > budget * 4 ? middle(content, budget * 4) : content })),
            { id: randomUUID(), role: 'user', content: summaryInstruction },
        ];
        let text = '';
        await this.provider.run({ id, model: this.data.model, mode: 'discuss', permission: this.adapter.permission?.() || 'ask', environment: '', messages, context: '' },
            { definitions: [], execute: async () => { throw new Error('No tools while summarising.'); } }, signal, event => { if (event.delta) text += event.delta; });
        if (!text.trim()) throw new Error('the model returned an empty summary');
        return text.trim();
    }
    /** Summarises the whole conversation now (the /compact command). */
    async compact() {
        if (this.busy()) throw new Error('Finish or stop the current task first.');
        if (!this.connections.models.some(model => model.id === this.data.model)) throw new Error('Open Connections and select a model first.');
        const controller = new AbortController(), epoch = this.epoch, turn = this.turn = { controller, compacting: true };
        this.changed();
        turn.done = (async () => {
            try {
                if (!await this.condense(this.data.messages.slice(), 0, false, controller.signal, epoch, randomUUID())) this.error = 'Nothing to condense yet.';
                else this.error = '';
            } catch (error) { if (!controller.signal.aborted) this.error = error.message; }
            finally { if (this.turn === turn) this.turn = undefined; await this.save(); this.changed(); }
        })();
        return turn.done;
    }
    // ---- Turns ----
    async send(text, { fromDraft = true } = {}) {
        if (this.busy()) throw new Error('Finish or stop the current task first.');
        if (typeof text !== 'string' || !text.trim() || text.length > 20000) throw new Error('Enter a message up to 20,000 characters.');
        if (!this.connections.models.some(model => model.id === this.data.model)) throw new Error('Open Connections and select a model first.');
        const epoch = this.epoch, controller = new AbortController(), turn = this.turn = { controller };
        this.changed();
        let context;
        try { await this.rules.load(); context = await this.context(text); }
        catch (error) { if (this.turn === turn) this.turn = undefined; this.changed(); throw error; }
        if (epoch !== this.epoch || controller.signal.aborted) { if (this.turn === turn) this.turn = undefined; this.changed(); return; }
        const images = this.images.splice(0);
        const reply = { id: randomUUID(), role: 'assistant', content: '', model: this.data.model, proposals: [], activity: [], state: 'streaming', startedAt: Date.now() };
        this.data.messages.push({ id: randomUUID(), role: 'user', content: text.trim(), model: this.data.model,
            ...(context.mentions.length ? { mentions: context.mentions } : {}), ...(images.length ? { images: images.map(({ data, ...image }) => image) } : {}) }, reply);
        if (fromDraft) this.session.update('draft', '');
        this.error = '';
        const mode = this.mode();
        const permission = this.adapter.permission?.() || 'ask';
        // Every file the agent changes this turn is checkpointed for review and revert.
        const sessionId = this.data.id, host = this.adapter.toolHost?.() || null, root = this.adapter.root();
        let checkpointTimer, checkpointSave = Promise.resolve();
        const persistChanges = () => {
            clearTimeout(checkpointTimer); checkpointTimer = undefined;
            if (!changes.files.size) return checkpointSave;
            const snapshot = structuredClone(changes.checkpoint());
            checkpointSave = checkpointSave.then(() => this.checkpoints.save(sessionId, reply.id, snapshot)).then(() => { if (reply.changes) delete reply.changes.error; },
                () => { if (reply.changes) reply.changes.error = 'Could not save this checkpoint, so these changes cannot be reverted from here.'; });
            return checkpointSave;
        };
        const changes = new TurnChanges(displayPath(host?.root), () => {
            if (epoch !== this.epoch) return;
            const files = changes.summary();
            reply.changes = files.length ? { files } : undefined;
            checkpointTimer ??= setTimeout(persistChanges, 1000); this.changed();
        });
        const tools = createAgentTools(mode, host && recordingHost(host, changes), {
            permission, signal: controller.signal,
            report: step => this.reportStep(reply, step, epoch, permission),
            approve: (step, files) => this.requestApproval(step, files, epoch, controller.signal),
            policy: { deniedPath: relative => this.rules.deniesPath(root, relative)?.pattern ?? null, deniedCommand: command => this.rules.deniesCommand(root, command)?.pattern ?? null },
            terminals: this.adapter.terminals || null, processes: this.processes,
        }, {
            plan: this.sharePlan ? this.session.state.brief : '', sources: this.research.sources.context(),
            selection: this.research.sources.context().find(source => source.kind === 'selection') || null,
            propose: proposal => {
                controller.signal.throwIfAborted();
                if (epoch !== this.epoch) throw new Error('Conversation changed.');
                proposal.id ||= randomUUID(); proposal.status = 'pending';
                this.proposals.set(proposal.id, proposal); reply.proposals.push(proposal); this.changed();
            },
        });
        const guarded = { definitions: tools.definitions, execute: async (name, args) => {
            controller.signal.throwIfAborted(); if (epoch !== this.epoch) throw new Error('Conversation changed.');
            return tools.execute(name, args);
        } };
        this.changed();
        turn.done = (async () => {
            // Persist the user message and stream marker before starting a provider.
            const checkpoint = setInterval(() => { void this.save(); }, 2000); checkpoint.unref?.();
            try {
                if (await this.save() === false) throw new Error(this.persistenceError);
                controller.signal.throwIfAborted();
                const messages = await this.prepareHistory(reply, context.text, controller.signal, epoch);
                controller.signal.throwIfAborted();
                await this.provider.run({ id: reply.id, model: this.data.model, mode, permission, environment: (this.adapter.environment?.() || '').slice(0, 1000), messages, context: context.text,
                    ...(images.length ? { images: images.map(({ mime, data }) => ({ mime, data })) } : {}) }, guarded, controller.signal, event => {
                    if (epoch !== this.epoch || controller.signal.aborted) return;
                    if (event.delta) reply.content += event.delta;
                    if (event.activity && reply.activity.length < 16) reply.activity.push(event.activity);
                    if (event.usage) {
                        reply.usage ||= { input: 0, output: 0 };
                        if (event.usage.input) reply.usage.input = event.usage.input;
                        if (event.usage.output) reply.usage.output += event.usage.output;
                    }
                    this.changed();
                });
                reply.state = controller.signal.aborted ? 'stopped' : 'complete';
            } catch (error) { reply.state = controller.signal.aborted ? 'stopped' : 'failed'; reply.error = controller.signal.aborted ? 'Reply stopped.' : error.message; this.error = reply.error; if (/service disconnected|service timed out/.test(error.message)) this.connections = { models: [], connections: [], error: 'Assistant service stopped. Refresh Connections to reconnect.' }; }
            finally {
                clearInterval(checkpoint); reply.endedAt = Date.now(); reply.phase = undefined;
                await persistChanges();
                if (this.turn === turn) this.turn = undefined;
                await this.save(); this.changed();
                this.afterTurn(reply, epoch);
            }
        })();
        return turn.done;
    }
    async stop() { this.denyApprovals(); const turn = this.turn; turn?.controller.abort(); this.command?.stop(); await turn?.done; await this.command?.done; }
    // ---- Queued messages: sent one by one after each reply completes ----
    enqueue(text) {
        if (typeof text !== 'string' || !text.trim() || text.length > 20000) throw new Error('Enter a message up to 20,000 characters.');
        if (this.queued.length >= 10) throw new Error('At most 10 messages can wait in the queue.');
        this.queued.push({ id: randomUUID(), text: text.trim() }); this.session.update('draft', '');
        if (!this.busy()) this.queuePaused = false;
        this.changed();
        if (!this.busy() && !this.queuePaused) void this.sendQueued();
    }
    dequeue(id) { this.queued = this.queued.filter(item => item.id !== id); if (!this.queued.length) this.queuePaused = false; this.changed(); }
    afterTurn(reply, epoch) {
        if (epoch !== this.epoch || !this.queued.length) return;
        if (reply.state !== 'complete') { this.queuePaused = true; this.changed(); return; }
        setTimeout(() => { void this.sendQueued(); }, 0);
    }
    async sendQueued(id) {
        if (this.busy()) throw new Error('Finish or stop the current task first.');
        const item = id ? this.queued.find(entry => entry.id === id) : this.queued[0];
        if (!item) return;
        this.queued = this.queued.filter(entry => entry !== item); this.queuePaused = false;
        try { await this.send(item.text, { fromDraft: false }); }
        catch (error) { this.queued.unshift(item); this.queuePaused = true; this.error = error.message; this.changed(); }
    }
    // ---- Pasted images: attached to the next message only ----
    addImage({ name, mime, data }) {
        if (this.images.length >= 4) throw new Error('Attach at most 4 images to one message.');
        if (!validImages([{ mime, data }])) throw new Error('Paste a PNG, JPEG, GIF or WebP image up to 5 MB.');
        this.images.push({ id: randomUUID(), name: String(name || 'image').slice(0, 120), mime, size: Math.round(data.length * 3 / 4), data }); this.changed();
    }
    removeImage(id) { this.images = this.images.filter(image => image.id !== id); this.changed(); }
    async approve(id) {
        if (this.turn || this.command || this.switching || this.connecting) throw new Error('Finish or stop the current task first.');
        const proposal = this.proposals.get(id);
        if (!proposal || proposal.status !== 'pending') throw new Error('Proposal expired. Request a new one.');
        if (proposal.kind === 'file') { await this.adapter.files.open(id); return; }
        if (proposal.kind === 'plan') this.session.update('brief', proposal.text);
        else if (proposal.kind === 'browse') await this.research.open(proposal.text);
        else if (proposal.kind === 'command') { proposal.status = 'running'; this.changed(); await this.run(proposal.text); }
        proposal.status = 'applied'; this.record(`User approved ${proposal.kind}: ${proposal.kind === 'plan' ? 'planning brief updated' : proposal.text}`); this.proposals.delete(id); await this.save(); this.changed();
    }
    async discard(id) {
        const proposal = this.proposals.get(id);
        if (proposal) { proposal.status = 'discarded'; this.proposals.delete(id); this.adapter.files.pending.delete(id); }
        await this.save(); this.changed();
    }
    // Tool steps are shown live in the reply; output-only updates are throttled. Finished steps
    // go to the audit log, and a completed checklist ticks the matching brief items.
    reportStep(reply, step, epoch, permission) {
        if (epoch !== this.epoch) return;
        reply.steps ||= [];
        const index = reply.steps.findIndex(item => item.id === step.id);
        const copy = { ...step, todos: step.todos && [...step.todos], startedAt: reply.steps[index]?.startedAt ?? Date.now() };
        const finished = ['done', 'failed', 'denied'].includes(step.status);
        if (finished) copy.endedAt = reply.steps[index]?.endedAt ?? Date.now();
        if (finished && reply.steps[index]?.status !== step.status) {
            this.log({ event: 'tool', tool: step.tool, title: step.title, status: step.status, permission, decision: step.allowedBy || (step.status === 'denied' ? 'denied by you' : 'automatic'), detail: step.detail });
            if (step.tool === 'todo_write' && step.todos) {
                const brief = tickBrief(this.session.state.brief, step.todos);
                if (brief !== null) { this.session.update('brief', brief); this.adapter.persistSession?.(); }
            }
        }
        if (index < 0) reply.steps.push(copy); else reply.steps[index] = copy;
        if (step.status === 'running' && index >= 0) { this.stepTimer ??= setTimeout(() => { this.stepTimer = undefined; this.changed(); }, 150); return; }
        this.changed();
    }
    requestApproval(step, files, epoch, signal) {
        if (epoch !== this.epoch || signal.aborted) return Promise.resolve(false);
        if (this.grants.has(step.approval)) { step.allowedBy = 'allowed for this chat'; return Promise.resolve(true); }
        const rule = step.rule && step.approval !== 'outside' && this.rules.allows(this.adapter.root(), step.rule.kind === 'command' ? { kind: 'command', command: step.rule.subject } : step.rule.kind === 'network' ? { kind: 'network', host: step.rule.subject } : { kind: 'edit' });
        if (rule) { step.allowedBy = `project rule: ${rule.kind} ${rule.pattern}`; return Promise.resolve(true); }
        return new Promise(resolve => {
            const abort = () => this.decide(step.id, 'deny');
            signal.addEventListener('abort', abort, { once: true });
            this.approvals.set(step.id, { kind: step.approval, files, rule: step.rule, step, resolve: approved => { signal.removeEventListener('abort', abort); resolve(approved); } });
            this.changed();
        });
    }
    decide(id, decision) {
        const entry = this.approvals.get(id);
        if (!entry) throw new Error('This approval is no longer pending.');
        if (!['approve', 'always', 'project', 'deny'].includes(decision)) throw new Error('Unknown decision.');
        if (decision === 'project' && (!entry.rule || entry.kind === 'outside')) throw new Error('This action cannot be saved as a project rule.');
        this.approvals.delete(id);
        if (decision === 'always') this.grants.add(entry.kind);
        entry.step.allowedBy = { approve: 'approved by you', always: 'approved by you for this chat', project: `approved by you and saved as a project rule: ${entry.rule?.kind} ${entry.rule?.pattern}`, deny: undefined }[decision];
        if (decision === 'project') this.addRule({ effect: 'allow', kind: entry.rule.kind, pattern: entry.rule.pattern }).catch(error => { this.error = `Could not save the rule: ${error.message}`; this.changed(); });
        entry.resolve(decision !== 'deny'); this.changed();
    }
    approvalFiles(id) { return this.approvals.get(id)?.files; }
    denyApprovals() { for (const id of [...this.approvals.keys()]) this.decide(id, 'deny'); }
    // ---- Saved permission rules and the audit log ----
    async addRule(rule) {
        const saved = await this.rules.add(this.adapter.root(), rule);
        this.log({ event: 'rule', title: `Saved rule: ${saved.effect} ${saved.kind} ${saved.pattern}` }); this.changed();
        return saved;
    }
    async removeRule(id) {
        const rule = this.rules.list(this.adapter.root()).find(item => item.id === id);
        await this.rules.remove(this.adapter.root(), id);
        if (rule) this.log({ event: 'rule', title: `Removed rule: ${rule.effect} ${rule.kind} ${rule.pattern}` });
        this.changed();
    }
    log(entry) { void this.audit.append({ session: this.data.id, project: this.adapter.root(), ...entry }).catch(() => {}); }
    record(text) { this.data.messages.push({ id: randomUUID(), role: 'user', kind: 'workspace', content: text }); }
    async reviewResult(status) {
        const id = this.adapter.files.active, proposal = this.proposals.get(id);
        if (proposal) { this.record(`File review ${status}: ${proposal.path}. Applied changes go to the editor buffer; saving and Undo remain under user control.`); proposal.status = status; this.proposals.delete(id); this.adapter.files.pending.delete(id); }
        this.adapter.files.active = undefined; await this.save(); this.changed();
    }
    idle() { if (this.busy()) throw new Error('Finish or stop the current task first.'); }
    restoreHost() {
        const host = this.adapter.toolHost?.();
        if (!host?.root || !host.trusted) throw new Error('Open and trust this conversation\'s project to restore files.');
        return host;
    }
    // Reverts files one reply changed (all of them, or the listed paths). A conflict (the file
    // changed since) throws with `conflicts` unless forced, so the caller can ask the user.
    async revert(messageId, paths = null, force = false) {
        this.idle();
        const message = this.data.messages.find(item => item.id === messageId && item.role === 'assistant');
        if (!message?.changes) throw new Error('That reply has no file changes to revert.');
        const host = this.restoreHost(), checkpoint = await this.checkpoints.load(this.data.id, messageId);
        const selected = { files: checkpoint.files.filter(entry => !paths || paths.includes(entry.path)), directories: paths ? [] : checkpoint.directories };
        const result = await restoreChanges(host, selected, force);
        if (result.conflicts.length && !force) throw Object.assign(new Error(`${result.conflicts.join(', ')} changed after the agent edited ${result.conflicts.length === 1 ? 'it' : 'them'}.`), { conflicts: result.conflicts });
        await this.checkpoints.save(this.data.id, messageId, checkpoint);
        message.changes = { files: summarize(checkpoint.files) };
        if (result.restored.length) {
            this.record(`User reverted ${result.restored.length} file${result.restored.length === 1 ? '' : 's'} changed by an earlier reply (${result.restored.slice(0, 20).join(', ')}). They are back to their earlier content; read them again before editing.`);
            this.log({ event: 'revert', title: `Reverted ${result.restored.length} file${result.restored.length === 1 ? '' : 's'}`, detail: result.restored.slice(0, 20).join(', ') });
        }
        await this.save(); this.changed();
        return result;
    }
    // Rewinds the conversation to just before a user message: files changed by later replies
    // are restored, those messages are removed and the message text returns to the draft.
    async rewind(messageId, force = false) {
        this.idle();
        const index = this.data.messages.findIndex(item => item.id === messageId && item.role === 'user' && !item.kind);
        if (index < 0) throw new Error('Choose one of your messages to rewind to.');
        const later = this.data.messages.slice(index).filter(item => item.role === 'assistant' && item.changes?.files.some(file => !file.reverted));
        let result = { conflicts: [], restored: [], skipped: [] };
        if (later.length) {
            const host = this.restoreHost(), checkpoints = [];
            for (const item of later) checkpoints.push(await this.checkpoints.load(this.data.id, item.id));
            result = await restoreChanges(host, mergeCheckpoints(checkpoints), force);
            if (result.conflicts.length && !force) throw Object.assign(new Error(`${result.conflicts.join(', ')} changed after the agent edited ${result.conflicts.length === 1 ? 'it' : 'them'}.`), { conflicts: result.conflicts });
        }
        const removed = this.data.messages.splice(index);
        for (const item of removed) {
            for (const proposal of item.proposals || []) { this.proposals.delete(proposal.id); this.adapter.files?.pending?.delete(proposal.id); }
            if (item.role === 'assistant') await this.checkpoints.remove(this.data.id, item.id).catch(() => {});
        }
        this.session.update('draft', removed[0].content.slice(0, 20000));
        this.log({ event: 'rewind', title: `Rewound ${removed.length} message${removed.length === 1 ? '' : 's'}`, detail: result.restored.length ? `restored ${result.restored.slice(0, 20).join(', ')}` : undefined });
        await this.save(); this.changed();
        return result;
    }
    /** Rewinds to the user message before a reply and sends it again. `turn` settles when the new reply ends. */
    async regenerate(messageId, force = false) {
        this.idle();
        const index = this.data.messages.findIndex(item => item.id === messageId && item.role === 'assistant');
        const user = index < 0 ? null : this.data.messages.slice(0, index).findLast(item => item.role === 'user' && !item.kind);
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
        if (await this.save() === false) throw new Error(this.persistenceError);
        const source = this.data, messages = structuredClone(source.messages.slice(0, index + 1));
        for (const message of messages) for (const proposal of message.proposals || []) if (proposal.status === 'pending') proposal.status = 'expired';
        this.reset();
        this.data = this.storage.branch(source, messages, this.adapter.root());
        for (const message of messages) if (message.role === 'assistant' && message.changes) await this.checkpoints.copy(source.id, this.data.id, message.id).catch(() => {});
        await this.save(); this.changed();
    }
    async rename(id, title) {
        if (typeof title !== 'string' || !title.trim() || title.length > 200) throw new Error('Enter a name up to 200 characters.');
        if (id === this.data.id) { this.data.customTitle = title.trim().slice(0, 90); await this.save(); this.changed(); return; }
        await this.storage.rename(id, title.trim().slice(0, 90));
    }
    async remove(id) {
        if (id === this.data.id) await this.switch();
        await this.storage.remove(id);
        await this.checkpoints.removeSession(id).catch(() => {});
        this.changed();
    }
    // Recorded before/after content of a reply's changed files (still revertible ones).
    async changedFiles(messageId) {
        const { files } = await this.checkpoints.load(this.data.id, messageId);
        return files.filter(entry => entry.touched && entry.restorable && !entry.reverted && entry.before !== entry.after);
    }
    /** Every file the agent changed in this conversation and has not reverted, newest reply first. */
    agentFiles() {
        const files = new Map();
        for (const message of [...this.data.messages].reverse()) {
            if (message.role !== 'assistant' || !message.changes) continue;
            for (const file of message.changes.files) if (!file.reverted && !files.has(file.path)) files.set(file.path, { ...file, messageId: message.id });
        }
        return [...files.values()];
    }
    /** Content of a file before the agent first changed it in this conversation (null: the agent created it). */
    async agentFileOriginal(file) {
        for (const message of this.data.messages) {
            if (message.role !== 'assistant' || !message.changes?.files.some(item => item.path === file && !item.reverted)) continue;
            const entry = (await this.checkpoints.load(this.data.id, message.id)).files.find(item => item.path === file && !item.reverted);
            if (entry?.restorable) return { before: entry.before, file: entry.file };
        }
        throw new Error(`No recorded agent change for ${file}.`);
    }
    /** Reverts every agent change to one file, newest reply first, back to its original content. */
    async revertFile(file, force = false) {
        const replies = this.data.messages.filter(message => message.role === 'assistant' && message.changes?.files.some(item => item.path === file && !item.reverted && item.restorable)).reverse();
        if (!replies.length) throw new Error(`${file} has no revertible agent changes.`);
        const result = { conflicts: [], restored: [], skipped: [] };
        for (const [index, message] of replies.entries()) {
            const step = await this.revert(message.id, [file], force || index > 0);
            result.restored.push(...step.restored.filter(item => !result.restored.includes(item))); result.skipped.push(...step.skipped);
        }
        return result;
    }
    async run(command) {
        if (this.turn || this.command || this.switching || this.connecting) throw new Error('Finish or stop the current task first.');
        const cwd = this.adapter.root();
        if (!cwd || !this.adapter.trusted()) throw new Error('Open and trust a project before running commands.');
        if (typeof command !== 'string' || !command.trim() || command.length > 8000) throw new Error('Enter a command up to 8,000 characters.');
        const reply = { id: randomUUID(), role: 'assistant', content: '', kind: 'command', cwd, state: 'running' };
        this.data.messages.push({ id: randomUUID(), role: 'user', content: command, kind: 'command', cwd }, reply);
        this.command = runCommand(reply.id, command, cwd, event => {
            if (event.delta) reply.content += event.delta;
            if (event.done) { reply.exitCode = event.exitCode; reply.state = 'complete'; }
            this.changed();
        });
        this.changed(); await this.save();
        try { await this.command.done; } finally { this.command = undefined; await this.save(); this.changed(); }
    }
    async attach(paths) {
        if (this.turn || this.switching) throw new Error('Finish the reply first.');
        const workspace = this.adapter.workspace(); if (!workspace) throw new Error('Open a trusted project to import attachments.');
        if (this.attachments.length + paths.length > 20) throw new Error('Keep at most 20 attachments per conversation.');
        this.attachments.push(...(await workspace.importFiles(paths)).map(item => ({ ...item, shared: false })));
        await this.save(); this.changed();
    }
    async dispose() { await this.stop(); await this.processes.stopAll(); await this.save(); await this.provider.dispose(); }
}
// Messages the model sees: the latest summary (if any) and everything after it.
function sendable(messages) {
    const at = messages.findLastIndex(message => message.kind === 'summary');
    return at < 0 ? messages : messages.slice(at);
}
const messageTokens = message => message.content.trim() ? estimateTokens(historyText(message)) + 4 : 0;
const historyTokens = messages => messages.reduce((sum, message) => sum + messageTokens(message), 0);
const middle = (text, limit) => `${text.slice(0, Math.floor(limit * 0.4))}\n… [${text.length - limit} characters left out to fit the model's context] …\n${text.slice(-Math.floor(limit * 0.6))}`;
// "@src/app.ts", "@src/", or "@\"docs/my file.md\"" at the start or after whitespace.
function parseMentions(text) {
    const found = new Set();
    for (const match of String(text).matchAll(/(?:^|\s)@(?:"([^"\n]{1,500})"|([^\s"]{1,500}))/g)) {
        const value = (match[1] ?? match[2].replace(/[.,;:!?)\]}]+$/, '')).trim();
        if (value && !value.includes('\0')) found.add(value);
        if (found.size >= 20) break;
    }
    return [...found];
}
async function listFolder(host, directory, base) {
    const result = [], queue = [[directory, 0]];
    while (queue.length && result.length < 300) {
        const [current, depth] = queue.shift();
        let entries;
        try { entries = await host.list(current); } catch { continue; }
        for (const entry of entries) {
            if (result.length >= 300) break;
            if (['.git', 'node_modules'].includes(entry.name)) continue;
            const file = path.join(current, entry.name);
            result.push(path.relative(base, file) + (entry.directory ? '/' : ''));
            if (entry.directory && depth < 2) queue.push([file, depth + 1]);
        }
    }
    return result;
}
// Paths inside the project are shown relative to it.
function displayPath(root) {
    let base = root || null;
    try { if (base) base = fs.realpathSync(base); } catch { /* Use the configured path. */ }
    return file => base && (file === base || file.startsWith(base + path.sep)) ? path.relative(base, file) || '.' : file;
}
module.exports = { Conversation, parseMentions };
