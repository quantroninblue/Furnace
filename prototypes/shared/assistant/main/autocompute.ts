import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Autocompute: the online model leads a Build turn and delegates small, well-specified tasks to
// local Ollama models through tools. Furnace keeps each local model's record from the online
// model's reviews, describes it in the online model's instructions, and refuses tasks a model
// has not proven it can do, so the lead model cannot hand out work beyond a model's ability.

export const KINDS = ['edit', 'test', 'refactor', 'docs', 'other'] as const;
export type TaskKind = (typeof KINDS)[number];
/** first: accepted on the first attempt; revised: accepted after revision; takeover: the online model did it instead. */
export type Outcome = 'first' | 'revised' | 'takeover';
export type LocalModel = {
    id: string;
    name: string;
    size?: string;
    family?: string;
    vision?: boolean;
    tools?: boolean;
    abilities?: string[];
};

/** Outcomes kept per model and kind; the record is judged on these. */
export const RECENT = 10;
/** A kind is refused once a model has this many outcomes and fewer than half were accepted. */
export const MIN_SAMPLES = 3,
    MIN_RATE = 0.5;
/** Revisions after the first attempt; files a task may name; instruction length that fits a 16k local context. */
export const MAX_REVISIONS = 2,
    MAX_FILES = 4,
    MAX_INSTRUCTIONS = 6000;
/** The lead model's confidence (0–100) the chosen local model needs; below it, the lead does the task itself. */
export const MIN_CONFIDENCE = 50;
/** What a harder task takes off a model's confidence. */
export const DIFFICULTY = { easy: 0, medium: 15, hard: 35 } as const;
export type Difficulty = keyof typeof DIFFICULTY;
/** The lead model's one-time judgement of a local model: base confidence per kind, for the facts it saw. */
export type Assessment = { facts: string; scores: Record<TaskKind, number>; notes: string; by: string; at: number };
/** What a local model may use: no web access, no background processes, no deletes or moves. */
export const LOCAL_TOOLS = [
    'read_file',
    'list_directory',
    'glob',
    'grep',
    'edit_file',
    'apply_patch',
    'write_file',
    'create_directory',
    'run_command',
    'get_problems',
];

const isLocal = (model: { id: string; tools?: boolean }) => model.id.startsWith('ollama/') && model.tools !== false;
export const localModels = <T extends { id: string; tools?: boolean }>(models: T[]) => models.filter(isLocal);

export class AutocomputeStore {
    enabled = false;
    records: Record<string, Partial<Record<TaskKind, Outcome[]>>> = {};
    assessments: Record<string, Assessment> = {};
    private queue: Promise<void> = Promise.resolve();
    constructor(private file: string) {}
    async load() {
        try {
            const data = JSON.parse(await fs.readFile(this.file, 'utf8'));
            this.enabled = data?.enabled === true;
            const records: AutocomputeStore['records'] = {};
            for (const [model, kinds] of Object.entries(data?.records ?? {})) {
                if (typeof model !== 'string' || !model.startsWith('ollama/') || !kinds || typeof kinds !== 'object')
                    continue;
                for (const kind of KINDS) {
                    const list = (kinds as Record<string, unknown>)[kind];
                    if (Array.isArray(list))
                        (records[model] ||= {})[kind] = list
                            .filter((item): item is Outcome => ['first', 'revised', 'takeover'].includes(item))
                            .slice(-RECENT);
                }
            }
            this.records = records;
            const assessments: AutocomputeStore['assessments'] = {};
            for (const [model, item] of Object.entries(data?.assessments ?? {}) as [string, Partial<Assessment>][]) {
                if (!model.startsWith('ollama/') || typeof item?.facts !== 'string' || !item.scores) continue;
                const scores = Object.fromEntries(KINDS.map(kind => [kind, Number(item.scores![kind])])) as Record<
                    TaskKind,
                    number
                >;
                if (KINDS.every(kind => Number.isInteger(scores[kind]) && scores[kind] >= 0 && scores[kind] <= 100))
                    assessments[model] = {
                        facts: item.facts,
                        scores,
                        notes: typeof item.notes === 'string' ? item.notes : '',
                        by: typeof item.by === 'string' ? item.by : '',
                        at: Number(item.at) || 0,
                    };
            }
            this.assessments = assessments;
        } catch {
            /* No settings yet: off, with no record. */
        }
    }
    setEnabled(enabled: boolean) {
        this.enabled = enabled;
        return this.save();
    }
    record(model: string, kind: TaskKind, outcome: Outcome) {
        const list = ((this.records[model] ||= {})[kind] ||= []);
        list.push(outcome);
        list.splice(0, Math.max(0, list.length - RECENT));
        return this.save();
    }
    /** Stores the lead model's assessment of a local model, kept until its facts change or a reset. */
    assess(model: string, item: Assessment) {
        this.assessments[model] = item;
        return this.save();
    }
    /** The stored assessment, if it was made for these facts. */
    assessment(model: string, facts: string) {
        const item = this.assessments[model];
        return item && item.facts === facts ? item : null;
    }
    /** Clears one model's record and assessment (or all of them), so it is assessed again and earns its tasks again. */
    reset(model?: string) {
        if (model) {
            delete this.records[model];
            delete this.assessments[model];
        } else {
            this.records = {};
            this.assessments = {};
        }
        return this.save();
    }
    tally(model: string, kind: TaskKind) {
        const list = this.records[model]?.[kind] ?? [];
        return {
            tries: list.length,
            accepted: list.filter(item => item !== 'takeover').length,
            first: list.filter(item => item === 'first').length,
        };
    }
    allowed(model: string, kind: TaskKind) {
        const { tries, accepted } = this.tally(model, kind);
        return tries < MIN_SAMPLES || accepted / tries >= MIN_RATE;
    }
    private save() {
        const next = this.queue.then(async () => {
            await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
            const temp = `${this.file}.${randomUUID()}.tmp`;
            try {
                await fs.writeFile(
                    temp,
                    JSON.stringify({ enabled: this.enabled, records: this.records, assessments: this.assessments }),
                    { mode: 0o600 },
                );
                await fs.rename(temp, this.file);
            } finally {
                await fs.rm(temp, { force: true });
            }
        });
        this.queue = next.catch(() => {});
        return next;
    }
}

