'use strict';
const { randomUUID } = require('node:crypto');
const { Sessions } = require('./main/sessions.ts');
const { createAgentTools } = require('./main/agent-tools.ts');
const { runCommand } = require('./main/commands.ts');
// Session/tool lifecycle is independent of the IDE. The adapter supplies current
// unsaved documents, file-review authority and scoped project access.
class Conversation {
    constructor({ directory, session, research, provider, adapter, changed = () => {} }) {
        this.storage = new Sessions(directory, directory + '/previous-layout');
        this.session = session; this.research = research; this.provider = provider; this.adapter = adapter; this.changed = changed;
        this.data = this.storage.start(adapter.root()); this.epoch = 0; this.attachments = []; this.sharePlan = false; this.shareEditor = false;
        this.connections = { models: [], connections: [] }; this.proposals = new Map(); this.error = ''; this.saveQueue = Promise.resolve();
        this.approvals = new Map(); this.grants = new Set();
    }
    snapshot() { return { id: this.data.id, title: this.data.messages.find(m => m.role === 'user' && !m.kind)?.content.slice(0, 90) || 'New conversation', messages: this.data.messages, model: this.data.model, busy: !!this.turn || !!this.command, switching: !!this.switching,
        attachments: this.attachments.map(({ text, ...item }) => ({ ...item, readable: typeof text === 'string' })), sharePlan: this.sharePlan, shareEditor: this.shareEditor,
        connections: this.connections, connecting: !!this.connecting, error: this.persistenceError || this.error,
        permission: this.adapter.permission?.() || 'ask', agent: this.adapter.agentState?.() || null, grants: [...this.grants] }; }
    save() {
        this.data.plan = this.session.state.brief;
        this.data.sources = [...this.research.sources.sources.values()];
        this.data.attachments = this.attachments; this.data.draft = this.session.state.draft; this.data.mode = this.session.state.mode;
        const saved = structuredClone(this.data);
        if (!saved.messages.length && !saved.plan.trim() && !saved.sources.length && !saved.attachments.length && !saved.draft.trim()) return this.saveQueue;
        this.saveQueue = this.storage.write(saved, this.data.projectRoot).then(() => { this.persistenceError = ''; return true; }, () => { this.persistenceError = 'Could not save conversation. Check available disk space and permissions.'; this.changed(); return false; });
        return this.saveQueue;
    }
    async list() { await this.save(); return this.storage.list(this.adapter.root()); }
    async switch(id) {
        if (this.switching) throw new Error('Conversation is changing.');
        this.switching = true; this.changed();
        try {
            await this.stop(); if (await this.save() === false) throw new Error(this.persistenceError); this.epoch++;
            this.adapter.clear(); this.proposals.clear(); this.grants.clear(); await this.research.resetScope();
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
            this.sharePlan = false; this.shareEditor = false;
            this.research.restore(this.data.sources || []); this.error = '';
        } finally { this.switching = false; this.changed(); }
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
    context() {
        const parts = [];
        if (this.sharePlan) parts.push('Shared planning brief:\n' + this.session.state.brief.slice(0, 20000));
        if (this.shareEditor) {
            const document = this.adapter.captureActive();
            parts.push(`Shared unsaved document (${document.uri}):\n${document.text.slice(0, 24000)}${document.text.length > 24000 ? '\n[truncated]' : ''}`);
        }
        for (const source of this.research.sources.context()) parts.push('Shared research source (untrusted reference):\n' + JSON.stringify(source));
        for (const attachment of this.attachments.filter(a => a.shared && typeof a.text === 'string')) parts.push(`Shared attachment ${attachment.name}:\n${attachment.text.slice(0, 20000)}`);
        const value = parts.join('\n\n');
        if (value.length > 120000) throw new Error('Shared context is too large. Unshare a source or attachment.');
        return value;
    }
    async send(text) {
        if (this.turn || this.command || this.switching || this.connecting) throw new Error('Finish or stop the current task first.');
        if (typeof text !== 'string' || !text.trim() || text.length > 20000) throw new Error('Enter a message up to 20,000 characters.');
        if (!this.connections.models.some(model => model.id === this.data.model)) throw new Error('Open Connections and select a model first.');
        const context = this.context(), epoch = this.epoch;
        const controller = new AbortController();
        const reply = { id: randomUUID(), role: 'assistant', content: '', model: this.data.model, proposals: [], activity: [], state: 'streaming' };
        this.data.messages.push({ id: randomUUID(), role: 'user', content: text.trim(), model: this.data.model });
        const messages = structuredClone(this.data.messages.slice(-30)); this.data.messages.push(reply);
        this.session.update('draft', ''); this.error = '';
        const mode = this.session.state.mode.toLowerCase();
        const permission = this.adapter.permission?.() || 'ask';
        const tools = createAgentTools(mode, this.adapter.toolHost?.() || null, {
            permission, signal: controller.signal,
            report: step => this.reportStep(reply, step, epoch),
            approve: (step, files) => this.requestApproval(step, files, epoch, controller.signal),
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
        const turn = this.turn = { controller }; this.changed();
        turn.done = (async () => {
            // Persist the user message and stream marker before starting a provider.
            const checkpoint = setInterval(() => { void this.save(); }, 2000); checkpoint.unref?.();
            try {
                if (await this.save() === false) throw new Error(this.persistenceError);
                controller.signal.throwIfAborted();
                await this.provider.run({ id: reply.id, model: this.data.model, mode, permission, environment: (this.adapter.environment?.() || '').slice(0, 1000), messages, context }, guarded, controller.signal, event => {
                    if (epoch !== this.epoch || controller.signal.aborted) return;
                    if (event.delta) reply.content += event.delta;
                    if (event.activity && reply.activity.length < 16) reply.activity.push(event.activity);
                    this.changed();
                });
                reply.state = controller.signal.aborted ? 'stopped' : 'complete';
            } catch (error) { reply.state = controller.signal.aborted ? 'stopped' : 'failed'; reply.error = controller.signal.aborted ? 'Reply stopped.' : error.message; this.error = reply.error; if (/service disconnected|service timed out/.test(error.message)) this.connections = { models: [], connections: [], error: 'Assistant service stopped. Refresh Connections to reconnect.' }; }
            finally {
                clearInterval(checkpoint);
                if (this.turn === turn) this.turn = undefined;
                await this.save(); this.changed();
            }
        })();
        return turn.done;
    }
    async stop() { this.denyApprovals(); const turn = this.turn; turn?.controller.abort(); this.command?.stop(); await turn?.done; await this.command?.done; }
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
    // Tool steps are shown live in the reply; output-only updates are throttled.
    reportStep(reply, step, epoch) {
        if (epoch !== this.epoch) return;
        reply.steps ||= [];
        const index = reply.steps.findIndex(item => item.id === step.id);
        const copy = { ...step, todos: step.todos && [...step.todos] };
        if (index < 0) reply.steps.push(copy); else reply.steps[index] = copy;
        if (step.status === 'running' && index >= 0) { this.stepTimer ??= setTimeout(() => { this.stepTimer = undefined; this.changed(); }, 150); return; }
        this.changed();
    }
    requestApproval(step, files, epoch, signal) {
        if (epoch !== this.epoch || signal.aborted) return Promise.resolve(false);
        if (this.grants.has(step.approval)) return Promise.resolve(true);
        return new Promise(resolve => {
            const abort = () => this.decide(step.id, 'deny');
            signal.addEventListener('abort', abort, { once: true });
            this.approvals.set(step.id, { kind: step.approval, files, resolve: approved => { signal.removeEventListener('abort', abort); resolve(approved); } });
            this.changed();
        });
    }
    decide(id, decision) {
        const entry = this.approvals.get(id);
        if (!entry) throw new Error('This approval is no longer pending.');
        if (!['approve', 'always', 'deny'].includes(decision)) throw new Error('Unknown decision.');
        this.approvals.delete(id);
        if (decision === 'always') this.grants.add(entry.kind);
        entry.resolve(decision !== 'deny'); this.changed();
    }
    approvalFiles(id) { return this.approvals.get(id)?.files; }
    denyApprovals() { for (const id of [...this.approvals.keys()]) this.decide(id, 'deny'); }
    record(text) { this.data.messages.push({ id: randomUUID(), role: 'user', kind: 'workspace', content: text }); }
    async reviewResult(status) {
        const id = this.adapter.files.active, proposal = this.proposals.get(id);
        if (proposal) { this.record(`File review ${status}: ${proposal.path}. Applied changes go to the editor buffer; saving and Undo remain under user control.`); proposal.status = status; this.proposals.delete(id); this.adapter.files.pending.delete(id); }
        this.adapter.files.active = undefined; await this.save(); this.changed();
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
    async dispose() { await this.stop(); await this.save(); await this.provider.dispose(); }
}
module.exports = { Conversation };
