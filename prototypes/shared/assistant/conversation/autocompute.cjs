'use strict';
const { randomUUID } = require('node:crypto');
const { unifiedDiff } = require('../main/diff.ts');
const {
    KINDS,
    DIFFICULTY,
    MAX_REVISIONS,
    MAX_FILES,
    MAX_INSTRUCTIONS,
    LOCAL_TOOLS,
    localModels,
    modelFacts,
    profile,
    chooseModel,
    orchestrationTools,
    workerPrompt,
} = require('../main/autocompute.ts');
// Autocompute: the online model leads a Build turn and delegates tasks to local models through
// local_models, delegate_task and review_task. A local model works in a fresh context with the
// reply's own file tools (same permission mode, approvals and checkpoints), Furnace runs the
// task's check, and the lead model's verdicts become the model's record (main/autocompute.ts).
const REASONING_MAX = 60000;
const snapshot = changes => new Map([...changes.files].map(([file, entry]) => [file, entry.after]));
/** Unified diff of what changed since a snapshot (files first touched since then compare with their original). */
function diffSince(changes, mark) {
    const parts = [];
    for (const [file, entry] of changes.files) {
        const prior = mark.has(file) ? mark.get(file) : entry.before;
        if (entry.touched && prior !== entry.after) parts.push(unifiedDiff(entry.path, prior ?? '', entry.after ?? ''));
    }
    return parts.join('\n');
}
const tail = (text, limit) => (text.length > limit ? `… ${text.slice(-limit)}` : text);
const shortName = model => model.slice(model.indexOf('/') + 1);
class AutocomputeMethods {
    /** The Autocompute checkbox, and why a Build turn could not delegate now. */
    autocomputeState() {
        const locals = localModels(this.connections.models),
            lead = this.data.model || '';
        const reason = !locals.length
            ? 'No local model with tool calling is connected: start Ollama with a model such as qwen3, then refresh Connections.'
            : lead.startsWith('ollama/')
              ? 'A local model is selected: choose an online model (ChatGPT, Claude or an API key) to lead.'
              : '';
        return { enabled: this.autocompute.enabled, ready: !reason, reason, locals: locals.map(model => model.id) };
    }
    async setAutocompute(enabled) {
        if (typeof enabled !== 'boolean') throw new Error('Invalid Autocompute setting.');
        await this.autocompute.setEnabled(enabled);
        this.changed();
    }
    async resetAutocompute(model) {
        await this.autocompute.reset(model || undefined);
        this.changed();
    }
    /** Whether this Build turn delegates to local models; throws when Autocompute is on but cannot lead. */
    autocomputeActive(mode) {
        if (!this.autocompute.enabled || mode !== 'build') return false;
        const state = this.autocomputeState();
        if (!state.ready)
            throw new Error(
                `Autocompute is on, but ${state.reason.replace(/^./, c => c.toLowerCase())} Or untick Autocompute.`,
            );
        return true;
    }
    autocomputeProfile() {
        return profile(localModels(this.connections.models), this.autocompute);
    }
    /**
     * The lead model's tools for one reply. makeTools(by) creates file tools for a local model on the
     * reply's recording host; run(name, args) runs one of the lead's own tools (for checks).
     */
    orchestration(reply, { makeTools, run, changes, signal, epoch, request }) {
        reply.autocompute = { tasks: [], usage: { input: 0, output: 0 } };
        const ctx = {
            reply,
            tasks: new Map(),
            marks: new Map(),
            previous: new Map(),
            makeTools,
            run,
            changes,
            signal,
            epoch,
            request,
        };
        const handlers = {
            local_models: async () => {
                const text = this.autocomputeProfile();
                return text
                    ? `${text}\nKinds marked NOT ALLOWED are refused for that model.`
                    : 'No local model is connected now. Do the remaining work yourself.';
            },
            assess_local_models: args => this.assessLocalModels(args || {}),
            delegate_task: args => this.delegateTask(args || {}, ctx),
            review_task: args => this.reviewTask(args || {}, ctx),
        };
        return {
            definitions: orchestrationTools,
            has: name => Object.hasOwn(handlers, name),
            execute: (name, args) => handlers[name](args),
        };
    }
    async delegateTask(args, ctx) {
        const { reply, tasks, changes, signal, epoch, request } = ctx,
            auto = reply.autocompute;
        let task;
        if (args.task_id) {
            task = tasks.get(String(args.task_id));
            if (!task)
                throw new Error(
                    `There is no task ${String(args.task_id).slice(0, 40)} in this reply. Use task_id null for a new task.`,
                );
            if (task.state !== 'revising')
                throw new Error(
                    task.state === 'review'
                        ? `Call review_task with verdict "revise" for ${task.id} first.`
                        : `Task ${task.id} is ${task.state}; delegate a new task instead.`,
                );
            if (typeof args.notes === 'string' && args.notes.trim() && !task.notes.includes(args.notes.trim()))
                task.notes.push(args.notes.trim().slice(0, 2000));
        } else {
            if (!KINDS.includes(args.kind)) throw new Error(`kind must be one of ${KINDS.join(', ')}.`);
            if (!Object.hasOwn(DIFFICULTY, args.difficulty))
                throw new Error(`difficulty must be one of ${Object.keys(DIFFICULTY).join(', ')}.`);
            const choice = chooseModel(
                this.autocompute,
                localModels(this.connections.models),
                args.kind,
                args.difficulty,
            );
            const open = [...tasks.values()].find(item => ['review', 'revising'].includes(item.state));
            if (open)
                throw new Error(
                    `Finish task ${open.id} first: ${open.state === 'review' ? 'review it with review_task' : 'delegate its revision'}.`,
                );
            if (typeof args.title !== 'string' || !args.title.trim()) throw new Error('Give the task a short title.');
            if (typeof args.instructions !== 'string' || !args.instructions.trim())
                throw new Error('Write the instructions the local model needs.');
            if (args.instructions.length > MAX_INSTRUCTIONS)
                throw new Error(
                    `Instructions are ${args.instructions.length} characters; a local model's context fits at most ${MAX_INSTRUCTIONS}. Split the task or do it yourself.`,
                );
            const files = Array.isArray(args.files)
                ? args.files
                      .filter(item => typeof item === 'string' && item.trim())
                      .map(item => item.trim().slice(0, 300))
                : [];
            if (files.length > MAX_FILES)
                throw new Error(
                    `A local task may name at most ${MAX_FILES} files; this one names ${files.length}. Split it, or do it yourself.`,
                );
            if (
                args.check !== null &&
                args.check !== undefined &&
                (typeof args.check !== 'string' || args.check.length > 1000)
            )
                throw new Error('check must be a command up to 1,000 characters, or null.');
            task = {
                id: `t${tasks.size + 1}`,
                title: args.title.trim().slice(0, 200),
                kind: args.kind,
                difficulty: args.difficulty,
                model: choice.model,
                confidence: choice.confidence,
                scores: choice.scores,
                instructions: args.instructions.trim(),
                files,
                check: typeof args.check === 'string' && args.check.trim() ? args.check.trim() : null,
                state: 'running',
                attempts: 0,
                notes: [],
                summary: '',
                usage: { input: 0, output: 0 },
            };
            tasks.set(task.id, task);
            ctx.marks.set(task.id, snapshot(changes));
            auto.tasks.push(task);
            this.log({
                event: 'delegate',
                title: `Delegated to ${task.model}: ${task.title}`,
                detail: `${task.kind} · ${task.difficulty} · confidence ${task.confidence}`,
            });
        }
        const live = () => epoch === this.epoch && !signal.aborted;
        task.attempts++;
        task.state = 'running';
        task.summary = '';
        task.error = undefined;
        this.changed();
        const before = snapshot(changes);
        // The local model's own tool instance: it must read files itself before overwriting them.
        const tools = ctx.makeTools(task.model);
        const scoped = {
            definitions: tools.definitions.filter(tool => LOCAL_TOOLS.includes(tool.function.name)),
            execute: (name, value) =>
                LOCAL_TOOLS.includes(name)
                    ? tools.execute(name, value)
                    : Promise.reject(new Error(`${name} is not available to local models.`)),
        };
        reply.reasoning =
            `${reply.reasoning ? `${reply.reasoning}\n\n` : ''}── ${shortName(task.model)} · ${task.id} ${task.title}${task.attempts > 1 ? ` (revision ${task.attempts - 1})` : ''} ──\n`.slice(
                -REASONING_MAX,
            );
        let failure = '';
        try {
            await this.provider.run(
                {
                    id: `${reply.id}-${task.id}-${task.attempts}`,
                    model: task.model,
                    mode: 'build',
                    permission: request.permission,
                    environment: request.environment,
                    context: '',
                    messages: [
                        {
                            id: randomUUID(),
                            role: 'user',
                            content: workerPrompt(task, task.notes, ctx.previous.get(task.id) || ''),
                        },
                    ],
                },
                scoped,
                signal,
                event => {
                    if (!live()) return;
                    if (event.delta) task.summary = (task.summary + event.delta).slice(-3000);
                    if (event.thinking)
                        reply.reasoning = ((reply.reasoning || '') + event.thinking).slice(-REASONING_MAX);
                    if (event.usage)
                        for (const target of [task.usage, reply.autocompute.usage]) {
                            target.input += event.usage.input || 0;
                            target.output += event.usage.output || 0;
                        }
                    this.changed();
                },
            );
        } catch (error) {
            if (signal.aborted) throw error;
            failure = error.message;
        }
        signal.throwIfAborted();
        const changedNow = diffSince(changes, before).length > 0;
        let check = '';
        if (task.check) {
            task.state = 'checking';
            this.changed();
            let output;
            try {
                output = await ctx.run('run_command', {
                    command: task.check,
                    workdir: null,
                    timeout_seconds: 900,
                    escalate: false,
                    justification: `Autocompute check for ${task.id}: ${task.title.slice(0, 100)}`,
                    background: false,
                });
            } catch (error) {
                signal.throwIfAborted();
                output = `Exit code: null\n${error.message}`;
            }
            const code = /^Exit code: (-?\d+)/.exec(output);
            task.exitCode = code ? Number(code[1]) : null;
            const body = output.replace(/^Exit code:[^\n]*\n?/, '');
            check =
                task.exitCode === 0
                    ? `Check \`${task.check}\` passed (exit 0).\n${tail(body, 600)}`
                    : `Check \`${task.check}\` FAILED (${task.exitCode === null ? 'did not run' : `exit ${task.exitCode}`}).\n${tail(body, 3000)}`;
        }
        let diff = diffSince(changes, ctx.marks.get(task.id));
        if (diff.length > 12000)
            diff = `${diff.slice(0, 12000)}\n… [diff truncated: ${diff.length - 12000} more characters]`;
        task.state = 'review';
        task.error = failure || undefined;
        const summary = task.summary.trim() || '(none)';
        ctx.previous.set(
            task.id,
            [`Your summary: ${summary.slice(-1000)}`, check && tail(check, 1500)].filter(Boolean).join('\n'),
        );
        this.changed();
        const others = (task.scores || [])
            .filter(score => score.model !== task.model)
            .map(score => `${score.model} ${score.confidence}`)
            .join(', ');
        return [
            `Task ${task.id} · attempt ${task.attempts} · ${task.model} (confidence ${task.confidence}${others ? `; others: ${others}` : ''}) · ${task.kind}: ${task.title}`,
            failure && `The local model stopped with an error: ${failure}`,
            `Local model's summary: ${summary}`,
            changedNow ? '' : 'It changed no files in this attempt.',
            check || 'No check was given.',
            diff ? `Diff of the whole task so far:\n${diff}` : 'The task has changed no files so far.',
            `Now call review_task with task_id "${task.id}".`,
        ]
            .filter(Boolean)
            .join('\n\n');
    }
    /** The lead model's one-time assessment of local models; kept until a model's facts change or a reset. */
    async assessLocalModels(args) {
        const locals = localModels(this.connections.models),
            items = Array.isArray(args.models) ? args.models.slice(0, 20) : [];
        if (!items.length) throw new Error('Give models: one entry per local model to assess.');
        const done = [];
        for (const item of items) {
            const name = String(item?.model ?? '').slice(0, 80),
                model = locals.find(entry => entry.id === name || entry.id === `ollama/${name}`);
            if (!model)
                throw new Error(
                    `${name} is not a connected local model. Available: ${locals.map(entry => entry.id).join(', ') || 'none'}.`,
                );
            const scores = {};
            for (const kind of KINDS) {
                const value = item[kind];
                if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100)
                    throw new Error(`${kind} for ${model.id} must be a number from 0 to 100.`);
                scores[kind] = Math.round(value);
            }
            await this.autocompute.assess(model.id, {
                facts: modelFacts(model),
                scores,
                notes: typeof item.notes === 'string' ? item.notes.trim().slice(0, 300) : '',
                by: this.data.model || '',
                at: Date.now(),
            });
            done.push(model.id);
        }
        this.log({ event: 'assess', title: `Assessed local models: ${done.join(', ')}` });
        this.changed();
        const left = locals
            .filter(model => !this.autocompute.assessment(model.id, modelFacts(model)))
            .map(model => model.id);
        return `Saved; Furnace keeps these until the model changes, so do not assess them again.${left.length ? ` Still not assessed: ${left.join(', ')}.` : ''}\n${this.autocomputeProfile()}`;
    }
    async reviewTask(args, { tasks }) {
        const task = tasks.get(String(args.task_id));
        if (!task) throw new Error(`There is no task ${String(args.task_id).slice(0, 40)} in this reply.`);
        if (task.state !== 'review') throw new Error(`Task ${task.id} is ${task.state}, not waiting for review.`);
        if (!['accept', 'revise', 'takeover'].includes(args.verdict))
            throw new Error('verdict must be accept, revise or takeover.');
        if (args.verdict === 'accept' && task.check && task.exitCode !== 0)
            throw new Error(
                `Task ${task.id}'s check did not pass, so it cannot be accepted. Revise it or take it over.`,
            );
        const notes = typeof args.notes === 'string' ? args.notes.trim().slice(0, 2000) : '';
        if (args.verdict === 'revise') {
            if (task.attempts - 1 >= MAX_REVISIONS)
                throw new Error(`${task.id} has had ${MAX_REVISIONS} revisions already: accept it or take it over.`);
            task.state = 'revising';
            task.verdict = 'revise';
            task.review = notes;
            if (notes) task.notes.push(notes);
            this.changed();
            return `Noted. Call delegate_task with task_id "${task.id}" to send it back to ${task.model}${notes ? ' with these notes' : '; add precise notes'}.`;
        }
        const outcome = args.verdict === 'takeover' ? 'takeover' : task.attempts === 1 ? 'first' : 'revised';
        task.state = args.verdict === 'accept' ? 'accepted' : 'takeover';
        task.verdict = args.verdict;
        task.review = notes;
        task.outcome = outcome;
        this.log({
            event: 'review',
            title: `${args.verdict === 'accept' ? 'Accepted' : 'Took over'} ${task.model}'s task: ${task.title}`,
            status: outcome,
            detail: notes.slice(0, 300),
        });
        await this.autocompute.record(task.model, task.kind, outcome).catch(() => {});
        this.changed();
        return args.verdict === 'accept'
            ? `Accepted. ${task.model}'s record now counts this ${task.kind} task as done.`
            : `Recorded. Finish ${task.id} yourself with your own tools; the local model's changes are still in the files, so keep or replace them.`;
    }
    /** Tasks the lead model never reviewed are marked so; they do not change a model's record. */
    finishAutocompute(reply) {
        for (const task of reply.autocompute?.tasks || [])
            if (['running', 'checking', 'review', 'revising'].includes(task.state)) task.state = 'unreviewed';
    }
}
module.exports = { AutocomputeMethods };
