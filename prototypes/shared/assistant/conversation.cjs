'use strict';
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Sessions } = require('./main/sessions.ts');
const { TurnChanges, recordingHost, Checkpoints } = require('./main/checkpoints.ts');
const { createAgentTools } = require('./main/agent-tools.ts');
const { runCommand } = require('./main/commands.ts');
const { validImages } = require('./main/agent-context.ts');
const { contextWindow } = require('./main/context-window.ts');
const { PermissionRules } = require('./main/permissions.ts');
const { AuditLog } = require('./main/audit.ts');
const { BackgroundProcesses } = require('./main/processes.ts');
const { tickBrief, briefSteps, markStep, checkText } = require('./main/plan-link.ts');
const { runAgentCommand } = require('./main/commands.ts');
const { ContextMethods, parseMentions } = require('./conversation/context.cjs');
const { HistoryMethods } = require('./conversation/history.cjs');
const { SpendMethods } = require('./conversation/spend.cjs');
const { ReviewMethods } = require('./conversation/review.cjs');
const { SpendLedger } = require('./main/spend.ts');
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
        this.spend = new SpendLedger(path.join(directory, 'settings', 'spend.json')); void this.spend.load().then(() => this.changed());
        this.limits = {};
        this.processes = new BackgroundProcesses(adapter.terminals || null, () => this.changed(), (info, event) => this.log({ event: 'process', tool: 'run_command', title: `${event === 'started' ? 'Started' : event === 'stopped' ? 'Stopped' : 'Exited'} background process: ${info.command}`, status: event, detail: info.exitCode === null ? info.cwd : `exit ${info.exitCode}` }));
    }
    busy() { return !!(this.turn || this.command || this.switching || this.connecting || this.checking); }
    snapshot() {
        const first = this.data.messages.find(m => m.role === 'user' && !m.kind)?.content.slice(0, 90);
        return { id: this.data.id, title: this.data.customTitle || first || 'New conversation', messages: this.data.messages, model: this.data.model, busy: !!this.turn || !!this.command, switching: !!this.switching,
            compacting: !!this.turn?.compacting,
            attachments: this.attachments.map(({ text, ...item }) => ({ ...item, readable: typeof text === 'string' })), sharePlan: this.sharePlan, shareEditor: this.shareEditor,
            shareSelection: this.shareSelection, shareDiff: this.shareDiff, shareProblems: this.shareProblems, contextInfo: this.adapter.contextInfo?.() || null,
            connections: this.connections, connecting: !!this.connecting, error: this.persistenceError || this.error,
            permission: this.adapter.permission?.() || 'ask', agent: this.adapter.agentState?.() || null, grants: [...this.grants],
            usage: this.usage(), queue: this.queued.map(({ id, text }) => ({ id, text })), queuePaused: this.queuePaused,
            images: this.images.map(({ data, ...image }) => image), processes: this.processes.list(), rules: this.rules.list(this.adapter.root()),
            planSteps: this.planSteps(), checking: this.checking || null, untrusted: this.untrustedLabels(),
            cost: this.costSummary(), spend: this.spend.summary(), budget: this.adapter.budget?.() || 0, limits: this.limits };
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
        this.data.model = value; this.changed(); void this.save(); this.measureSoon();
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
        // Untrusted content in the conversation makes commands and web access ask (agent-tools.ts).
        const shared = this.sharedUntrusted(), taint = new Set([...this.untrustedLabels(), ...shared]);
        this.data.messages.push({ id: randomUUID(), role: 'user', content: text.trim(), model: this.data.model, createdAt: Date.now(), ...(shared.length ? { untrusted: shared } : {}),
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
            untrusted: { list: () => [...taint], add: label => {
                if (epoch !== this.epoch || taint.has(label)) return;
                taint.add(label); reply.untrusted = [...(reply.untrusted || []), label].slice(0, 20); this.changed();
            } },
        }, {
            plan: this.sharePlan ? this.session.state.brief : '', sources: this.citedSources(),
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
                    if (event.usage) this.addUsage(reply, event.usage);
                    if (event.limits) this.noteLimits(reply.model, event.limits);
                    this.changed();
                });
                reply.state = controller.signal.aborted ? 'stopped' : 'complete';
            } catch (error) { reply.state = controller.signal.aborted ? 'stopped' : 'failed'; reply.error = controller.signal.aborted ? 'Reply stopped.' : error.message; this.error = reply.error; if (/service disconnected|service timed out/.test(error.message)) this.connections = { models: [], connections: [], error: 'Assistant service stopped. Refresh Connections to reconnect.' }; }
            finally {
                clearInterval(checkpoint); reply.endedAt = Date.now(); reply.phase = undefined;
                this.settleCost(reply);
                const citations = this.citationsIn(reply.content); if (citations.length) reply.citations = citations;
                await persistChanges();
                if (this.turn === turn) this.turn = undefined;
                await this.save(); this.changed();
                if (mode === 'build' && reply.state === 'complete' && reply.changes?.files.length && this.adapter.reviewSettings?.().automatic && epoch === this.epoch)
                    await this.reviewChanges(reply.id).catch(error => { this.error = `Review did not run: ${error.message}`; this.changed(); });
                this.afterTurn(reply, epoch);
            }
        })();
        return turn.done;
    }
    async stop() { this.denyApprovals(); const turn = this.turn; turn?.controller.abort(); this.command?.stop(); this.checkController?.abort(); await turn?.done; await this.command?.done; }
    // ---- Plan → Build → Verify: a step with a check is ticked only with passing evidence ----
    planSteps() {
        const evidence = this.data.evidence || {};
        return briefSteps(this.session.state.brief).map(step => ({ key: step.key, text: step.text, done: step.done,
            check: step.check ? { kind: step.check.kind, text: checkText(step.check) } : null, evidence: evidence[step.key] || null }));
    }
    /** Keeps the latest check result for a step; passing ticks it in the brief, failing unticks it. */
    recordEvidence(key, evidence) {
        this.data.evidence = { ...this.data.evidence, [key]: { ...evidence, output: evidence.output?.slice(-6000) } };
        const brief = markStep(this.session.state.brief, key, evidence.status === 'passed');
        if (brief !== null) { this.session.update('brief', brief); this.adapter.persistSession?.(); }
        const step = briefSteps(this.session.state.brief).find(item => item.key === key);
        this.log({ event: 'verify', title: `${evidence.status === 'passed' ? 'Verified' : 'Check failed'}: ${step?.text || key}`, status: evidence.status, decision: evidence.by === 'you' ? 'by you' : 'by the agent', detail: evidence.check });
        void this.save(); this.changed();
    }
    /** The user runs a step's check command from the Plan page (their permissions, like Run). */
    async checkStep(key) {
        this.idle();
        const step = briefSteps(this.session.state.brief).find(item => item.key === key);
        if (step?.check?.kind !== 'command') throw new Error('This step has no check command to run.');
        const cwd = this.adapter.root();
        if (!cwd || !this.adapter.trusted()) throw new Error('Open and trust the project to run checks.');
        this.checking = key; this.changed();
        try {
            const controller = new AbortController(); this.checkController = controller;
            const result = await runAgentCommand(step.check.command, { cwd, timeoutMs: 15 * 60 * 1000, signal: controller.signal, terminal: this.adapter.terminals?.open(step.check.command, cwd, false) });
            this.recordEvidence(key, { status: result.exitCode === 0 ? 'passed' : 'failed', check: step.check.command, kind: 'command', exitCode: result.exitCode, output: result.output, at: Date.now(), by: 'you' });
            return result.exitCode === 0;
        } finally { this.checking = null; this.checkController = undefined; this.changed(); }
    }
    /** The user confirms (or fails) a step's manual check. */
    confirmStep(key, passed) {
        const step = briefSteps(this.session.state.brief).find(item => item.key === key);
        if (!step) throw new Error('That step is no longer in the brief.');
        this.recordEvidence(key, { status: passed ? 'passed' : 'failed', check: step.check ? checkText(step.check) : 'manual: confirmed by you', kind: 'manual', at: Date.now(), by: 'you' });
    }
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
        if (epoch === this.epoch) this.measureSoon();
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
        if (proposal.kind === 'plan') this.session.update('brief', this.withSourceList(proposal.text));
        else if (proposal.kind === 'browse') await this.research.open(proposal.text);
        else if (proposal.kind === 'command') { proposal.status = 'running'; this.changed(); await this.run(proposal.text); }
        else if (proposal.kind === 'verify') this.recordEvidence(proposal.key, { status: 'passed', check: `manual: ${proposal.text}`, kind: 'manual', at: Date.now(), by: 'you' });
        proposal.status = 'applied'; this.record(`User approved ${proposal.kind}: ${proposal.kind === 'plan' ? 'planning brief updated' : proposal.text}`); this.proposals.delete(id); await this.save(); this.changed();
    }
    async discard(id) {
        const proposal = this.proposals.get(id);
        if (proposal) {
            // A manual check the user marks as failed keeps that evidence.
            if (proposal.kind === 'verify') this.recordEvidence(proposal.key, { status: 'failed', check: `manual: ${proposal.text}`, kind: 'manual', at: Date.now(), by: 'you' });
            proposal.status = proposal.kind === 'verify' ? 'failed' : 'discarded'; this.proposals.delete(id); this.adapter.files.pending.delete(id);
        }
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
        // With untrusted content in the conversation, chat grants and allow rules do not skip the question.
        if (!step.untrusted && this.grants.has(step.approval)) { step.allowedBy = 'allowed for this chat'; return Promise.resolve(true); }
        const rule = !step.untrusted && step.rule && step.approval !== 'outside' && this.rules.allows(this.adapter.root(), step.rule.kind === 'command' ? { kind: 'command', command: step.rule.subject } : step.rule.kind === 'network' ? { kind: 'network', host: step.rule.subject } : { kind: 'edit' });
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
    async dispose() {
        clearTimeout(this.measureTimer); this.disposed = true;
        await this.stop(); await this.processes.stopAll(); await this.save(); await this.saveQueue; await this.provider.dispose();
        await this.audit.idle(); await this.spend.idle();
    }
}
// Paths inside the project are shown relative to it.
function displayPath(root) {
    let base = root || null;
    try { if (base) base = fs.realpathSync(base); } catch { /* Use the configured path. */ }
    return file => base && (file === base || file.startsWith(base + path.sep)) ? path.relative(base, file) || '.' : file;
}
// Method groups kept in their own files (context and condensing; history and going back).
for (const group of [ContextMethods, HistoryMethods, SpendMethods, ReviewMethods])
    for (const name of Object.getOwnPropertyNames(group.prototype)) if (name !== 'constructor') Object.defineProperty(Conversation.prototype, name, Object.getOwnPropertyDescriptor(group.prototype, name));
module.exports = { Conversation, parseMentions };
