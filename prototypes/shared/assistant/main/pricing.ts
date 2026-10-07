// Dollar estimates for API-key models (provider billing). ChatGPT, Claude Code and Ollama use the
// user's plan, account or machine, so they have no per-token cost here. Prices are US dollars per
// million tokens, list price without caching or batch discounts; models not listed show no cost
// unless the user adds them in the aiGui.pricing setting.
export type Price = { input: number; output: number };
const table: [RegExp, Price][] = [
  // Anthropic (first-party API rates, September 2026).
  [/^claude-(?:fable|mythos)-5/, { input: 10, output: 50 }],
  [/^claude-opus-5-5/, { input: 4, output: 20 }],
  [/^claude-opus-(?:5|4-[5-9])/, { input: 5, output: 25 }],
  [/^claude-opus-4/, { input: 15, output: 75 }],
  [/^claude-sonnet-5/, { input: 2, output: 10 }],
  [/^claude-sonnet-4/, { input: 3, output: 15 }],
  [/^claude-haiku-4/, { input: 1, output: 5 }],
  [/^claude-3-5-haiku/, { input: 0.8, output: 4 }],
  // OpenAI (published list prices of these model families).
  [/^gpt-5(?:-\d{4}|$)/, { input: 1.25, output: 10 }],
  [/^gpt-5-mini/, { input: 0.25, output: 2 }],
  [/^gpt-5-nano/, { input: 0.05, output: 0.4 }],
  [/^gpt-4\.1-mini/, { input: 0.4, output: 1.6 }],
  [/^gpt-4\.1-nano/, { input: 0.1, output: 0.4 }],
  [/^gpt-4\.1/, { input: 2, output: 8 }],
  [/^gpt-4o-mini/, { input: 0.15, output: 0.6 }],
  [/^gpt-4o/, { input: 2.5, output: 10 }],
  [/^o4-mini/, { input: 1.1, output: 4.4 }],
  [/^o3-mini/, { input: 1.1, output: 4.4 }],
  [/^o3/, { input: 2, output: 8 }],
];
export const billedByProvider = (model: string) => /^(?:openai|anthropic)\//.test(model);

/** Price for a catalog model ID ("provider/model"); overrides are keyed by either form. */
export function priceFor(model: string, overrides: Record<string, Price> = {}): Price | null {
  if (!billedByProvider(model)) return null;
  const id = model.slice(model.indexOf("/") + 1).toLowerCase();
  const custom = overrides[model] ?? overrides[id];
  if (custom && Number.isFinite(custom.input) && Number.isFinite(custom.output)) return custom;
  return table.find(([pattern]) => pattern.test(id))?.[1] ?? null;
}
export type Usage = { input?: number; output?: number; billedInput?: number };
/** Dollars for one reply: every model call's input (billedInput) plus the output it generated. */
export function costOf(usage: Usage | undefined, price: Price | null) {
  if (!usage || !price) return null;
  return ((usage.billedInput ?? usage.input ?? 0) * price.input + (usage.output ?? 0) * price.output) / 1_000_000;
}
