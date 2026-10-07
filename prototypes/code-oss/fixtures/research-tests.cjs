// Executes inside the real Code OSS extension host, using its pinned executable.
const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { ResearchTransport } = require('../product/research-transport.cjs');
exports.run = async () => {
    const directory = process.env.AI_GUI_RESEARCH_TEST;
    const checks = [], children = [];
    const server = http.createServer((_req, res) => res.end('<!doctype html><title>Local research fixture</title><p>Reference passage</p>'));
    const report = async value => {
        const target = path.join(directory, 'research-report.json');
        await fs.writeFile(`${target}.tmp`, JSON.stringify({ checks, ...value }, null, 2)); await fs.rename(`${target}.tmp`, target);
    };
    const launch = (mode = '', timeout = 10000) => {
        const client = new ResearchTransport({ executable: process.execPath, entry: path.join(__dirname, 'research-host.cjs'),
            scope: 'session-1', env: { ...process.env, AI_GUI_RESEARCH_PROBE_MODE: mode }, timeout });
        children.push(client); return client;
    };
    // Where a stuck companion is: process state, kernel wait channel and thread count.
    const processState = pid => {
        const read = file => { try { return require('node:fs').readFileSync(`/proc/${pid}/${file}`, 'utf8').trim(); } catch { return 'gone'; } };
        return `state=${/State:\s*(.*)/.exec(read('status'))?.[1]} wchan=${read('wchan')} threads=${/Threads:\s*(\d+)/.exec(read('status'))?.[1]}`;
    };
    const gone = async client => {
        await Promise.race([client.exited, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error(`Companion did not exit: ${JSON.stringify(client.lifecycle)} ${processState(client.child.pid)}`)), 10000); timer.unref(); })]);
        await assert.rejects(fs.stat(client.profile), { code: 'ENOENT' });
        assert.throws(() => process.kill(client.child.pid, 0), { code: 'ESRCH' });
    };
    try {
        await vscode.extensions.getExtension('ai-gui.workspace-product').activate();
        const document = await vscode.workspace.openTextDocument({ content: 'Keep this unsaved draft', language: 'plaintext' });
        await vscode.window.showTextDocument(document);
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const url = `http://127.0.0.1:${server.address().port}/`;
        await report({ stage: 'opening' });
        const client = launch();
        await client.ready;
        assert.notEqual(client.child.pid, process.pid);
        const opened = await client.request('open', { url });
        assert.equal(opened.state.title, 'Local research fixture'); assert.equal(opened.state.generation, 1);
        assert.equal(document.getText(), 'Keep this unsaved draft');
        checks.push('real extension host launches pinned Electron through inherited private pipe',
            'separate ephemeral research session and sandboxed renderer load a controlled local page',
            'page has no Node require/process or research bridge; editor buffer preserved');
        await assert.rejects(client.request('navigate', { url: 'file:///etc/passwd' }), /Invalid/);
        await client.request('close'); await gone(client);
        checks.push('close exits host and removes disposable profile');
        await report({ stage: 'disposal' });
        const disposed = launch('timeout'); await disposed.ready;
        const pending = disposed.request('capture', { kind: 'page' });
        const rejection = assert.rejects(pending, /scope closed|host is closed/);
        void disposed.dispose(); await rejection; await gone(disposed);
        checks.push('owner disposal/scope invalidation rejects pending operations and removes host');
        await report({ stage: 'timeout' });
        const timeout = launch('timeout'); await timeout.ready; timeout.timeout = 250;
        await assert.rejects(timeout.request('capture', { kind: 'page' }), /timed out/); await gone(timeout);
        checks.push('request timeout terminates host and rejects pending operations');
        await report({ stage: 'crash' });
        const crashed = launch('crash'); await crashed.ready;
        await assert.rejects(crashed.request('capture', { kind: 'page' }), /closed|exited/); await gone(crashed);
        checks.push('host crash rejects requests and cleans its profile');
        await report({ stage: 'parent-eof' });
        const orphan = launch(); await orphan.ready;
        // EOF models an extension-host exit: no close command or client kill.
        orphan.pipe.end(); await gone(orphan);
        checks.push('parent pipe EOF exits companion without an orphan');
        await report({ stage: 'complete' });
    } catch (error) { await report({ stage: 'failed', error: error.stack }); }
    finally { for (const child of children) await child.dispose(); server.close(); }
    // Keep the extension test host alive until the external driver closes it.
    await new Promise(() => {});
};
