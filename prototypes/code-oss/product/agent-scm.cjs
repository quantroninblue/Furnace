'use strict';
const vscode = require('vscode');
const path = require('node:path');
// Agent changes are keyed by project paths with "/" on every platform.
const slash = file => file.split(path.sep).join('/');
const fs = require('node:fs/promises');

// The agent's changes in this conversation as a Source Control provider ("AI Agent"),
// next to Git's own working-tree changes in the built-in Source Control view. Each file
// opens a diff from before the agent first changed it to now; inline actions revert the
// agent's changes or stage the file in Git. Changed files also get an "AI" badge in the
// Explorer and editor tabs.
class AgentChanges {
    constructor(context, conversation, ide) {
        this.conversation = conversation; this.ide = ide; this.signature = ''; this.decorated = new Set();
        this.changed$ = new vscode.EventEmitter();
        const root = ide.root();
        this.control = vscode.scm.createSourceControl('aiGui', 'AI Agent', root ? vscode.Uri.file(root) : undefined);
        this.control.inputBox.visible = false;
        this.control.acceptInputCommand = undefined;
        this.group = this.control.createResourceGroup('agent', 'Changed by the agent (this conversation)');
        this.group.hideWhenEmpty = true;
        context.subscriptions.push(this.control, this.changed$,
            vscode.window.registerFileDecorationProvider({ onDidChangeFileDecorations: this.changed$.event,
                provideFileDecoration: uri => this.decorated.has(uri.toString()) ? { badge: 'AI', tooltip: 'Changed by the AI agent in this conversation', propagate: false } : undefined }));
        const command = (name, action) => context.subscriptions.push(vscode.commands.registerCommand(name, async (...args) => {
            try { return await action(...args); } catch (error) { ide.status(error.message); }
        }));
        command('aiGui.scm.open', resource => this.open(this.relative(resource)));
        command('aiGui.scm.revert', async (...resources) => {
            for (const resource of resources.flat().filter(Boolean)) {
                const file = this.relative(resource);
                ide.restored(await ide.confirmConflicts(force => conversation.revertFile(file, force), 'Revert'), `Reverted ${file}`);
            }
        });
        command('aiGui.scm.stage', (...resources) => this.stage(resources.flat().filter(Boolean).map(resource => this.relative(resource))));
        command('aiGui.scm.stageAll', () => this.stage(conversation.agentFiles().map(file => file.path)));
        command('aiGui.scm.reviewAll', async () => { for (const file of conversation.agentFiles().filter(item => item.restorable).slice(0, 10)) await this.open(file.path, false); });
    }
    absolute(file) { return path.isAbsolute(file) ? file : path.join(this.ide.root() || '/', file); }
    relative(resource) {
        if (typeof resource === 'string') return resource;
        const uri = resource?.resourceUri ?? resource;
        if (!(uri instanceof vscode.Uri)) throw new Error('Choose a file in the AI Agent list.');
        const root = this.ide.root();
        return root && uri.fsPath.startsWith(root + path.sep) ? slash(path.relative(root, uri.fsPath)) : uri.fsPath;
    }
    update() {
        const files = this.conversation.agentFiles();
        const signature = JSON.stringify(files.map(file => [file.path, file.status, file.restorable]));
        if (signature === this.signature) return;
        this.signature = signature;
        this.group.resourceStates = files.map(file => ({
            resourceUri: vscode.Uri.file(this.absolute(file.path)),
            contextValue: file.restorable ? 'revertible' : 'fixed',
            command: file.restorable ? { command: 'aiGui.scm.open', title: 'Show the agent\'s changes', arguments: [file.path] } : undefined,
            decorations: { strikeThrough: file.status === 'deleted', tooltip: `${{ added: 'Created', modified: 'Modified', deleted: 'Deleted' }[file.status]} by the agent${file.restorable ? ` (+${file.added} −${file.removed})` : '; no copy was kept, so it cannot be reverted here'}` },
        }));
        this.control.count = files.length;
        const next = new Set(files.filter(file => file.status !== 'deleted').map(file => vscode.Uri.file(this.absolute(file.path)).toString()));
        const touched = [...new Set([...this.decorated, ...next])].map(value => vscode.Uri.parse(value));
        this.decorated = next;
        if (touched.length) this.changed$.fire(touched);
    }
    async open(file, preview = true) {
        const original = await this.conversation.agentFileOriginal(file);
        const exists = await fs.stat(original.file).then(() => true, () => false);
        const key = `/scm/${Date.now()}/${path.basename(file)}`;
        await vscode.commands.executeCommand('vscode.diff', this.ide.preview(key + '.before', original.before ?? ''), exists ? vscode.Uri.file(original.file) : this.ide.preview(key + '.after', ''),
            `${file} (since the agent's first change)`, { preview });
    }
    async stage(files) {
        if (!files.length) return;
        const api = vscode.extensions.getExtension('vscode.git');
        const git = api && (api.isActive ? api.exports : await api.activate())?.getAPI(1);
        const repository = git?.getRepository(vscode.Uri.file(this.absolute(files[0])));
        if (!repository) throw new Error('This project is not a Git repository. Initialize one from the Source Control view to stage changes.');
        await repository.add(files.map(file => this.absolute(file)));
        this.ide.status(`Staged ${files.length} file${files.length === 1 ? '' : 's'} in Git. Commit from the Source Control view.`);
    }
}
module.exports = { AgentChanges };
