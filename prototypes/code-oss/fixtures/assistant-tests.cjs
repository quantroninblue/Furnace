const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
exports.run = async () => {
    const directory = process.env.AI_GUI_ASSISTANT_TEST, checks = [];
    const report = async value => { const file = path.join(directory, 'assistant-report.json'); await fs.writeFile(file + '.tmp', JSON.stringify({ checks, ...value }, null, 2)); await fs.rename(file + '.tmp', file); };
    const until = async condition => { const end = Date.now() + 40000; while (!await condition()) { if (Date.now() > end) throw new Error('Assistant workflow timed out'); await new Promise(resolve => setTimeout(resolve, 50)); } };
    let api;
    try {
        api = await vscode.extensions.getExtension('ai-gui.workspace-product').activate();
        const chat = api.conversation;
        if (process.env.AI_GUI_ASSISTANT_RESTART) {
            const saved = JSON.parse(await fs.readFile(path.join(directory, 'saved-session.json'), 'utf8'));
            assert.equal(chat.data.messages.length, 0);
            assert((await chat.list()).some(item => item.id === saved.id));
            await chat.switch(saved.id);
            assert(chat.data.messages.some(item => item.content.includes('Agent work complete')));
            assert.equal(api.session.state.brief, 'Migrated planning brief.');
            assert.equal(chat.attachments[0].shared, false);
            assert.equal(chat.proposals.size, 0);
            for (const m of chat.data.messages) for (const p of m.proposals || []) assert.notEqual(p.status, 'pending');
            checks.push('actual IDE restart restores conversation, plan and attachments; sharing and pending approvals expire');
            await report({ stage: 'complete' }); await new Promise(() => {}); return;
        }
        // Exercise the unmodified production credential service before substituting
        // the fixture's network implementation; no credentials or inference needed.
        await api.connectionsReady;
        const production = await chat.provider.status();
        assert(production.connections.some(item => item.provider === 'claude-code')); assert(!JSON.stringify(production).includes('access_token'));
        const productionPid = chat.provider.child.pid;
        await chat.provider.dispose(); assert.throws(() => process.kill(productionPid, 0));
        chat.provider.options.entry = path.join(directory, 'assistant-entry.cjs');
        checks.push('real production credential service discovers connections on startup, exposes status without tokens, and exits cleanly');
        const file = vscode.Uri.file(path.join(directory, 'workspace/sample.txt'));
        const doc = await vscode.workspace.openTextDocument(file); const editor = await vscode.window.showTextDocument(doc, { preview: false });
        await editor.edit(edit => edit.insert(new vscode.Position(0, 0), 'Unsaved user draft.\n'));
        const original = doc.getText();
        await api.showHome();
        await report({ stage: 'connections-ready' });
        await until(() => chat.data.model === 'openai/gpt-fixture');
        assert(!JSON.stringify(chat.snapshot()).includes('test-only-key'));
        await vscode.workspace.getConfiguration('aiGui.agent').update('permissions', 'ask', vscode.ConfigurationTarget.Global);
        api.session.update('mode', 'Build'); api.status('Build fixture ready.');
        await report({ stage: 'send-ready' });
        const waitingStep = () => chat.data.messages.at(-1)?.steps?.find(step => step.status === 'waiting');
        await until(() => waitingStep()?.tool === 'edit_file');
        assert(waitingStep().diff.includes('+Agent edited draft.')); assert.equal(doc.getText(), original);
        assert.equal(chat.data.messages.at(-1).steps[0].tool, 'read_file');
        await report({ stage: 'edit-approval' });
        await until(() => waitingStep()?.tool === 'write_file');
        assert.equal(doc.getText(), original.replace('Unsaved user draft.', 'Agent edited draft.'));
        assert.equal(await fs.readFile(file.fsPath, 'utf8'), 'Disk original.\n');
        await report({ stage: 'create-approval' });
        await until(() => waitingStep()?.tool === 'run_command');
        assert(chat.grants.has('edit'));
        assert.equal(await fs.readFile(path.join(directory, 'workspace/notes/created.txt'), 'utf8'), 'Created by agent.\n');
        await report({ stage: 'command-approval' });
        await until(() => !chat.turn);
        const work = chat.data.messages.at(-1);
        assert.equal(work.state, 'complete'); assert(work.content.includes('fixture test output')); assert(work.content.includes('Created by agent.'));
        assert.deepEqual(work.steps.map(step => step.status), ['done', 'done', 'done', 'done']);
        await vscode.window.showTextDocument(doc); await vscode.commands.executeCommand('undo'); assert.equal(doc.getText(), original);
        checks.push('GUI send → SDK stream → agent reads the unsaved buffer → approved edit_file lands in the buffer (disk untouched; Undo restores) → write_file creates a folder+file under "Always allow edits" → approved run_command output returns to the model');
        // The reply's checkpoint lists both files; the user's Undo makes sample.txt a conflict.
        assert.deepEqual(work.changes.files.map(file => `${file.status} ${file.path} +${file.added} −${file.removed}`), ['modified sample.txt +1 −1', 'added notes/created.txt +1 −0']);
        await assert.rejects(chat.revert(work.id, ['sample.txt']), error => error.conflicts?.[0] === 'sample.txt');
        checks.push('turn checkpoint through the IDE host lists the edited and created files; a file the user changed since (Undo) is refused as a conflict');
        api.session.update('mode', 'Plan'); await chat.send('plan');
        const plan = [...chat.proposals.values()].find(p => p.kind === 'plan'); assert(plan); await chat.approve(plan.id);
        api.session.update('mode', 'Discuss'); chat.sharePlan = true; chat.shareEditor = true;
        await chat.send('context'); assert(chat.data.messages.at(-1).content.includes(original)); assert(chat.data.messages.at(-1).content.includes('Migrated planning brief.'));
        await chat.send('forbidden'); assert(/not (permitted|available)/.test(chat.data.messages.at(-1).content));
        checks.push('plan proposal approval; explicitly shared brief/unsaved text; Discuss rejects project tools');
        const attachment = path.join(directory, 'attachment.md'); await fs.writeFile(attachment, 'Attachment original'); await chat.attach([attachment]);
        assert.equal(chat.attachments[0].shared, false); chat.attachments[0].shared = true;
        await chat.send('attachment'); assert(chat.data.messages.at(-1).content.includes('Attachment original')); assert.equal(await fs.readFile(attachment, 'utf8'), 'Attachment original');
        const waiting = chat.send('wait'); await until(() => chat.turn); await new Promise(resolve => setTimeout(resolve, 200)); await chat.stop(); await waiting;
        assert.equal(chat.data.messages.at(-1).state, 'stopped');
        await chat.send('fail'); assert.equal(chat.data.messages.at(-1).state, 'failed'); assert(!JSON.stringify(chat.snapshot()).includes('PRIVATE_FIXTURE_SECRET'));
        await chat.send('recovered'); assert.equal(chat.data.messages.at(-1).state, 'complete');
        checks.push('attachment copied and explicitly shared; stream cancellation; sanitized provider error and subsequent recovery');
        // Session switch while a turn runs.
        await chat.save(); const savedId = chat.data.id;
        await fs.writeFile(path.join(directory, 'saved-session.json'), JSON.stringify({ id: savedId }));
        api.session.update('mode', 'Discuss'); const pending = chat.send('wait'); await new Promise(resolve => setTimeout(resolve, 100)); await chat.switch(); await pending;
        assert.equal(chat.data.messages.length, 0); assert.equal(chat.proposals.size, 0); assert.equal(api.research.sources.context().length, 0);
        await chat.switch(savedId); assert.equal(chat.attachments[0].shared, false); assert.equal(chat.proposals.size, 0);
        checks.push('changing conversation stops the stream and clears approvals, grants and shared context');
        await api.showHome(); api.status('Migration workflow complete.');
        await report({ stage: 'complete', servicePid: chat.provider.child.pid });
    } catch (error) { await report({ stage: 'failed', error: error.stack }); await api?.conversation.stop(); }
    await new Promise(() => {});
};
