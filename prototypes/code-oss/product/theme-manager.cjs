'use strict';
// Furnace themes in the IDE: storage, the Themes menu commands, per-project and day/night choice,
// import/export, the Create a Custom Theme page and applying a theme to this window (through the
// commands in patches/themes-menu.patch) and to Furnace's own panels. The theme format and colour
// rules live in theme-model.cjs.
const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const model = require('./theme-model.cjs');

const PICTURE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };
const MAX_PICTURE = 10 * 1024 * 1024;
const MAX_IMPORT = 16 * 1024 * 1024;

/** The picture type from its first bytes (never trusting the file name). */
function pictureType(bytes) {
    const head = bytes.subarray(0, 12);
    if (head[0] === 0x89 && head.toString('latin1', 1, 4) === 'PNG') return 'png';
    if (head[0] === 0xff && head[1] === 0xd8) return 'jpg';
    if (head.toString('latin1', 0, 4) === 'GIF8') return 'gif';
    if (head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP') return 'webp';
    if (/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/.test(bytes.subarray(0, 2048).toString('utf8'))) return 'svg';
    return null;
}
/** JSON with comments and trailing commas, as colour theme files use. */
function parseJsonc(text) {
    let out = '', i = 0, string = false;
    while (i < text.length) {
        const c = text[i];
        if (string) { out += c; if (c === '\\') { out += text[i + 1] ?? ''; i += 2; continue; } if (c === '"') string = false; i++; continue; }
        if (c === '"') { string = true; out += c; i++; continue; }
        if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; continue; }
        if (c === '/' && text[i + 1] === '*') { i = text.indexOf('*/', i + 2); i = i < 0 ? text.length : i + 2; continue; }
        out += c; i++;
    }
    return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

function createThemes({ context, views, root, status, log, attach }) {
    const directory = path.join(context.globalStorageUri.fsPath, 'themes');
    const pictures = path.join(directory, 'pictures');
    const storeFile = path.join(directory, 'themes.json');
    const media = path.join(context.extensionPath, 'media');
    const config = () => vscode.workspace.getConfiguration('aiGui.theme');
    let saved = [];
    let systemDark = true, patched = true, applied = null, editor = null;
    const installedCache = new Map();
    let fontList = null;

    // ---------- storage ----------
    const pictureOk = picture => picture.source === 'bundled' || /^[a-f0-9]{40}\.(png|jpg|gif|webp|svg)$/.test(picture.name);
    async function load() {
        try {
            const data = JSON.parse(await fs.readFile(storeFile, 'utf8'));
            saved = (Array.isArray(data.saved) ? data.saved : []).slice(0, 100).map(item => model.sanitize(item, { pictureOk })).filter(item => /^(user-|surprise)/.test(item.id));
        } catch { saved = []; }
    }
    async function store() {
        await fs.mkdir(directory, { recursive: true });
        const temp = `${storeFile}.${process.pid}.tmp`;
        await fs.writeFile(temp, JSON.stringify({ version: 1, saved }, null, 1));
        await fs.rename(temp, storeFile);
    }
    const all = () => [...model.PRESETS, ...saved];
    const find = id => all().find(item => item.id === id);
    const projects = () => ({ ...context.globalState.get('themeProjects') });
    /** The theme this window shows: the project's own, else the night theme when the system is dark, else the chosen one. */
    function activeId() {
        const project = root() && projects()[root()];
        if (project && find(project)) return project;
        const night = config().get('night');
        if (night && systemDark && find(night)) return night;
        const current = config().get('current');
        return find(current) ? current : 'charcoal';
    }
    const pictureFile = picture => !picture ? null : picture.source === 'bundled' ? path.join(media, 'backgrounds', `${picture.name}.svg`) : path.join(pictures, picture.name);

    // ---------- installed colour themes (for the code colour part) ----------
    function installedThemes() {
        const list = [];
        for (const extension of vscode.extensions.all) {
            if (extension.id === context.extension.id) continue;
            for (const item of extension.packageJSON?.contributes?.themes || []) {
                if (typeof item?.path !== 'string' || typeof (item.id || item.label) !== 'string') continue;
                const label = String(item.label || item.id);
                if (label.startsWith('%')) continue; // Untranslated labels of built-in themes.
                list.push({ id: `installed:${item.id || label}`, name: label, file: path.join(extension.extensionPath, item.path), light: item.uiTheme === 'vs' || item.uiTheme === 'hc-light' });
            }
        }
        return list;
    }
    async function installedTokens(id) {
        if (installedCache.has(id)) return installedCache.get(id);
        const entry = installedThemes().find(item => item.id === id);
        let result = null;
        if (entry) {
            const rules = [], colors = {};
            const read = async (file, depth) => {
                if (depth > 4 || !file.endsWith('.json')) return;
                const data = parseJsonc(await fs.readFile(file, 'utf8'));
                if (typeof data.include === 'string') await read(path.join(path.dirname(file), data.include), depth + 1);
                if (Array.isArray(data.tokenColors)) rules.push(...data.tokenColors.filter(rule => rule && typeof rule === 'object' && rule.settings));
                Object.assign(colors, data.colors || {});
            };
            try {
                await read(entry.file, 0);
                const hex = value => typeof value === 'string' && /^#[0-9a-f]{6}/i.test(value) ? value.slice(0, 7).toLowerCase() : null;
                result = { rules: rules.slice(0, 2000), foreground: hex(colors['editor.foreground']) || hex(rules.find(rule => !rule.scope)?.settings?.foreground) || (entry.light ? '#24292f' : '#d4d4d4'), background: hex(colors['editor.background']) };
            } catch (error) { log('warn', `Theme: could not read ${entry.name}: ${error.message}`); }
        }
        installedCache.set(id, result);
        return result;
    }

    // ---------- fonts ----------
    const bundledFont = family => Object.entries(model.FONTS).find(([, name]) => name === family)?.[0];
    async function fonts() {
        if (fontList) return fontList;
        fontList = await new Promise(resolve => {
            if (process.platform !== 'linux') { resolve([]); return; }
            execFile('fc-list', [':', 'family'], { timeout: 4000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => resolve(error ? [] : [...new Set(stdout.split('\n').map(line => line.split(',')[0].trim()).filter(name => /^[\w .'-]{1,60}$/.test(name)))].sort((a, b) => a.localeCompare(b)).slice(0, 400)));
        });
        return fontList;
    }

    // ---------- applying ----------
    async function windowSpec(theme) {
        const installed = theme.code?.startsWith?.('installed:') ? await installedTokens(theme.code) : null;
        const resolved = model.resolve(theme, { installed, pictureFile });
        let font = null;
        if (resolved.font) {
            const bundled = bundledFont(resolved.font);
            font = { family: resolved.font, ...(bundled ? { data: (await fs.readFile(path.join(media, 'fonts', `${bundled}.woff2`))).toString('base64') } : {}) };
        }
        return { ...resolved, font, codeFg: installed?.foreground || null };
    }
    /** Furnace's panels: colour tokens, the font and whether a backdrop shows through. */
    function panelMessage(theme) {
        const tokens = theme ? model.panelTokens(theme) : null;
        if (tokens?.font) { const bundled = bundledFont(tokens.font.slice(1, -1)); if (bundled) tokens.font = `"Furnace ${model.FONTS[bundled]}"`; }
        return { type: 'theme', tokens, backdrop: !!theme && !!tokens && model.hasBackdrop(model.sanitize(theme)), glow: config().get('agentGlow', false) };
    }
    const sendPanels = theme => { const message = panelMessage(theme); for (const [webview] of views) void webview.postMessage(message); };
    let applying = Promise.resolve();
    /** Shows a theme in this window (the active one unless a draft from the theme page is given). */
    function apply(draft = null) {
        applying = applying.then(async () => {
            const theme = draft || find(activeId());
            const spec = await windowSpec(theme);
            applied = theme;
            sendPanels(theme);
            let result = null;
            if (patched) {
                try { result = await vscode.commands.executeCommand('furnace.theme.apply', spec); }
                catch (error) { patched = false; log('warn', `Themes: the window part is missing (${error.message}); only Furnace's panels follow the theme.`); }
            }
            if (!draft) await updateMenu();
            if (editor) postEditor({ opacity: result?.opacity ?? null, codeFg: spec.codeFg });
        }).catch(error => { log('error', `Theme: ${error.message}`); status(`Couldn't apply the theme: ${error.message}`); });
        return applying;
    }
    async function updateMenu() {
        if (!patched) return;
        try {
            await vscode.commands.executeCommand('furnace.themes.setMenu', {
                presets: model.PRESETS.map(({ id, name }) => ({ id, name })), saved: saved.map(({ id, name }) => ({ id, name })),
                current: activeId(), project: !!(root() && projects()[root()]), glow: config().get('agentGlow', false),
            });
        } catch (error) { log('warn', `Themes menu: ${error.message}`); }
    }

    // ---------- choosing ----------
    async function choose(id) {
        if (!find(id)) throw new Error('That theme no longer exists.');
        const project = root() && projects()[root()];
        if (project) await context.globalState.update('themeProjects', { ...projects(), [root()]: id });
        else await config().update('current', id, vscode.ConfigurationTarget.Global);
        await apply();
        status(`Theme: ${find(id).name}${project ? ' (this project)' : ''}.`);
    }
    async function pick() {
        const items = [
            { label: 'Presets', kind: vscode.QuickPickItemKind.Separator }, ...model.PRESETS.map(item => ({ label: item.name, id: item.id })),
            ...(saved.length ? [{ label: 'My Themes', kind: vscode.QuickPickItemKind.Separator }, ...saved.map(item => ({ label: item.name, id: item.id }))] : []),
        ].map(item => item.id === activeId() ? { ...item, description: 'current' } : item);
        const before = activeId();
        const chosen = await vscode.window.showQuickPick(items, { title: 'Choose a Theme', placeHolder: 'Use the arrow keys to preview', onDidSelectItem: item => { if (item.id) void apply(find(item.id)); } });
        if (chosen?.id) await choose(chosen.id); else if (find(before)) await apply();
    }
    async function useForProject() {
        if (!root()) throw new Error('Open a project folder first: per-project themes belong to a folder.');
        const map = projects();
        if (map[root()]) { delete map[root()]; await context.globalState.update('themeProjects', map); await apply(); status('This project now uses your normal theme.'); return; }
        map[root()] = activeId(); await context.globalState.update('themeProjects', map); await updateMenu();
        status(`${path.basename(root())} always opens with ${find(map[root()]).name}. Pick another theme now to change it for this project only.`);
    }
    async function dayNight() {
        const night = config().get('night');
        const items = [{ label: 'Off', description: 'Use one theme all day', id: '' }, { label: 'Night theme', kind: vscode.QuickPickItemKind.Separator },
            ...all().map(item => ({ label: item.name, id: item.id, description: item.id === night ? 'current night theme' : '' }))];
        const chosen = await vscode.window.showQuickPick(items, { title: 'Day and Night', placeHolder: 'When your system switches to dark mode, Furnace shows this theme; in light mode, your normal theme.' });
        if (!chosen) return;
        await config().update('night', chosen.id, vscode.ConfigurationTarget.Global);
        await apply();
        status(chosen.id ? `Night theme: ${chosen.label}. It follows your system's light and dark setting.` : 'Day and night switching is off.');
    }
    async function surprise() {
        const theme = { ...model.surprise(), id: 'surprise', name: 'Surprise' };
        saved = [...saved.filter(item => item.id !== 'surprise'), theme];
        await store(); await choose('surprise');
        status('Surprise theme applied. Themes → Edit Current Theme… to tweak and save it under a name.');
    }

    // ---------- import / export ----------
    async function importTheme() {
        const [uri] = await vscode.window.showOpenDialog({ title: 'Import Theme', filters: { 'Furnace theme': ['furnace-theme'] }, canSelectMany: false }) || [];
        if (!uri) return;
        const stat = await fs.stat(uri.fsPath);
        if (stat.size > MAX_IMPORT) throw new Error('That theme file is too large (16 MB at most).');
        let data;
        try { data = JSON.parse(await fs.readFile(uri.fsPath, 'utf8')); } catch { throw new Error('That file is not a Furnace theme.'); }
        if (data?.furnaceTheme !== 1 || !data.theme) throw new Error('That file is not a Furnace theme.');
        const theme = model.sanitize(data.theme, { pictureOk: picture => picture.source === 'bundled' || !!data.picture });
        if (theme.background.picture?.source === 'user') {
            const bytes = Buffer.from(String(data.picture?.data || ''), 'base64');
            const name = await savePicture(bytes);
            theme.background.picture = { ...theme.background.picture, name };
        }
        theme.id = `user-${crypto.randomBytes(6).toString('hex')}`;
        saved.push(theme); await store(); await choose(theme.id);
        status(`Imported ${theme.name}.`);
    }
    async function exportTheme() {
        const theme = model.sanitize(find(activeId()));
        const uri = await vscode.window.showSaveDialog({ title: 'Export Theme', filters: { 'Furnace theme': ['furnace-theme'] }, defaultUri: vscode.Uri.file(path.join(require('node:os').homedir(), `${theme.name.replace(/[^\w -]/g, '').trim() || 'theme'}.furnace-theme`)) });
        if (!uri) return;
        const data = { furnaceTheme: 1, theme: { ...theme, id: undefined } };
        if (theme.background.picture?.source === 'user') data.picture = { name: theme.background.picture.name, data: (await fs.readFile(pictureFile(theme.background.picture))).toString('base64') };
        await fs.writeFile(uri.fsPath, JSON.stringify(data, null, 1));
        status(`Exported ${theme.name} to ${uri.fsPath}.`);
    }
    async function savePicture(bytes) {
        if (!bytes.length || bytes.length > MAX_PICTURE) throw new Error('Pictures can be up to 10 MB.');
        const type = pictureType(bytes);
        if (!type) throw new Error('Use a PNG, JPEG, GIF, WebP or SVG picture.');
        const name = `${crypto.createHash('sha1').update(bytes).digest('hex')}.${type}`;
        await fs.mkdir(pictures, { recursive: true });
        await fs.writeFile(path.join(pictures, name), bytes);
        return name;
    }

    // ---------- Create a Custom Theme page ----------
    async function openEditor(base) {
        const draft = model.sanitize(base);
        if (editor) { editor.draft = draft; editor.panel.reveal(); postEditor({}); void apply(draft); return; }
        const panel = vscode.window.createWebviewPanel('aiGui.themeEditor', 'Furnace Theme', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
        panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'workspace.svg');
        editor = { panel, draft, saved: false };
        const disposables = [];
        attach(panel.webview, 'themes', disposables, [vscode.Uri.file(directory)]);
        panel.onDidDispose(() => {
            for (const disposable of disposables) disposable.dispose();
            const wasSaved = editor?.saved; editor = null;
            // Give focus back to the window (the native menu bar only updates while it has focus).
            void vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
            if (!wasSaved) void apply(); // Closing without saving puts the active theme back.
        });
        void apply(draft);
    }
    async function postEditor({ opacity, codeFg }) {
        if (!editor) return;
        if (opacity !== undefined) editor.opacity = opacity;
        if (codeFg !== undefined) editor.codeFg = codeFg;
        const webview = editor.panel.webview;
        const uri = file => webview.asWebviewUri(vscode.Uri.file(file)).toString();
        const userPictures = await fs.readdir(pictures).catch(() => []);
        void webview.postMessage({
            type: 'themeEditor', theme: editor.draft, checks: model.checks(editor.draft, editor.codeFg),
            opacity: editor.opacity ?? null, windowPart: patched,
            sources: all().map(({ id, name, preset }) => ({ id, name, preset: !!preset })),
            codes: [...Object.entries(model.CODE).map(([id, item]) => ({ id, name: item.name })), ...installedThemes().map(({ id, name }) => ({ id, name: `${name} (installed)` }))],
            fonts: { bundled: Object.values(model.FONTS), installed: await fonts() },
            pictures: [...Object.entries(model.PICTURES).map(([name, label]) => ({ source: 'bundled', name, label, url: uri(pictureFile({ source: 'bundled', name })) })),
                ...userPictures.filter(name => pictureOk({ source: 'user', name })).map(name => ({ source: 'user', name, label: 'Your picture', url: uri(path.join(pictures, name)) }))],
        });
    }
    let draftTimer;
    const handlers = {
        themeReady: () => postEditor({}),
        themeDraft: message => {
            if (!editor) return;
            editor.draft = model.sanitize(message.theme, { pictureOk });
            clearTimeout(draftTimer);
            draftTimer = setTimeout(() => void apply(editor?.draft), 120);
        },
        themeTake: message => {
            if (!editor) return;
            const source = find(String(message.from));
            if (!source) throw new Error('That theme no longer exists.');
            editor.draft = model.takePart(editor.draft, source, message.part);
            void apply(editor.draft);
        },
        themeFix: message => { if (!editor) return; editor.draft = model.fix(editor.draft, String(message.id), editor.codeFg); void apply(editor.draft); },
        themePicture: async () => {
            if (!editor) return;
            const [uri] = await vscode.window.showOpenDialog({ title: 'Choose a Background Picture', filters: { Pictures: Object.keys(PICTURE_TYPES) }, canSelectMany: false }) || [];
            if (!uri) return;
            const stat = await fs.stat(uri.fsPath);
            if (stat.size > MAX_PICTURE) throw new Error('Pictures can be up to 10 MB.');
            const name = await savePicture(await fs.readFile(uri.fsPath));
            editor.draft = model.sanitize({ ...editor.draft, background: { ...editor.draft.background, kind: 'picture', picture: { source: 'user', name, fit: editor.draft.background.picture?.fit || 'cover' } } }, { pictureOk });
            void apply(editor.draft);
        },
        themeSave: async message => {
            if (!editor) return;
            const theme = model.sanitize(message.theme, { pictureOk });
            const existing = saved.findIndex(item => item.id === theme.id);
            if (message.asNew || existing < 0) { theme.id = `user-${crypto.randomBytes(6).toString('hex')}`; saved.push(theme); } else saved[existing] = theme;
            await store();
            editor.saved = true; editor.draft = theme;
            editor.panel.dispose();
            await choose(theme.id);
        },
        themeDelete: async message => {
            const theme = saved.find(item => item.id === message.id);
            if (!theme) return;
            if (await vscode.window.showWarningMessage(`Delete the theme "${theme.name}"?`, { modal: true }, 'Delete') !== 'Delete') return;
            saved = saved.filter(item => item.id !== theme.id); await store();
            if (config().get('current') === theme.id) await config().update('current', 'charcoal', vscode.ConfigurationTarget.Global);
            if (editor) { editor.saved = true; editor.panel.dispose(); }
            await apply(); status(`Deleted ${theme.name}.`);
        },
        themeCancel: () => editor?.panel.dispose(),
        // /theme, /theme new, /theme <name>
        themeCommand: message => {
            const value = String(message.value || '').trim().toLowerCase();
            if (!value) return pick();
            if (value === 'new' || value === 'create') return vscode.commands.executeCommand('aiGui.theme.create');
            const theme = all().find(item => item.id === value || item.name.toLowerCase() === value) || all().find(item => item.name.toLowerCase().includes(value));
            if (!theme) throw new Error(`No theme called "${message.value}". Type /theme to choose from the list.`);
            return choose(theme.id);
        },
    };
    const command = (name, action) => context.subscriptions.push(vscode.commands.registerCommand(name, async (...args) => {
        try { return await action(...args); } catch (error) { log('error', `${name}: ${error.message}`); status(error.message); void vscode.window.showErrorMessage(error.message); }
    }));
    command('aiGui.theme.create', () => openEditor({ ...model.sanitize(find(activeId())), id: 'new', name: 'My Theme' }));
    command('aiGui.theme.edit', () => { const theme = find(activeId()); return openEditor(theme.preset ? { ...theme, id: 'new', name: `My ${theme.name}` } : theme); });
    command('aiGui.theme.pick', pick);
    command('aiGui.theme.apply', id => choose(String(id)));
    command('aiGui.theme.surprise', surprise);
    command('aiGui.theme.useForProject', useForProject);
    command('aiGui.theme.dayNight', dayNight);
    command('aiGui.theme.toggleGlow', async () => { const on = !config().get('agentGlow', false); await config().update('agentGlow', on, vscode.ConfigurationTarget.Global); status(on ? 'Agent glow on: the chat panel glows while the agent works, amber when it waits for you, red on an error.' : 'Agent glow off.'); });
    command('aiGui.theme.import', importTheme);
    command('aiGui.theme.export', exportTheme);
    command('aiGui.theme.systemChanged', data => { const dark = data?.dark !== false; if (dark !== systemDark) { systemDark = dark; if (!editor) void apply(); } });
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('aiGui.theme.current') || event.affectsConfiguration('aiGui.theme.night')) void load().then(() => { if (!editor) void apply(); });
        else if (event.affectsConfiguration('aiGui.theme.agentGlow')) { if (applied) sendPanels(applied); void updateMenu(); }
    }));
    context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => { if (!editor) void apply(); }));
    context.subscriptions.push({ dispose: () => clearTimeout(draftTimer) });

    return {
        handlers,
        /** Loads saved themes and shows the active one. */
        async start() {
            await load();
            try { systemDark = (await vscode.commands.executeCommand('furnace.theme.system'))?.dark !== false; } catch { patched = false; }
            await apply();
        },
        /** Theme tokens for a panel that just loaded. */
        sendTo: webview => { if (applied) void webview.postMessage(panelMessage(applied)); },
        glow: () => config().get('agentGlow', false),
    };
}

module.exports = { createThemes, pictureType, parseJsonc };