/** What Ollama reports about a model; a change (new size, abilities…) means it must be assessed again. */
export function modelFacts(model: LocalModel) {
    const abilities = model.abilities
        ? `abilities: ${model.abilities.join(', ') || 'none reported'}`
        : 'abilities not reported by this Ollama version, so tool calling is unproven';
    return [model.size && `${model.size} parameters`, model.family, abilities].filter(Boolean).join(', ');
}

/**
 * Confidence (0–100) that a model finishes a task of this kind and difficulty: the lead's one-time
 * assessment for the kind, moved towards the model's accept rate as its record grows, minus a fixed
 * step for harder tasks. null when the model has not been assessed with its current facts.
 */
export function confidence(
    store: AutocomputeStore,
    model: LocalModel,
    kind: TaskKind,
    difficulty: Difficulty = 'easy',
) {
    const base = store.assessment(model.id, modelFacts(model))?.scores[kind];
    if (base === undefined) return null;
    const { tries, accepted } = store.tally(model.id, kind),
        weight = Math.min(tries, RECENT) / RECENT;
    const value = (1 - weight) * base + weight * (tries ? (100 * accepted) / tries : base) - DIFFICULTY[difficulty];
    return Math.max(0, Math.min(100, Math.round(value)));
}

/** One line per local model for the online model's instructions: what it is, its confidence and what it has proven. */
export function profile(models: LocalModel[], store: AutocomputeStore) {
    return models
        .map(model => {
            const facts = modelFacts(model);
            const scores = store.assessment(model.id, facts)
                ? `Confidence for an easy task: ${KINDS.map(kind => `${kind} ${confidence(store, model, kind)}`).join(', ')}`
                : 'NOT ASSESSED yet: assess it with assess_local_models before delegating';
            const record = KINDS.map(kind => {
                const { tries, accepted, first } = store.tally(model.id, kind);
                if (!tries) return `${kind} untested`;
                return `${kind} ${accepted} of ${tries} accepted${accepted > first ? ` (${accepted - first} after revision)` : ''}${store.allowed(model.id, kind) ? '' : ' — NOT ALLOWED, do these yourself'}`;
            }).join('; ');
            return `- ${model.id} (${facts}). ${scores}. Record: ${record}.`;
        })
        .join('\n')
        .slice(0, 3500);
}

