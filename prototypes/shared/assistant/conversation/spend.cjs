'use strict';
const { priceFor, costOf, billedByProvider } = require('../main/pricing.ts');
const { createAgentTools } = require('../main/agent-tools.ts');
const { sendable } = require('./context.cjs');
// Token counts and money: provider-reported usage per reply, real token counts from the
// providers' count endpoints for the context meter, dollar cost for API-key models, and the
// rate-limit or plan-usage headers providers send.
const COUNTED = ['openai', 'anthropic', 'chatgpt'];
const providerOf = model => String(model || '').slice(0, String(model || '').indexOf('/'));
class SpendMethods {
    /** Adds one provider usage event to a message's usage (input: latest call; billedInput: every call). */
    addUsage(target, usage) {
        target.usage ||= { input: 0, output: 0 };
        if (usage.input) {
            target.usage.input = usage.input;
            target.usage.billedInput = (target.usage.billedInput || 0) + usage.input;
            target.usage.first ??= usage.input;
        }
        if (usage.output) target.usage.output += usage.output;
    }
    noteLimits(model, limits) {
        this.limits = { ...this.limits, [providerOf(model)]: { ...limits, at: Date.now() } };
    }
    /** Prices a finished reply, summary or review (API-key models only) and adds it to the spend log. */
    settleCost(target, model = target.model) {
        if (!billedByProvider(model || '') || !target.usage || target.cost !== undefined) return;
        const cost = costOf(target.usage, priceFor(model, this.adapter.pricing?.() || {}));
        target.cost = cost;
        if (cost) void this.spend?.add(providerOf(model), cost).then(() => this.changed());
    }
    /** This conversation's estimated cost, and whether some API replies used a model without a known price. */
    costSummary() {
        let total = 0,
            unpriced = 0,
            priced = 0;
        for (const message of this.data.messages)
            for (const item of [message, message.review].filter(Boolean)) {
                const model = item.model || message.model;
                if (!item.usage || !billedByProvider(model || '')) continue;
                if (typeof item.cost === 'number') {
                    total += item.cost;
                    priced++;
                } else unpriced++;
            }
        return priced || unpriced ? { total, unpriced } : null;
    }
    // ---- Real token counts for the context meter ----
    /** Counts the next request with the provider's tokenizer, shortly after things settle. */
    measureSoon(delay = 1500) {
        clearTimeout(this.measureTimer);
        if (!COUNTED.includes(providerOf(this.data.model)) || !this.provider.count) return;
        if (this.disposed) return;
        this.measureTimer = setTimeout(() => {
            void this.measure().catch(() => {});
        }, delay);
        this.measureTimer.unref?.();
    }
    async measure() {
        const model = this.data.model,
            epoch = this.epoch;
        if (this.busy() || !COUNTED.includes(providerOf(model))) return null;
        const estimate = this.usage()?.estimated;
        const context = await this.context('');
        const messages = sendable(this.data.messages)
            .filter(message => message.content.trim())
            .map(({ id, role, content, kind }) => ({ id, role, kind, content }));
        if (!messages.length || messages.at(-1).role !== 'user')
            messages.push({ id: 'count', role: 'user', content: '.' });
        const mode = this.mode(),
            host = this.adapter.toolHost?.() || null;
        const definitions = createAgentTools(
            mode,
            host,
            {
                permission: this.adapter.permission?.() || 'ask',
                signal: new AbortController().signal,
                report: () => {},
                approve: async () => false,
            },
            {
                propose: () => {},
                verify: mode === 'build' ? { brief: () => '', record: () => {}, confirm: () => {} } : undefined,
            },
        ).definitions;
        const tokens = await this.provider.count(
            {
                id: 'count',
                model,
                mode,
                permission: this.adapter.permission?.() || 'ask',
                environment: (this.adapter.environment?.() || '').slice(0, 1000),
                messages,
                context: context.text,
            },
            definitions,
        );
        if (typeof tokens !== 'number' || epoch !== this.epoch || model !== this.data.model || !estimate) return null;
        this.counted = { model, tokens, estimate, at: Date.now() };
        this.changed();
        return tokens;
    }
    /**
     * Provider tokens per estimated token for the current model: from a count, or from the first
     * model call of the latest reply (what was estimated before sending). 1 when unknown.
     */
    tokenScale() {
        const model = this.data.model;
        if (this.counted?.model === model) return clamp(this.counted.tokens / this.counted.estimate);
        if (providerOf(model) === 'claude-code') return 1;
        const reply = this.data.messages.findLast(
            message =>
                message.role === 'assistant' && message.model === model && message.usage?.first && message.estimate,
        );
        return reply ? clamp(reply.usage.first / reply.estimate) : 1;
    }
}
const clamp = value => (Number.isFinite(value) ? Math.min(2.5, Math.max(0.4, value)) : 1);
module.exports = { SpendMethods, providerOf };
