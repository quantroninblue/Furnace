'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');
const { ProviderKeys } = require('./main/provider-keys.ts');
const { ChatGPTAuth } = require('./main/chatgpt-auth.ts');
const remote = require('./main/remote-models.ts');
const ollama = require('./main/ollama.ts');
const claude = require('./main/claude-code.ts');
const { validImages } = require('./main/agent-context.ts');
class ProviderService {
    constructor({ directory, cipher, openBrowser, emit = () => {}, dependencies = {} }) {
        this.directory = directory; this.emit = emit;
        this.keys = new ProviderKeys(path.join(directory, 'keys'), cipher);
        this.auth = new ChatGPTAuth(path.join(directory, 'chatgpt'), cipher, openBrowser);
        this.remote = dependencies.remote || remote; this.ollama = dependencies.ollama || ollama; this.claude = dependencies.claude || claude;
        this.catalog = new Map(); this.connections = []; this.error = ''; this.changing = false; this.running = 0;
    }
    async init() { await fs.mkdir(this.directory, { recursive: true, mode: 0o700 }); await this.keys.load(); await this.auth.load(); }
    snapshot() { return { models: [...this.catalog.values()], connections: this.connections, chatgpt: this.auth.status(), secureStorage: this.keys.secureStorage(), busy: this.changing, error: this.error,
        admin: { openai: !!this.keys.get('openai-admin'), anthropic: !!this.keys.get('anthropic-admin') } }; }
    async discover() {
        this.catalog.clear(); this.connections = [];
        const add = (provider, models) => { for (const model of models) this.catalog.set(`${provider}/${model.id}`, { id: `${provider}/${model.id}`, name: `${provider}: ${model.name}` }); };
        for (const provider of ['openai', 'anthropic']) {
            const key = this.keys.get(provider);
            try { if (key) add(provider, await this.remote.remoteModels(provider, key.key)); this.connections.push({ provider, connected: !!key, storage: key?.storage || 'none' }); }
            catch (error) { this.connections.push({ provider, connected: false, error: error.message }); }
        }
        try { add('ollama', (await this.ollama.listModels()).map(id => ({ id, name: id }))); this.connections.push({ provider: 'ollama', connected: true }); }
        catch { this.connections.push({ provider: 'ollama', connected: false, error: 'Start Ollama separately, then refresh. No model is downloaded automatically.' }); }
        const account = this.auth.status().accounts.find(a => a.id === this.auth.status().activeId);
        try { if (account?.signedIn) add('chatgpt', await this.remote.chatgptModels(await this.auth.accessToken())); }
        catch (error) { this.connections.push({ provider: 'chatgpt', connected: false, error: error.message }); }
        this.claudeFile = await this.claude.findClaude();
        const status = await this.claude.claudeStatus(this.claudeFile, this.directory);
        if (status.connected) add('claude-code', status.models);
        this.connections.push({ provider: 'claude-code', ...status });
        return this.snapshot();
    }
    async change(action, value = {}) {
        if (action === 'cancel') { this.auth.cancel(); return this.snapshot(); }
        if (this.running || this.changing) throw new Error('Finish or stop the current operation first.');
        this.changing = true;
        try {
            if (action === 'connect') {
                if (!['openai', 'anthropic'].includes(value.provider)) throw new Error('Unknown API provider.');
                if (typeof value.key !== 'string' || value.key.length > 4096 || value.key.trim().length < 8 || /[\r\n\0]/.test(value.key)) throw new Error('Enter a valid API key.');
                await this.remote.remoteModels(value.provider, value.key.trim());
                await this.keys.set(value.provider, value.key, value.remember === true);
            } else if (action === 'disconnect') {
                if (!['openai', 'anthropic'].includes(value.provider)) throw new Error('Unknown provider.');
                await this.keys.remove(value.provider);
            } else if (action === 'adminConnect') {
                // Admin keys only read organization spend; they are checked by reading it once.
                if (!['openai', 'anthropic'].includes(value.provider)) throw new Error('Unknown API provider.');
                const key = typeof value.key === 'string' ? value.key.trim() : '';
                if (!(value.provider === 'openai' ? /^sk-admin-/ : /^sk-ant-admin/).test(key) || key.length > 4096 || /[\r\n\0]/.test(key)) throw new Error(`Enter an ${value.provider === 'openai' ? 'OpenAI admin key (sk-admin-…)' : 'Anthropic Admin API key (sk-ant-admin…)'}; a normal API key cannot read spend.`);
                await this.remote.organizationSpend(value.provider, key, monthStart());
                await this.keys.set(`${value.provider}-admin`, key, value.remember === true);
            } else if (action === 'adminDisconnect') {
                if (!['openai', 'anthropic'].includes(value.provider)) throw new Error('Unknown provider.');
                await this.keys.remove(`${value.provider}-admin`);
            } else if (action === 'signIn') await this.auth.signIn(value.accountId || null, value.remember === true);
            else if (action === 'selectAccount') await this.auth.select(value.accountId);
            else if (action === 'signOut') this.error = await this.auth.signOut(value.accountId) || '';
            else if (action === 'acknowledge') await this.auth.acknowledge();
            else if (action !== 'discover') throw new Error('Unknown connection operation.');
            return await this.discover();
        } finally { this.changing = false; }
    }
    /** Month-to-date organization spend for providers with an admin key. */
    async spend() {
        const result = {};
        for (const provider of ['openai', 'anthropic']) {
            const key = this.keys.get(`${provider}-admin`);
            if (!key) continue;
            try { result[provider] = { amount: await this.remote.organizationSpend(provider, key.key, monthStart()), since: monthStart().toISOString(), at: Date.now() }; }
            catch (error) { result[provider] = { error: error.message, at: Date.now() }; }
        }
        return result;
    }
    /** Input tokens of a request, counted by the provider (null when it offers no count). */
    async count(request, definitions) {
        if (this.changing || !this.catalog.has(request?.model) || !Array.isArray(request.messages) || typeof request.context !== 'string' || !Array.isArray(definitions)) return null;
        const slash = request.model.indexOf('/'), provider = request.model.slice(0, slash);
        const value = { ...request, model: request.model.slice(slash + 1) };
        if (provider === 'chatgpt') return this.remote.remoteCount('openai', await this.auth.accessToken(), value, definitions);
        if (provider === 'openai' || provider === 'anthropic') { const key = this.keys.get(provider); return key ? this.remote.remoteCount(provider, key.key, value, definitions) : null; }
        return null;
    }
    async run(request, tools, signal) {
        if (this.changing) throw new Error('Finish or stop the current operation first.');
        if (this.running >= 3) throw new Error('Three replies are already running. Wait for one to finish.');
        if (!this.catalog.has(request.model)) throw new Error('Choose an available model in Connections; refresh to reconnect.');
        if (!request || !['discuss', 'plan', 'build', 'research'].includes(request.mode) || !Array.isArray(request.messages)
            || request.messages.some(m => !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string') || typeof request.context !== 'string'
            || (request.permission !== undefined && !['ask', 'auto', 'full'].includes(request.permission)) || (request.environment !== undefined && (typeof request.environment !== 'string' || request.environment.length > 1000)) || (request.images !== undefined && !validImages(request.images))) throw new Error('Invalid assistant request.');
        this.running++;
        const slash = request.model.indexOf('/'); const provider = request.model.slice(0, slash);
        request = { ...request, model: request.model.slice(slash + 1) };
        try {
            if (provider === 'ollama') await this.ollama.chat(request, signal, this.emit, tools);
            else if (provider === 'claude-code') await this.claude.claudeChat(this.claudeFile, path.join(this.directory, 'claude-runtime'), request, signal, this.emit, tools);
            else if (provider === 'chatgpt') await this.remote.remoteChat('openai', await this.auth.accessToken(), request, signal, this.emit, tools, undefined, { chatgpt: true });
            else {
                const key = this.keys.get(provider);
                if (!key) throw new Error('Reconnect this API provider.');
                await this.remote.remoteChat(provider, key.key, request, signal, this.emit, tools);
            }
        } finally { this.running--; }
    }
    dispose() { this.auth.cancel(); }
}
const monthStart = () => { const now = new Date(); return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)); };
module.exports = { ProviderService };