/** The Autocompute part of the online model's system instructions (Build mode). */
export const autocomputeInstructions = (
    profileText: string,
) => `Autocompute is on. You are the lead agent: plan the work, keep the difficult parts, and delegate small, well-defined tasks to local models on the user's machine with delegate_task. The user turned this on to save their limited online usage, so delegating is the default, not the exception: when the work includes a unit test, a small edit in one or two files, a rename, comments or docs, or boilerplate that follows an existing example, give it to a local model that is allowed that kind, even when you could write it quickly yourself. Code you write yourself is paid for in online output tokens; a short delegate_task and review_task usually cost far fewer. Do such a task yourself only when no local model is likely to finish it (see the confidence scores below), when every model's record marks its kind NOT ALLOWED, when it is one of the things to keep listed below, or when describing it precisely would be longer than the change itself. You stay responsible for the result.
Local models on this machine, with their confidence and record (from your earlier assessment and reviews):
${profileText}
What a local model gets: a fresh context of about 16,000 tokens holding only the task you write (not this conversation, not the shared context or files you read), and these tools: ${LOCAL_TOOLS.join(', ')}. Local models are much weaker than you and slow on this machine. Give each one a single task a careful junior developer could finish without guessing: name the files (at most ${MAX_FILES}) and the function or place to change, state the exact expected behaviour, and include signatures or short snippets when they matter. Good local tasks: a unit test for code you name, a small edit in one or two files, a rename, comments or docs, boilerplate that follows an existing example. Keep for yourself: design decisions, changes that span many files, subtle bugs, concurrency, security-sensitive code, anything you cannot specify precisely, and every kind a model's record marks NOT ALLOWED. An untested kind is allowed: start a model on a small task of that kind. Bigger models in the list can take somewhat larger tasks than smaller ones.
Each local model is assessed once and Furnace keeps the result. If a model above is NOT ASSESSED, call assess_local_models before delegating: for each such model give a base confidence from 0 to 100 per kind of task, meaning how likely it finishes an easy, precisely specified task of that kind, judged from its size, family and abilities (abilities not reported means tool calling is unproven: score low). Do not assess again models that already have a confidence. For each task, choose its difficulty: easy (one or two files, exact behaviour given), medium (needs some reading or judgement), hard (subtle or spread out; usually keep these yourself). Furnace computes each model's confidence for the task from your assessment, its record and the difficulty (medium −${DIFFICULTY.medium}, hard −${DIFFICULTY.hard}), gives the task to the smallest (fastest) model whose confidence reaches ${MIN_CONFIDENCE}, and refuses when none does: then do it yourself or split it into easier tasks.
Give every task a check command when one exists (a test, type check or script that exits 0 only when the task works). Furnace runs it after the local model finishes and returns the local model's summary, the check result and the diff of the task. Then call review_task: accept when the task is correct and complete; revise when the problems are fixable, then call delegate_task again with the same task_id and precise notes (at most ${MAX_REVISIONS} revisions); takeover when the result is wrong or quicker to fix yourself, then finish it with your own tools. Furnace keeps each model's record from your verdicts and refuses kinds of task a model has not proven, so judge honestly.
Delegate one task at a time and review it before starting the next. Do the rest of the work with your own tools. At the end, run the relevant checks and summarise what you did and what each local model did; if you delegated nothing, say why.`;

const spec = (name: string, description: string, properties: Record<string, Record<string, unknown>>) => ({
    type: 'function' as const,
    function: {
        name,
        description,
        parameters: {
            type: 'object' as const,
            properties,
            required: Object.keys(properties),
            additionalProperties: false as const,
        },
    },
});
/** Parameters in billions from Ollama's parameter_size ("8.2B", "500M"); Infinity when unknown. */
export function parameters(size?: string) {
    const match = /^([\d.]+)\s*([KMBT])$/i.exec(size?.trim() ?? '');
    return match
        ? Number(match[1]) * { K: 1e-6, M: 1e-3, B: 1, T: 1e3 }[match[2].toUpperCase() as 'K' | 'M' | 'B' | 'T']
        : Infinity;
}

/**
 * Picks the local model for a new task: every connected model must have been assessed. Among models
 * allowed the kind whose confidence reaches MIN_CONFIDENCE, the smallest wins (local models are slow,
 * so a bigger one only gets tasks the smaller ones can't take); a tie in size goes to the higher confidence.
 */
export function chooseModel(store: AutocomputeStore, models: LocalModel[], kind: TaskKind, difficulty: Difficulty) {
    const unassessed = models.filter(model => !store.assessment(model.id, modelFacts(model)));
    if (unassessed.length)
        throw new Error(
            `Assess ${unassessed.map(model => model.id).join(', ')} first with assess_local_models (once; Furnace keeps the result).`,
        );
    const eligible = models.filter(model => store.allowed(model.id, kind));
    if (!eligible.length)
        throw new Error(
            `No local model has proven it can do ${kind} tasks (most of their recent ones were taken over). Do this task yourself.`,
        );
    const scores = eligible.map(model => {
        const { tries, accepted } = store.tally(model.id, kind),
            base = store.assessment(model.id, modelFacts(model))!.scores[kind];
        return {
            model: model.id,
            confidence: confidence(store, model, kind, difficulty) ?? 0,
            reason: `assessed ${base}${tries ? `, ${accepted} of ${tries} accepted` : ', untested'}`,
        };
    });
    const size = (id: string) => parameters(models.find(model => model.id === id)?.size);
    const able = scores
        .filter(score => score.confidence >= MIN_CONFIDENCE)
        .sort((a, b) => size(a.model) - size(b.model) || b.confidence - a.confidence);
    if (!able.length) {
        const best = scores.reduce((top, score) => (score.confidence > top.confidence ? score : top));
        throw new Error(
            `No local model is likely enough to finish this ${difficulty} ${kind} task (best: ${best.model} at ${best.confidence}, needs ${MIN_CONFIDENCE}). Do it yourself, or split it into easier tasks.`,
        );
    }
    return { model: able[0].model, confidence: able[0].confidence, scores };
}

