const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ProductSession, ProductReview } = require('./product-core.cjs');

function fixture() {
    const session = new ProductSession();
    const document = { uri: 'file:///example.txt', instance: 'open-1', version: 3, text: 'unsaved text\n' };
    const adapter = {
        captureActive: () => ({ ...document }),
        openReview: async proposal => ({ text: proposal.replacement }),
        readReview: review => review.text,
        releaseReview: () => {},
        apply: async (proposal, text, validate) => {
            validate(document);
            document.text = text;
            document.version++;
            return true;
        },
    };
    return { session, document, adapter, review: new ProductReview(session, adapter) };
}

test('fixture uses unsaved state; applying uses the manually revised proposal once', async () => {
    const { review, document, session } = fixture();
    const proposal = await review.proposeFixture();
    assert.equal(proposal.replacement, 'unsaved text\nExample reviewed edit.\n');
    review.review.text = 'manually revised\n';
    await review.apply();
    assert.equal(document.text, 'manually revised\n');
    assert.equal(session.proposal, undefined);
    await assert.rejects(review.apply(), /No pending proposal/);
});

test('changed text, edit-revert, document replacement and another URI all reject', async () => {
    for (const change of [
        { text: 'concurrent edit' },
        { version: 5 },
        { instance: 'reopened' },
        { uri: 'file:///other.txt' },
    ]) {
        const { review, document } = fixture();
        await review.proposeFixture();
        Object.assign(document, change);
        const before = { ...document };
        await assert.rejects(review.apply(), /Document changed/);
        assert.deepEqual(document, before);
    }
});

test('a discard or scope change during asynchronous opening expires the proposal', async () => {
    const { review, adapter, session } = fixture();
    let resolve;
    adapter.openReview = () =>
        new Promise(done => {
            resolve = done;
        });
    const pending = review.proposeFixture();
    review.discard();
    resolve({});
    await assert.rejects(pending, /Review expired/);
    assert.equal(session.proposal, undefined);
});

test('scope change while focusing the editor cannot apply the old approval', async () => {
    const { review, adapter, document } = fixture();
    await review.proposeFixture();
    adapter.apply = async (proposal, text, validate) => {
        review.discard();
        validate(document);
        return true;
    };
    await assert.rejects(review.apply(), /Review expired/);
    assert.equal(document.text, 'unsaved text\n');
});

test('overlapping operations are refused and an IDE-side race is reported', async () => {
    const { review, adapter } = fixture();
    await review.proposeFixture();
    let resolve;
    adapter.apply = () =>
        new Promise(done => {
            resolve = done;
        });
    const pending = review.apply();
    await assert.rejects(review.apply(), /already in progress/);
    await assert.rejects(review.proposeFixture(), /already in progress/);
    resolve(false);
    await assert.rejects(pending, /Document changed while applying/);
});

test('oversized source and manually edited review are rejected before application', async () => {
    const { review, document } = fixture();
    document.text = 'x'.repeat(100001);
    await assert.rejects(review.proposeFixture(), /limit/);
    document.text = 'small';
    await review.proposeFixture();
    review.review.text = 'x'.repeat(100001);
    await assert.rejects(review.apply(), /limit/);
    assert.equal(document.text, 'small');
});

test('discard and session restoration never retain approvals', async () => {
    const { review, session, document } = fixture();
    await review.proposeFixture();
    const restored = new ProductSession(session.snapshot());
    assert.equal(restored.proposal, undefined);
    review.discard();
    await assert.rejects(review.apply(), /No pending proposal/);
    assert.equal(document.text, 'unsaved text\n');
});

test('fixture preserves CRLF and rejected review opening clears the approval', async () => {
    const { review, document, adapter, session } = fixture();
    document.text = 'line\r\n';
    assert.equal((await review.proposeFixture()).replacement, 'line\r\nExample reviewed edit.\r\n');
    adapter.openReview = async () => {
        throw new Error('editor unavailable');
    };
    await assert.rejects(review.proposeFixture(), /editor unavailable/);
    assert.equal(session.proposal, undefined);
});
