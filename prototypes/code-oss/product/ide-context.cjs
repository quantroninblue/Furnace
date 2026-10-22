'use strict';
const vscode = require('vscode');
const path = require('node:path');
// Project paths are shown with "/" on every platform.
const slash = file => file.split(path.sep).join('/');
const { execFile } = require('node:child_process');

// Context the user can share from the IDE: Git working-tree changes, the Problems panel,
// the editor selection, and project paths for @ mentions.
const git = (root, args) =>
    new Promise((resolve, reject) =>
        execFile(
            'git',
            ['-c', 'core.quotepath=off', '--no-pager', ...args],
            {
                cwd: root,
                timeout: 10000,
                maxBuffer: 16 * 1024 * 1024,
                env: { ...process.env, GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
            },
            (error, stdout) => (error ? reject(error) : resolve(stdout)),
        ),
    );

async function gitChanges(root) {
    if (!root) return 'No project folder is open, so there are no Git changes to share.';
    try {
        await git(root, ['rev-parse', '--is-inside-work-tree']);
    } catch {
        return 'This project is not a Git repository, so there is no diff to share.';
    }
    const status = await git(root, ['status', '--porcelain=v1', '--untracked-files=all']).catch(() => '');
    const head = await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD']).then(
        () => true,
        () => false,
    );
    const diff = head
        ? await git(root, ['diff', 'HEAD', '--no-color', '--no-ext-diff'])
        : `${await git(root, ['diff', '--cached', '--no-color', '--no-ext-diff'])}${await git(root, ['diff', '--no-color', '--no-ext-diff'])}`;
    if (!status.trim()) return 'Git changes: the working tree is clean (no changes since the last commit).';
    const limit = 60000;
    return `Git changes in the working tree (git status, then the diff against ${head ? 'HEAD' : 'the index; no commits yet'}). Untracked files are listed but not shown:\n${status.trim().split('\n').slice(0, 300).join('\n')}\n\n${diff.length > limit ? `${diff.slice(0, limit)}\n… [diff truncated: ${diff.length - limit} more characters]` : diff}`;
}

const severities = ['error', 'warning'];
function problemsText(root) {
    const lines = [];
    let errors = 0,
        warnings = 0;
    for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
        if (uri.scheme !== 'file' && uri.scheme !== 'untitled') continue;
        const file =
            root && uri.fsPath.startsWith(root + path.sep)
                ? slash(path.relative(root, uri.fsPath))
                : vscode.workspace.asRelativePath(uri, false);
        for (const item of diagnostics) {
            if (item.severity > vscode.DiagnosticSeverity.Warning) continue;
            if (item.severity === vscode.DiagnosticSeverity.Error) errors++;
            else warnings++;
            if (lines.length < 300)
                lines.push(
                    `${file}:${item.range.start.line + 1}:${item.range.start.character + 1} ${severities[item.severity]} ${item.message.replace(/\s+/g, ' ').slice(0, 400)}${item.source ? ` [${item.source}${item.code !== undefined ? ` ${typeof item.code === 'object' ? item.code.value : item.code}` : ''}]` : ''}`,
                );
        }
    }
    const count = errors + warnings;
    return {
        count,
        errors,
        text: count
            ? `Problems panel (${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}${count > lines.length ? `; first ${lines.length} shown` : ''}):\n${lines.join('\n')}`
            : 'Problems panel: no errors or warnings.',
    };
}

function selectionText(editor, documents) {
    if (!editor || !documents.isSource(editor.document)) return 'No text is selected in an editor.';
    const document = editor.document,
        file = vscode.workspace.asRelativePath(document.uri, false),
        parts = [];
    let size = 0;
    for (const selection of editor.selections.filter(item => !item.isEmpty).slice(0, 10)) {
        const value = document.getText(selection).slice(0, 24000 - size);
        size += value.length;
        parts.push(
            `Selected text in ${file} (lines ${selection.start.line + 1}–${selection.end.line + 1}${document.isDirty ? ', unsaved' : ''}):\n${value}`,
        );
        if (size >= 24000) break;
    }
    return parts.length ? parts.join('\n\n') : 'No text is selected in an editor.';
}

// Project paths for the @ palette: files and their folders, best matches first.
let cache;
async function searchPaths(root, query) {
    if (!root || !vscode.workspace.isTrusted) return [];
    if (!cache || cache.root !== root || Date.now() - cache.time > 15000) {
        const uris = await vscode.workspace.findFiles(
            new vscode.RelativePattern(root, '**/*'),
            '{**/node_modules/**,**/.git/**}',
            20000,
        );
        const files = uris.map(uri => path.relative(root, uri.fsPath).split(path.sep).join('/'));
        const folders = new Set();
        for (const file of files)
            for (let at = file.lastIndexOf('/'); at > 0; at = file.lastIndexOf('/', at - 1))
                folders.add(file.slice(0, at));
        cache = {
            root,
            time: Date.now(),
            entries: [
                ...[...folders].map(item => ({ path: item, kind: 'folder' })),
                ...files.map(item => ({ path: item, kind: 'file' })),
            ],
        };
    }
    const needle = query.toLowerCase().replace(/^"/, '');
    const score = entry => {
        const value = entry.path.toLowerCase(),
            base = value.slice(value.lastIndexOf('/') + 1);
        if (!needle) return entry.path.split('/').length + (entry.kind === 'folder' ? 0 : 0.5);
        if (base.startsWith(needle)) return 1;
        if (value.startsWith(needle)) return 2;
        if (base.includes(needle)) return 3;
        if (value.includes(needle)) return 4;
        let at = 0;
        for (const char of needle) {
            at = value.indexOf(char, at) + 1;
            if (!at) return Infinity;
        }
        return 6;
    };
    return cache.entries
        .map(entry => ({ entry, score: score(entry) }))
        .filter(item => item.score < Infinity)
        .sort((a, b) => a.score - b.score || a.entry.path.length - b.entry.path.length)
        .slice(0, 30)
        .map(item => item.entry);
}

module.exports = { gitChanges, problemsText, selectionText, searchPaths };
