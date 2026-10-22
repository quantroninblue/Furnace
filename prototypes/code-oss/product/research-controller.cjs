'use strict';
const { randomUUID } = require('node:crypto');
const { ResearchTransport } = require('./research-transport.cjs');
const { ResearchSources, capture } = require('../../shared/research-contract.cjs');
const { browserURL } = require('../../shared/research-url.cjs');

// Own one companion per product scope; changing scope cannot revive a launch.
class ResearchController {
    constructor(options, changed = () => {}) {
        this.options = options;
        this.changed = changed;
        this.scope = randomUUID();
        this.message = '';
        this.busy = false;
        this.disposed = false;
        this.children = new Set();
        this.sources = new ResearchSources(this.scope);
    }
    snapshot() {
        const state = this.client && !this.client.closed ? this.client.state : undefined;
        return {
            sources: [...this.sources.sources.values()].map(source => ({
                ...source,
                shared: this.sources.shared.has(source.id),
            })),
            opened: !!state?.opened,
            busy: this.busy,
            loading: !!state?.loading,
            url: state?.url || '',
            title: state?.title || '',
            error: this.message || state?.error || '',
        };
    }
    async open(value) {
        const url = browserURL(value);
        if (this.disposed) throw new Error('Research has shut down.');
        if (this.busy) throw new Error('Research is opening. Try again in a moment.');
        const scope = this.scope;
        this.busy = true;
        this.message = '';
        this.changed();
        let client = this.client;
        try {
            if (!client || client.closed) {
                client = new ResearchTransport({ ...this.options, scope, timeout: 10000 });
                this.client = client;
                this.children.add(client);
                client.exited.then(() => this.children.delete(client));
                client.on('state', () => {
                    if (this.client === client) this.changed();
                });
                client.on('closed', () => {
                    if (this.client === client) {
                        this.message = client.state?.opened
                            ? 'Research browser closed. Open it again to continue.'
                            : '';
                        this.changed();
                    }
                });
            }
            await client.ready;
            if (scope !== this.scope || this.client !== client || this.disposed)
                throw new Error('Research scope changed. Open the browser again.');
            await client.request('open', { url });
        } catch (error) {
            if (scope === this.scope && !this.disposed) this.message = error.message;
            throw error;
        } finally {
            if (scope === this.scope && this.client === client) {
                this.busy = false;
                this.changed();
            }
        }
    }
    async capture(kind) {
        const client = this.client,
            scope = this.scope;
        if (!client || client.closed) throw new Error('Open a research page first.');
        const before = { ...client.state };
        const result = await client.request('capture', { kind });
        if (this.client !== client || this.scope !== scope) throw new Error('Research capture expired');
        this.sources.save(
            result.capture,
            {
                v: 1,
                type: 'request',
                id: result.id,
                action: 'capture',
                kind,
                host: before.host,
                scope: before.scope,
                page: before.page,
                generation: before.generation,
            },
            client.state,
        );
        this.changed();
        return result.capture;
    }
    restore(values = []) {
        this.sources.reset(this.scope);
        for (const value of values.slice(0, 6)) {
            try {
                const { shared, ...source } = value;
                capture(source);
                this.sources.sources.set(source.id, source);
            } catch {
                /* Damaged saved source must not break the conversation. */
            }
        }
        this.changed();
    }
    share(id, enabled) {
        this.sources.share(id, enabled);
        this.changed();
    }
    remove(id) {
        this.sources.remove(id);
        this.changed();
    }
    async close() {
        const client = this.client;
        this.client = undefined;
        this.busy = false;
        this.message = '';
        this.changed();
        if (client) await client.dispose();
    }
    async resetScope() {
        this.scope = randomUUID();
        this.sources.reset(this.scope);
        await this.close();
    }
    async dispose() {
        this.disposed = true;
        await this.close();
        await Promise.all([...this.children].map(client => client.dispose()));
    }
}
module.exports = { ResearchController };
