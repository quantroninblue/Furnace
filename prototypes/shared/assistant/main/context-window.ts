// Context budgeting. Providers count tokens differently and most offer no local
// tokenizer, so sizes are estimated (about four characters per token) and budgets
// leave generous headroom. Model IDs are "provider/model" as in the catalog.

export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

/** Context window (tokens) for a catalog model ID. Unknown models get a conservative 128k. */
export function contextWindow(model: string): number {
    const slash = model.indexOf('/'),
        provider = model.slice(0, slash),
        id = model.slice(slash + 1).toLowerCase();
    if (provider === 'claude-code' || provider === 'anthropic') return 200_000;
    // Local models: requests set num_ctx to this (Ollama's own default is smaller).
    if (provider === 'ollama') return OLLAMA_CONTEXT;
    if (provider === 'chatgpt') return /^gpt-5/.test(id) ? 272_000 : 128_000;
    if (/^gpt-4\.1/.test(id)) return 1_000_000;
    if (/^gpt-5/.test(id)) return 400_000;
    if (/^o[134](?:-|$)/.test(id)) return 200_000;
    return 128_000;
}
export const OLLAMA_CONTEXT = 16_384;

/** Room kept free for the reply and the tool calls inside one turn. */
export function replyReserve(window: number) {
    return Math.min(32_000, Math.floor(window * 0.25));
}

/**
 * Condensing starts when the conversation part of a request would pass this share of the
 * window; it then keeps the newest messages worth about a quarter of the window.
 */
export const CONDENSE_AT = 0.6,
    KEEP_RECENT = 0.25;

/** /compact skips history smaller than this: a summary would not be shorter. */
export const COMPACT_MIN = 1_000;

export const summaryInstruction = `Summarize our conversation so far so that you can continue the work from this summary alone; the earlier messages will no longer be available to you.
Include: the user's goals and requirements; decisions made and why; constraints and preferences the user stated; files read, created or changed (with paths) and their current state; commands run and their results; problems found and how they were resolved; open questions; the agreed next steps.
Use short Markdown sections and bullet points. Keep exact names, paths, numbers and error messages. Leave out pleasantries. Do not call tools. Stay under 1,500 words.`;