/** The lead model's tools for talking to local models. */
export const orchestrationTools = [
    spec(
        'local_models',
        'List the local models with their facts, confidence and record. Your instructions already include this; call it only to refresh after reviews.',
        {},
    ),
    spec(
        'assess_local_models',
        'Once per local model: record your base confidence (0 to 100) that it finishes an easy, precisely specified task of each kind. Furnace keeps it until the model changes, so assess only models marked NOT ASSESSED.',
        {
            models: {
                type: 'array',
                description: 'One entry per model to assess.',
                items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['model', ...KINDS, 'notes'],
                    properties: {
                        model: { type: 'string', description: 'Local model id, for example ollama/qwen3:14b.' },
                        ...Object.fromEntries(
                            KINDS.map(kind => [
                                kind,
                                { type: 'integer', description: `0 to 100: base confidence for an easy ${kind} task.` },
                            ]),
                        ),
                        notes: { type: 'string', description: 'A few words on what the scores are based on.' },
                    },
                },
            },
        },
    ),
    spec(
        'delegate_task',
        "Give one small, precisely specified task to a local model. Furnace picks the smallest model confident enough for its kind and difficulty. It works in a fresh context with only your instructions and file tools, then Furnace runs the check and returns the model's summary, the check result and the diff. Review the result with review_task before delegating the next task. To revise, call again with the same task_id and your notes.",
        {
            difficulty: {
                type: 'string',
                enum: Object.keys(DIFFICULTY),
                description:
                    'easy: one or two files, exact behaviour given; medium: needs some reading or judgement; hard: subtle or spread out.',
            },
            kind: {
                type: 'string',
                enum: [...KINDS],
                description: 'What kind of task this is; the model must be allowed this kind.',
            },
            title: { type: 'string', description: 'Short title shown to the user.' },
            instructions: {
                type: 'string',
                description: `Everything the local model needs, at most ${MAX_INSTRUCTIONS} characters: the files and places to change, the exact behaviour, signatures or snippets. It cannot see this conversation.`,
            },
            files: {
                type: 'array',
                items: { type: 'string' },
                description: `Project-relative files the task reads or changes (at most ${MAX_FILES}).`,
            },
            check: {
                type: ['string', 'null'],
                description:
                    'Command that exits 0 only when the task works (a test or type check); null when none exists.',
            },
            task_id: {
                type: ['string', 'null'],
                description: 'To revise an earlier task: its id. null for a new task.',
            },
            notes: {
                type: ['string', 'null'],
                description: 'When revising: exactly what to fix. null for a new task.',
            },
        },
    ),
    spec(
        'review_task',
        "Record your verdict on a delegated task. accept: correct and complete. revise: fixable, then call delegate_task again with the task_id and notes. takeover: you will finish it yourself. This sets the local model's record, which decides what it may be given later.",
        {
            task_id: { type: 'string', description: 'The task id from delegate_task.' },
            verdict: { type: 'string', enum: ['accept', 'revise', 'takeover'], description: 'Your verdict.' },
            notes: { type: 'string', description: 'One or two sentences: what was right or wrong.' },
        },
    ),
];
export const orchestrationNames = orchestrationTools.map(tool => tool.function.name);

/** What the local model is told: one task, done with tools, in a context of its own. */
export function workerPrompt(
    task: { title: string; instructions: string; files: string[]; check: string | null },
    notes: string[],
    previous: string,
) {
    return `You are doing one task of a larger piece of work that another model planned and will review. Do only this task, using your tools: read the files you need, then make the change with edit_file, apply_patch or write_file. Describing a change does not make it; only your tool calls change files. Do not touch files the task does not need, and do not run the check yourself: Furnace runs it when you finish. End with one or two sentences saying what you changed.

Task: ${task.title}
${task.instructions}
Files: ${task.files.length ? task.files.join(', ') : '(find them yourself)'}
Check that must pass: ${task.check ? `\`${task.check}\`` : 'none'}${notes.length ? `\n\nYour earlier attempt was reviewed. Fix these points:\n${notes.map(note => `- ${note}`).join('\n')}` : ''}${previous ? `\n\nResult of your earlier attempt:\n${previous}` : ''}`;
}
