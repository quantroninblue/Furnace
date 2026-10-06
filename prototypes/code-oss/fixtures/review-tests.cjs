// Runs in the real extension host via --extensionTestsPath. This driver has no
// product implementation or replacement editor; it uses installed product commands.
const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

exports.run = async () => {
    const directory = process.env.AI_GUI_REVIEW_TEST;
    if (!directory) throw new Error('Missing isolated test directory');
    const checks = [];
    const report = async (stage, extra = {}) => {
        const target = path.join(directory, 'review-report.json');
        await fs.writeFile(`${target}.tmp`, JSON.stringify({ stage, checks, ...extra }, null, 2));
        await fs.rename(`${target}.tmp`, target);
    };
    const waitFor = async condition => {
        const end = Date.now() + 60000;
        while (!await condition()) {
            if (Date.now() > end) throw new Error('Timed out waiting for review GUI');
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    };
    try {
        const api = await vscode.extensions.getExtension('ai-gui.workspace-product').activate();
        const uri = vscode.Uri.file(path.join(directory, 'workspace', 'sample.txt'));
        const document = await vscode.workspace.openTextDocument(uri);
        const setText = async (doc, text) => {
            const editor = await vscode.window.showTextDocument(doc, { preview: false });
            assert.equal(await editor.edit(edit => edit.replace(new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), text)), true);
        };
        const propose = async () => {
            await vscode.window.showTextDocument(document);
            return vscode.commands.executeCommand('aiGui.proposeFixture');
        };
        const apply = () => vscode.commands.executeCommand('aiGui.applyReview');
        const disk = () => fs.readFile(uri.fsPath, 'utf8');
        await setText(document, 'Unsaved user draft.\n');
        // Leave the source editor for the product home: the adapter must retain
        // the last actual file, not try to read the webview or the disk copy.
        await vscode.commands.executeCommand('aiGui.home');
        const proposal = await vscode.commands.executeCommand('aiGui.proposeFixture');
        assert.equal(proposal.text, 'Unsaved user draft.\n');
        assert.equal(await disk(), 'Original disk text.\n');
        const review = api.reviews.review;
        const base = await vscode.workspace.openTextDocument(review.base);
        assert.equal(base.getText(), proposal.text);
        await assert.rejects(vscode.workspace.fs.writeFile(review.base, Buffer.from('tamper')), /read-only|permissions/i);
        checks.push('unsaved buffer read through adapter', 'immutable captured base', 'proposal leaves disk unchanged');
        await report('review-ready');
        await waitFor(() => document.getText() === 'Human reviewed replacement.\n');
        assert.equal(document.isDirty, true);
        assert.equal(await disk(), 'Original disk text.\n');
        await assert.rejects(apply(), /No pending proposal/);
        await vscode.window.showTextDocument(document);
        await vscode.commands.executeCommand('undo');
        assert.equal(document.getText(), 'Unsaved user draft.\n');
        checks.push('GUI editable diff and apply', 'apply does not save', 'approval consumed', 'IDE undo preserves prior unsaved text');

        await propose();
        await setText(document, 'Concurrent user edit.\n');
        await assert.rejects(apply(), /Document changed/);
        assert.equal(document.getText(), 'Concurrent user edit.\n');
        checks.push('concurrent edit rejected');

        const editRevert = await propose();
        await setText(document, 'Temporary edit.\n');
        await vscode.commands.executeCommand('undo');
        assert.equal(document.getText(), editRevert.text);
        assert.ok(document.version > editRevert.version);
        await assert.rejects(apply(), /Document changed/);
        checks.push('edit then undo still invalidates version');

        await propose();
        await vscode.commands.executeCommand('aiGui.discardReview');
        await assert.rejects(apply(), /No pending proposal/);
        assert.equal(await disk(), 'Original disk text.\n');
        checks.push('discard leaves source and disk unchanged');

        await propose();
        await apply();
        await setText(document, `${document.getText()}Later typing.\n`);
        await vscode.commands.executeCommand('undo');
        assert.equal(document.getText(), 'Concurrent user edit.\nExample reviewed edit.\n');
        await vscode.commands.executeCommand('undo');
        assert.equal(document.getText(), 'Concurrent user edit.\n');
        checks.push('separate undo stops before and after application');

        // Save only as an explicit user-style operation, then close/reopen.
        await document.save();
        await propose();
        const sourceTabs = vscode.window.tabGroups.all.flatMap(group => group.tabs)
            .filter(tab => tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === uri.toString());
        assert.ok(sourceTabs.length > 0);
        await vscode.window.tabGroups.close(sourceTabs);
        await waitFor(() => !api.reviews.state().pending);
        const reopened = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(reopened);
        await assert.rejects(apply(), /No pending proposal|Document changed|Review expired/);
        checks.push('close and reopen invalidates approval');

        await vscode.commands.executeCommand('aiGui.proposeFixture');
        assert.equal(vscode.workspace.updateWorkspaceFolders(1, 1), true);
        await waitFor(() => !api.reviews.state().pending);
        await assert.rejects(apply(), /No pending proposal/);
        assert.equal(reopened.getText(), 'Concurrent user edit.\n');
        checks.push('workspace-folder change expires approval');

        const untitled = await vscode.workspace.openTextDocument({ content: 'Untitled draft.\n', language: 'plaintext' });
        await vscode.window.showTextDocument(untitled, { preview: true });
        assert.equal((await vscode.commands.executeCommand('aiGui.proposeFixture')).text, 'Untitled draft.\n');
        await apply();
        assert.equal(untitled.getText(), 'Untitled draft.\nExample reviewed edit.\n');
        await vscode.commands.executeCommand('undo');
        assert.equal(untitled.getText(), 'Untitled draft.\n');
        checks.push('untitled buffer proposal, apply and undo');

        await vscode.window.showTextDocument(reopened);
        await vscode.commands.executeCommand('aiGui.proposeFixture');
        await report('complete');
        // Keep the pending proposal for a real process-restart expiry check.
        await waitFor(async () => !!await fs.stat(path.join(directory, 'finish')).catch(() => false));
    } catch (error) {
        await report('failed', { error: error.stack });
        throw error;
    }
};
