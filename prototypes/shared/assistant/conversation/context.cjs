'use strict';
const { randomUUID } = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { definitionsSize, protectedPath, binaryFile } = require('../main/agent-tools.ts');
const { agentInstructions, historyText } = require('../main/agent-context.ts');
const { orchestrationTools } = require('../main/autocompute.ts');
const { estimateTokens, replyReserve, CONDENSE_AT, KEEP_RECENT, COMPACT_MIN, summaryInstruction } = require('../main/context-window.ts');
// Conversation context: what the next request contains, how full the model's window is,
// and condensing older messages into a summary when it fills up.
class ContextMethods {
    mode() { return this.session.state.mode.toLowerCase(); }
    systemTokens(mode = this.mode()) {
        this.definitionSizes ??= new Map();
        if (!this.definitionSizes.has(mode)) this.definitionSizes.set(mode, definitionsSize(mode));
        // With Autocompute, Build turns also carry the local models' profile and the delegation tools.
        const delegating = mode === 'build' && this.autocompute?.enabled && this.autocomputeState().ready;
        return estimateTokens(agentInstructions(mode, this.adapter.permission?.() || 'ask', (this.adapter.environment?.() || '').slice(0, 1000), delegating ? this.autocomputeProfile() : ''))
            + Math.ceil((this.definitionSizes.get(mode) + (delegating ? JSON.stringify(orchestrationTools).length : 0)) / 4);
    }
    /**
     * Tokens for the next request: instructions and tools, conversation since the last summary,
     * shared context. Estimated at about four characters per token, then corrected with the
     * provider's own count (or the last reply's measured input) when there is one.
     */
    usage() {
        if (!this.data.model) return null;
        const window = this.windowFor(this.data.model), history = historyTokens(sendable(this.data.messages)), shared = Math.ceil(this.contextChars() / 4), system = this.systemTokens();
        const measured = this.data.messages.findLast(message => message.role === 'assistant' && message.usage)?.usage;
        const estimated = system + history + shared, scale = this.tokenScale(), counted = this.counted?.model === this.data.model;
        // A provider count is exact for what it counted; only later changes are estimated.
        const used = counted ? Math.max(0, Math.round(this.counted.tokens + (estimated - this.counted.estimate) * scale)) : Math.round(estimated * scale);
        return { used, estimated, window, system: Math.round(system * scale), history: Math.round(history * scale), shared: Math.round(shared * scale),
            condensed: this.data.messages.filter(message => message.kind === 'summary').length, measured: measured ? { input: measured.input, output: measured.output } : null,
            source: counted ? 'counted' : scale !== 1 ? 'calibrated' : 'estimated' };
    }
    // ---- Citations: research sources keep a stable key ([S1], [S2] …) for the whole conversation ----
    citationKeys() {
        const known = this.data.citations ||= {}, keys = {};
        let next = Math.max(0, ...Object.values(known).map(item => Number(item.key.slice(1)) || 0));
        for (const source of this.research.sources.sources.values())
            known[source.id] ??= { key: `S${++next}`, title: String(source.title || source.url).slice(0, 200), url: source.url };
        for (const [id, item] of Object.entries(known)) keys[id] = item.key;
        return keys;
    }
    /** Shared sources, each with its citation key. */
    citedSources() { const keys = this.citationKeys(); return this.research.sources.context().map(source => ({ ...source, cite: keys[source.id] })); }
    /** The sources a text cites ([S1] …), with title and URL; removed sources are remembered. */
    citationsIn(text) {
        this.citationKeys();
        const found = new Set(String(text || '').match(/\[S\d{1,3}\]/g) || []);
        return Object.values(this.data.citations).filter(item => found.has(`[${item.key}]`)).map(item => ({ ...item }))
            .sort((a, b) => Number(a.key.slice(1)) - Number(b.key.slice(1)));
    }
    /** Brief text with a Sources list (Markdown reference links) for every source it cites. */
    withSourceList(text) {
        const missing = this.citationsIn(text).filter(item => !new RegExp(`^\\[${item.key}\\]:`, 'm').test(text));
        if (!missing.length) return text;
        return `${text.replace(/\s+$/, '')}${/^#+\s*Sources\s*$/im.test(text) ? '' : '\n\n## Sources'}\n${missing.map(item => `[${item.key}]: ${item.url} "${item.title.replace(/"/g, "'")}"`).join('\n')}\n`;
    }
    /** Labels of untrusted content the next request carries: earlier messages (since the last summary) and shared context. */
    untrustedLabels() {
        return [...new Set([...sendable(this.data.messages).flatMap(message => message.untrusted || []), ...this.sharedUntrusted()])].slice(0, 20);
    }
    sharedUntrusted() {
        const labels = this.research.sources.context().map(source => `research source from ${hostOf(source.url)}`);
        for (const attachment of this.attachments) if (attachment.shared && typeof attachment.text === 'string') labels.push(`attachment ${attachment.name}`);
        return [...new Set(labels)];
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
        for (const source of this.citedSources()) parts.push(`Shared research source [${source.cite}] (untrusted reference; cite it as [${source.cite}]):\n${JSON.stringify(source)}`);
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
                    const content = await host.read(real), lines = content.split('\n').length, truncated = content.length > 40000, binary = binaryFile(real, content);
                    if (binary) entry = { path: relative, kind: 'skipped', error: `${binary}, not text`, text: `@${relative} was not shared: it is a ${binary}, not text. Paste images into the message box instead.` };
                    else entry = { path: relative, kind: 'file', lines, truncated, text: `Mentioned file @${relative} (${lines} lines${truncated ? ', first 40,000 characters' : ''}):\n${content.slice(0, 40000)}` };
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
        // Budgets are in estimated tokens, so the window is scaled by how the provider counts.
        const window = Math.floor(this.windowFor(this.data.model) / this.tokenScale());
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
        reply.estimate = this.systemTokens() + historyTokens(copy) + estimateTokens(contextText);
        if (dropped) reply.contextNote = `${dropped} older message${dropped === 1 ? '' : 's'} did not fit in the model's context and ${dropped === 1 ? 'was' : 'were'} left out of this request.`;
        return copy;
    }
    /**
     * Summarises the conversation before a cut point into a "summary" message inserted there.
     * Keeps the newest messages worth `keep` tokens (and always the latest one when `keepLast`).
     * Returns false when there is nothing to condense. A failed summary leaves a visible note
     * and the older messages are simply no longer sent. With `manual` (/compact), history too
     * small to gain from a summary, or a summary no shorter than what it replaces, is left as
     * it was and the reason is returned instead.
     */
    async condense(pending, keep, keepLast, signal, epoch, idBase, manual = false) {
        const previousAt = pending.findLastIndex(message => message.kind === 'summary'), start = previousAt + 1;
        let cut = pending.length - (keepLast ? 1 : 0), size = 0;
        while (cut > start) { const next = size + messageTokens(pending[cut - 1]); if (next > keep) break; size = next; cut--; }
        // Start the kept part at one of the user's own messages.
        while (cut < pending.length && !(pending[cut].role === 'user' && !pending[cut].kind)) cut++;
        if (keepLast && cut > pending.length - 1) cut = pending.length - 1;
        const items = pending.slice(start, cut).filter(message => message.content.trim() && message.kind !== 'summary');
        if (!items.length) return false;
        const previous = previousAt >= 0 && !pending[previousAt].failed ? pending[previousAt].content : '';
        const replaced = historyTokens(items) + (previous ? estimateTokens(previous) : 0);
        if (manual && replaced < COMPACT_MIN) return `Too little to condense yet: the earlier messages are only about ${replaced} tokens.`;
        const anchor = pending[cut], insert = note => {
            const at = anchor ? this.data.messages.indexOf(anchor) : this.data.messages.length;
            this.data.messages.splice(at < 0 ? this.data.messages.length : at, 0, note); this.changed();
        };
        // A summary of untrusted content is still untrusted.
        const untrusted = [...new Set(pending.slice(previousAt < 0 ? 0 : previousAt, cut).flatMap(message => message.untrusted || []))].slice(0, 20);
        const base = { role: 'user', kind: 'summary', condensed: cut, createdAt: Date.now(), model: this.data.model, ...(untrusted.length ? { untrusted } : {}) };
        const usage = {};
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
                summary = await this.summarize(summary, chunk, budget, signal, `${idBase}-summary-${round++}`, usage);
                if (epoch !== this.epoch) throw new Error('Conversation changed.');
            }
            if (manual && estimateTokens(summary) >= replaced) {
                // The summary request is still paid for.
                this.settleCost({ model: this.data.model, ...(usage.usage ? { usage: usage.usage } : {}) });
                return 'Nothing condensed: the summary came out no shorter than the messages it would replace.';
            }
            const note = { id: randomUUID(), ...base, content: summary.slice(0, 40000), ...(usage.usage ? { usage: usage.usage } : {}) };
            this.settleCost(note); insert(note);
            return true;
        } catch (error) {
            if (signal.aborted || epoch !== this.epoch) throw error;
            insert({ id: randomUUID(), ...base, content: '', failed: true, error: `Summarising failed: ${error.message}`.slice(0, 500) });
            return true;
        }
    }
    async summarize(previous, chunk, budget, signal, id, usage = {}) {
        const messages = [
            ...(previous ? [{ id: randomUUID(), role: 'user', kind: 'summary', content: previous }] : []),
            ...chunk.map(({ id: messageId, role, content, kind }) => ({ id: messageId, role, kind, content: content.length > budget * 4 ? middle(content, budget * 4) : content })),
            { id: randomUUID(), role: 'user', content: summaryInstruction },
        ];
        let text = '';
        await this.provider.run({ id, model: this.data.model, mode: 'discuss', permission: this.adapter.permission?.() || 'ask', environment: '', messages, context: '' },
            { definitions: [], execute: async () => { throw new Error('No tools while summarising.'); } }, signal, event => { if (event.delta) text += event.delta; if (event.usage) this.addUsage(usage, event.usage); });
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
                const result = await this.condense(this.data.messages.slice(), 0, false, controller.signal, epoch, randomUUID(), true);
                this.error = result === true ? '' : result || 'Nothing to condense yet.';
            } catch (error) { if (!controller.signal.aborted) this.error = error.message; }
            finally { if (this.turn === turn) this.turn = undefined; await this.save(); this.changed(); }
        })();
        return turn.done;
    }
}
const hostOf = url => { try { return new URL(url).hostname || url; } catch { return String(url).slice(0, 80); } };
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
module.exports = { ContextMethods, sendable, historyTokens, parseMentions };
