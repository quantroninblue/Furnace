'use strict';

// Product state and proposals deliberately have no editor, DOM or provider imports.
const modes = Object.freeze(['Discuss', 'Plan', 'Build', 'Research']);
class ProductSession {
    constructor(saved = {}) {
        this.state = {
            mode: modes.includes(saved.mode) ? saved.mode : 'Discuss',
            draft: typeof saved.draft === 'string' ? saved.draft.slice(0, 20000) : '',
            brief: typeof saved.brief === 'string' ? saved.brief.slice(0, 40000) : '',
        };
        this.proposal = undefined;
    }
    snapshot() { return { ...this.state }; }
    update(field, value) {
        if (field === 'mode' && modes.includes(value)) this.state.mode = value;
        else if (['draft', 'brief'].includes(field) && typeof value === 'string') {
            const limit = field === 'brief' ? 40000 : 20000;
            if (value.length > limit) throw new Error(`Maximum ${limit} characters`);
            this.state[field] = value;
        } else throw new Error('Invalid session update');
        return this.snapshot();
    }
    propose(document, replacement) {
        if (!document || typeof document.uri !== 'string' || !Number.isInteger(document.version)
            || typeof document.instance !== 'string'
            || typeof document.text !== 'string' || typeof replacement !== 'string') throw new Error('Invalid proposal');
        if (document.text.length > 100000 || replacement.length > 100000) throw new Error('Document exceeds prototype review limit');
        this.proposal = Object.freeze({ ...document, replacement });
        return this.proposal;
    }
    validate(current) {
        const proposal = this.proposal;
        if (!proposal) throw new Error('No pending proposal');
        if (!current || proposal.uri !== current.uri || proposal.instance !== current.instance
            || proposal.version !== current.version || proposal.text !== current.text) {
            throw new Error('Document changed since this proposal. Generate a new proposal before applying.');
        }
        return proposal;
    }
    discard() { this.proposal = undefined; }
}

// The adapter owns document lifetimes and atomic editor operations. The core
// owns proposal lifetime; approvals never enter the persisted session snapshot.
class ProductReview {
    constructor(session, adapter, changed = () => {}) {
        this.session = session;
        this.adapter = adapter;
        this.changed = changed;
        this.generation = 0;
        this.busy = false;
    }
    state() { return { pending: !!this.review, busy: this.busy, generation: this.generation }; }
    discard() {
        this.generation++;
        if (this.review) this.adapter.releaseReview(this.review);
        this.review = undefined;
        this.session.discard();
        this.changed();
    }
    async proposeFixture() {
        const document = this.adapter.captureActive();
        const newline = document.text.includes('\r\n') ? '\r\n' : '\n';
        const replacement = `${document.text}${document.text.endsWith('\n') || !document.text ? '' : newline}Example reviewed edit.${newline}`;
        return this.propose(document, replacement);
    }
    async propose(document, replacement) {
        if (this.busy) throw new Error('A review operation is already in progress.');
        this.discard();
        const generation = this.generation;
        this.busy = true; this.changed();
        try {
            const proposal = this.session.propose(document, replacement);
            const review = await this.adapter.openReview(proposal);
            if (generation !== this.generation) {
                this.adapter.releaseReview(review);
                throw new Error('Review expired. Generate a new proposal.');
            }
            this.review = review;
            return proposal;
        } catch (error) { this.discard(); throw error; }
        finally { this.busy = false; this.changed(); }
    }
    async apply() {
        if (this.busy) throw new Error('A review operation is already in progress.');
        if (!this.review) throw new Error('No pending proposal.');
        const generation = this.generation;
        const review = this.review;
        const proposal = this.session.proposal;
        this.busy = true; this.changed();
        try {
            const replacement = this.adapter.readReview(review);
            if (replacement.length > 100000) throw new Error('Document exceeds prototype review limit');
            const applied = await this.adapter.apply(proposal, replacement, current => {
                if (generation !== this.generation) throw new Error('Review expired. Generate a new proposal.');
                this.session.validate(current);
            });
            if (!applied) throw new Error('Document changed while applying. Generate a new proposal.');
            this.discard();
        } finally { this.busy = false; this.changed(); }
    }
}
module.exports = { ProductSession, ProductReview, modes };
