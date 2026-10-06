const api = acquireVsCodeApi();
const surface = document.body.dataset.surface;
let generation, sessionId, latest, localStatus = '', slashIndex = 0, slashMatches = [];
let view = Object.assign({ input: 'ask', tab: 'chatgpt' }, api.getState() || {});
const el = id => document.getElementById(id);
const send = (type, extra = {}) => api.postMessage({ type, sessionId, ...extra });
const remember = changes => { view = { ...view, ...changes }; api.setState(view); };
function button(text, action, className) { const node = document.createElement('button'); node.textContent = text; node.onclick = action; if (className) node.className = className; return node; }
function text(tag, value, className) { const node = document.createElement(tag); node.textContent = value; if (className) node.className = className; return node; }
function check(label, checked, action, disabled = false) {
    const node = text('label', '', 'check'), input = document.createElement('input'); input.type = 'checkbox'; input.checked = checked; input.disabled = disabled; input.onchange = () => action(input.checked); node.append(input, document.createTextNode(label)); return node;
}
function connection(action, extra = {}) { send('connection', { value: { action, ...extra } }); }
function say(message) { localStatus = message; if (latest) render(latest); }
function setDraft(value) { const draft = el('draft'); draft.value = value; send('draft', { value }); slash(); draft.focus(); }
function setInput(input) { remember({ input }); if (latest) render(latest); el('draft')?.focus(); }
const modeNotes = { Discuss: 'Discuss · uses only the context you share', Plan: 'Plan · reads and searches the project, proposes a brief', Build: 'Build · reads, edits and creates files, runs commands', Research: 'Research · uses shared sources, suggests pages' };

// Slash commands mirror the original app's palette.
const modeCommand = mode => ({ name: mode.toLowerCase(), description: modeNotes[mode].split(' · ')[1].replace(/^./, c => c.toUpperCase()), run: () => { setDraft(''); send('mode', { value: mode }); } });
const slashCommands = [
    { name: 'ask', hint: 'prompt', description: 'Talk to your selected model', run: arg => { setInput('ask'); setDraft(arg); } },
    { name: 'run', hint: 'command', description: 'Run a shell command in this project', run: arg => { if (arg) { send('run', { value: arg }); setDraft(''); } else { setInput('run'); setDraft(''); } } },
    { name: 'new', description: 'Start a fresh conversation', run: () => { setDraft(''); send('newChat'); } },
    { name: 'resume', description: 'Resume a previous conversation', run: () => { setDraft(''); send('resumeChat'); } },
    ...['Discuss', 'Plan', 'Build', 'Research'].map(modeCommand),
    { name: 'connections', description: 'Connect ChatGPT, Claude, API keys or Ollama', run: () => { setDraft(''); send('connections'); } },
    { name: 'permissions', hint: 'ask|auto|full', description: 'Change what the agent may do without asking', run: arg => { setDraft(''); if (['ask', 'auto', 'full'].includes(arg)) send('permission', { value: arg }); else el('permission').focus(); } },
    { name: 'attach', description: 'Import files as context', run: () => { setDraft(''); send('attach'); } },
    { name: 'workspace', description: 'Open the workspace page', run: () => { setDraft(''); send('home'); } },
    { name: 'stop', description: 'Stop the current reply or command', run: () => { setDraft(''); send('stop'); } },
    { name: 'help', description: 'Show these commands', run: () => setDraft('/') },
];
function slash() {
    const palette = el('slash'); if (!palette) return;
    const match = /^\/(\S*)$/.exec(el('draft').value);
    slashMatches = match ? slashCommands.filter(item => item.name.startsWith(match[1].toLowerCase())) : [];
    palette.hidden = !slashMatches.length;
    if (palette.hidden) return;
    slashIndex = Math.min(slashIndex, slashMatches.length - 1);
    el('slash-count').textContent = `${slashMatches.length} command${slashMatches.length === 1 ? '' : 's'}`;
    el('slash-options').replaceChildren(...slashMatches.map((item, index) => {
        const option = document.createElement('button'); option.setAttribute('role', 'option'); option.setAttribute('aria-selected', String(index === slashIndex));
        option.className = index === slashIndex ? 'highlighted' : '';
        const name = text('span', '', 'slash-command-name'); name.append(text('strong', `/${item.name}`)); if (item.hint) name.append(text('small', item.hint));
        const copy = text('span', '', 'slash-command-copy'); copy.append(name, text('span', item.description, 'slash-description'));
        option.append(copy); option.onmousedown = event => { event.preventDefault(); item.run(''); };
        return option;
    }));
    el('slash-options').children[slashIndex]?.scrollIntoView({ block: 'nearest' });
}
function runSlash(value) {
    const [, name, arg = ''] = /^\/(\S+)\s*([\s\S]*)$/.exec(value) || [];
    const item = slashCommands.find(entry => entry.name === name?.toLowerCase());
    if (!item) { say(`Unknown command /${name || ''}. Type / to see commands.`); return true; }
    item.run(arg.trim()); return true;
}
function submit() {
    const value = el('draft').value;
    if (value.trim().startsWith('/')) { runSlash(value.trim()); return; }
    if (!value.trim()) return;
    if (view.input === 'run') { send('run', { value: value.trim() }); setDraft(''); }
    else send('send', { value });
}
function command(name) {
    const actions = {
        send: submit,
        hideConnections: () => { el('connections').hidden = true; el('workspace-pages').hidden = false; },
        refreshConnections: () => connection('discover'),
        connect: () => { const key = el('api-key').value; el('api-key').value = ''; connection('connect', { provider: el('provider').value, key, remember: el('remember').checked }); },
        disconnect: () => connection('disconnect', { provider: el('provider').value }),
        chatgptSignIn: () => connection('signIn', { accountId: el('account').value || null, remember: el('remember').checked }),
        chatgptCancel: () => connection('cancel'), chatgptSelect: () => connection('selectAccount', { accountId: el('account').value }),
        chatgptSignOut: () => connection('signOut', { accountId: el('account').value }), chatgptAcknowledge: () => connection('acknowledge'),
    };
    if (actions[name]) actions[name](); else send(name, { generation });
}
function showTab(tab) {
    remember({ tab });
    for (const node of document.querySelectorAll('[data-tab]')) node.setAttribute('aria-selected', String(node.dataset.tab === tab));
    for (const node of document.querySelectorAll('[data-panel]')) node.hidden = node.dataset.panel !== tab;
}
for (const node of document.querySelectorAll('[data-mode]')) node.onclick = () => send('mode', { value: node.dataset.mode });
for (const node of document.querySelectorAll('[data-command]')) node.onclick = () => command(node.dataset.command);
for (const node of document.querySelectorAll('[data-input]')) node.onclick = () => setInput(node.dataset.input);
for (const node of document.querySelectorAll('[data-tab]')) node.onclick = () => showTab(node.dataset.tab);
for (const node of document.querySelectorAll('[data-suggest]')) node.onclick = () => { if (node.hasAttribute('data-share-editor')) send('context', { field: 'shareEditor', enabled: true }); setDraft(node.dataset.suggest); };
if (el('connections')) showTab(view.tab);
for (const field of ['draft', 'brief']) if (el(field)) el(field).oninput = () => { send(field, { value: el(field).value }); if (field === 'draft') { slashIndex = 0; slash(); } };
if (el('model')) el('model').onchange = () => send('model', { value: el('model').value });
if (el('permission')) el('permission').onchange = () => send('permission', { value: el('permission').value });
if (el('draft')) el('draft').onkeydown = event => {
    if (!el('slash').hidden) {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); slashIndex = (slashIndex + (event.key === 'ArrowDown' ? 1 : -1) + slashMatches.length) % slashMatches.length; slash(); return; }
        if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); slashMatches[slashIndex]?.run(''); return; }
        if (event.key === 'Escape') { event.preventDefault(); el('slash').hidden = true; return; }
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!el('send').disabled || el('draft').value.trim().startsWith('/')) submit(); }
};
if (el('draft')) el('draft').onblur = () => setTimeout(() => { if (el('slash')) el('slash').hidden = true; }, 150);
if (el('research-form')) el('research-form').onsubmit = event => { event.preventDefault(); send('researchOpen', { value: el('research-address').value }); };
function options(select, values, chosen, placeholder) {
    const signature = JSON.stringify(values);
    if (select.dataset.values !== signature) {
        select.replaceChildren(); if (placeholder) { const option = text('option', placeholder); option.value = ''; select.append(option); }
        for (const value of values) { const option = text('option', value.name); option.value = value.id; select.append(option); }
        select.dataset.values = signature;
    }
    select.value = chosen || '';
}
function sources(values) {
    const target = el('sources'); if (!target) return;
    el('source-count').textContent = String(values.length);
    target.replaceChildren(...values.map(source => {
        const card = text('article', '', 'source-card'), title = text('div', '', 'source-title');
        title.append(text('h3', source.title || source.url), check('Share with next reply', source.shared, enabled => send('sourceShare', { id: source.id, enabled })));
        const details = document.createElement('details'); details.append(text('summary', source.kind === 'selection' ? 'Captured selection' : 'Captured page'), text('pre', source.text));
        card.append(title, text('small', source.url), details, button('Remove Source', () => send('sourceRemove', { id: source.id }), 'ghost small'));
        return card;
    }));
    if (!values.length) target.append(text('p', 'No sources yet. Open the browser, then capture a selection or page.', 'empty-note'));
}
function chip(label, on, toggle, { remove, disabled, title } = {}) {
    const node = text('span', '', `context-chip${on ? ' included' : ''}${disabled ? ' disabled' : ''}`);
    const main = button(label, toggle); main.setAttribute('aria-pressed', String(on)); main.disabled = !!disabled; main.title = title || (on ? 'Included with the next message. Click to stop sharing.' : 'Click to include with the next message.');
    node.append(main);
    if (remove) { const close = button('×', remove, 'chip-remove'); close.setAttribute('aria-label', `Remove ${label}`); node.append(close); }
    return node;
}
function chips(chat, research) {
    const target = el('chips'); if (!target) return;
    const list = [chip('Current document', chat.shareEditor, () => send('context', { field: 'shareEditor', enabled: !chat.shareEditor }), { title: 'The active editor, including unsaved changes.' }),
        chip('Planning brief', chat.sharePlan, () => send('context', { field: 'sharePlan', enabled: !chat.sharePlan }))];
    for (const source of research.sources || []) list.push(chip(source.title || source.url, source.shared, () => send('sourceShare', { id: source.id, enabled: !source.shared }), { remove: () => send('sourceRemove', { id: source.id }), title: source.url }));
    for (const item of chat.attachments) list.push(chip(item.readable ? item.name : `${item.name} · file only`, item.shared, () => send('attachmentShare', { id: item.id, enabled: !item.shared }), { remove: () => send('attachmentRemove', { id: item.id }), disabled: !item.readable, title: item.readable ? undefined : 'No extracted text; this file cannot be shared as context.' }));
    target.replaceChildren(...list);
}
const approvalText = { edit: ['Apply this change?', 'Always allow edits in this chat'], command: ['Run this command?', 'Always allow commands in this chat'], network: ['Fetch this page?', 'Always allow web access in this chat'], outside: ['Allow access outside the project?', 'Always allow outside access in this chat'] };
const stepIcons = { running: '◌', waiting: '?', done: '✓', failed: '✕', denied: '⊘' };
function diffBlock(diff) {
    const pre = text('pre', '', 'diff');
    for (const line of diff.split('\n')) pre.append(text('span', line + '\n', /^(\+\+\+|---)/.test(line) ? 'diff-file' : line.startsWith('@@') ? 'diff-hunk' : line.startsWith('+') ? 'diff-add' : line.startsWith('-') ? 'diff-del' : ''));
    return pre;
}
function renderStep(chat, step) {
    const node = text('div', '', `step ${step.status}`);
    const head = text('div', '', 'step-head');
    head.append(text('span', stepIcons[step.status] || '·', 'step-icon'), text('span', step.title, 'step-title'));
    node.append(head);
    if (step.detail) node.append(text('small', step.detail, 'step-detail'));
    if (step.todos) {
        const list = text('ul', '', 'todos');
        for (const todo of step.todos) list.append(text('li', todo.content, `todo ${todo.status}`));
        node.append(list);
    }
    const body = step.diff || step.output;
    if (body) {
        const details = document.createElement('details'); details.open = step.status === 'waiting' || (step.status === 'running' && !!step.output);
        details.append(text('summary', step.diff ? 'Changes' : 'Output'), step.diff ? diffBlock(step.diff) : text('pre', step.output, 'command-output'));
        if (step.diff && step.output) details.append(text('pre', step.output, 'command-output'));
        node.append(details);
    }
    if (step.status === 'waiting') {
        const [question, always] = approvalText[step.approval] || ['Allow this action?', 'Always allow in this chat'];
        const card = text('div', '', 'approval'); card.append(text('strong', question));
        const row = text('div', '', 'row');
        row.append(button('Approve', () => send('approval', { id: step.id, decision: 'approve' }), 'primary'), button(always, () => send('approval', { id: step.id, decision: 'always' }), 'ghost'), button('Deny', () => send('approval', { id: step.id, decision: 'deny' }), 'ghost'));
        if (step.diff) row.append(button('Open Diff', () => send('openDiff', { id: step.id }), 'ghost'));
        card.append(row); node.append(card);
    }
    return node;
}
const modelName = (chat, id) => chat.connections.models?.find(model => model.id === id)?.name || (id ? id.slice(id.indexOf('/') + 1) : 'Assistant');
function renderChat(chat, research) {
    const container = el('messages'), scroller = el('scroller');
    const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 100;
    container.replaceChildren();
    for (const message of chat.messages) {
        if (message.kind === 'workspace') { container.append(text('p', message.content, 'workspace-note')); continue; }
        const command = message.kind === 'command', user = message.role === 'user';
        const article = text('article', '', `message ${message.role}${command ? ' command' : ''}`), byline = text('div', '', 'message-byline');
        byline.append(text('span', user ? (command ? '$' : 'Y') : command ? '>_' : '✦', user ? 'user-avatar' : 'small-avatar'), text('strong', user ? (command ? 'You ran' : 'You') : command ? 'Command output' : modelName(chat, message.model)));
        if (message.state === 'streaming' || message.state === 'running') byline.append(text('span', message.state === 'running' ? 'RUNNING' : 'WRITING'));
        article.append(byline);
        const body = text('div', '', 'message-body');
        if (message.cwd && user) body.append(text('small', message.cwd, 'muted'));
        for (const step of message.steps || []) body.append(renderStep(chat, step));
        if (message.content || !message.state) body.append(text(command ? 'pre' : 'div', message.content, command ? 'command-output' : 'message-text'));
        else if (message.state === 'streaming' && !(message.steps || []).some(step => step.status === 'waiting')) body.append(text('span', '…', 'muted'));
        if (message.activity?.length && !message.steps?.length) body.append(text('p', message.activity.join(' · '), 'tool-activity'));
        const ended = message.state && !message.error && !['streaming', 'running', 'complete'].includes(message.state);
        if (ended || message.exitCode !== undefined) body.append(text('small', [ended ? message.state : '', message.exitCode !== undefined ? `exit ${message.exitCode}` : ''].filter(Boolean).join(' · '), 'command-exit'));
        if (message.error) body.append(text('p', message.error, 'error'));
        for (const proposal of message.proposals || []) {
            const card = text('div', '', 'proposal-card');
            card.append(text('strong', `${{ file: 'File change', plan: 'Plan', command: 'Command', browse: 'Page' }[proposal.kind] || proposal.kind}: ${proposal.path || proposal.reason}`));
            if (proposal.reason && proposal.path) card.append(text('p', proposal.reason));
            const details = document.createElement('details'); details.append(text('summary', 'View proposal'), text('pre', proposal.text)); card.append(details);
            if (proposal.status === 'pending') {
                const row = text('div', '', 'row');
                const approve = button({ file: 'Review Changes', plan: 'Apply Plan', command: 'Run Proposed Command', browse: 'Open Page' }[proposal.kind], () => send('approveProposal', { id: proposal.id }), 'primary');
                approve.disabled = chat.busy || chat.switching; row.append(approve, button('Discard', () => send('discardProposal', { id: proposal.id }), 'ghost')); card.append(row);
            } else card.append(text('small', proposal.status || 'expired'));
            body.append(card);
        }
        article.append(body); container.append(article);
    }
    el('empty-chat').hidden = chat.messages.length > 0;
    const models = chat.connections.models || [];
    el('connect-hint').hidden = models.length > 0;
    el('chat-title').textContent = chat.title || 'New conversation';
    options(el('model'), models, chat.model, models.length ? 'Choose a model' : 'No model connected');
    el('model').disabled = chat.busy;
    const run = view.input === 'run';
    for (const node of document.querySelectorAll('[data-input]')) node.setAttribute('aria-pressed', String(node.dataset.input === view.input));
    el('draft').placeholder = run ? 'Run a command in this project, e.g. npm test' : 'Ask anything, or / for commands…';
    el('send').disabled = chat.busy || chat.switching || chat.connecting || (!run && !models.some(model => model.id === chat.model));
    el('send').hidden = chat.busy; el('stop').hidden = !chat.busy;
    el('billing').textContent = run ? 'Runs with your user permissions' : chat.model.startsWith('chatgpt/') ? 'Using ChatGPT plan' : /^(openai|anthropic)\//.test(chat.model) ? 'Using provider API billing' : chat.model.startsWith('claude-code/') ? 'Using Claude Code account' : chat.model ? 'Using local Ollama' : 'No model selected';
    chips(chat, research);
    if (el('permission')) {
        el('permission').value = chat.permission; el('permission').disabled = chat.busy;
        el('permission').title = { ask: 'Ask first: every change, command and web fetch needs approval.', auto: `Auto: project edits apply directly; ${chat.agent?.sandbox ? 'commands run sandboxed (project + temp writes, no network)' : 'commands ask first (sandbox unavailable)'}.`, full: 'Full access: no approvals, no sandbox.' }[chat.permission];
        const state = el('agent-state'), project = chat.agent?.project, mode = latest?.state.mode;
        state.replaceChildren();
        if (mode === 'Build' || mode === 'Plan') {
            if (!project) state.append(text('span', 'No project folder'), button('Open Folder', () => send('openFolder'), 'link'));
            else if (!project.trusted) state.append(text('span', 'Restricted Mode', 'warn'), button('Trust Folder', () => send('trustFolder'), 'link'));
            else state.append(text('span', `${project.name}${chat.permission === 'auto' ? chat.agent.sandbox ? ' · sandboxed' : ' · no sandbox' : ''}`));
        } else state.append(text('span', mode === 'Research' ? 'Research tools' : 'No tools in Discuss'));
        state.className = `agent-state${chat.permission === 'full' ? ' full' : ''}`;
    }
    if (!chat.messages.length) scroller.scrollTop = 0; else if (atBottom) scroller.scrollTop = scroller.scrollHeight;
}
function renderConnections(chat) {
    const c = chat.connections, by = provider => (c.connections || []).find(item => item.provider === provider);
    for (const node of document.querySelectorAll('#connections button')) node.disabled = !!chat.connecting && !['chatgptCancel', 'hideConnections'].includes(node.dataset.command) && !node.dataset.tab;
    const account = c.chatgpt?.accounts?.find(item => item.id === c.chatgpt.activeId);
    const states = { chatgpt: account?.signedIn ? account.label || 'Signed in' : 'Not connected', 'claude-code': by('claude-code')?.connected ? by('claude-code').account || 'Connected' : by('claude-code')?.installed === false ? 'Not installed' : 'Not connected',
        ollama: by('ollama')?.connected ? 'Running' : 'Not running', api: ['openai', 'anthropic'].filter(p => by(p)?.connected).map(p => p === 'openai' ? 'OpenAI' : 'Anthropic').join(' · ') || 'No keys' };
    const ready = { chatgpt: !!account?.signedIn, 'claude-code': !!by('claude-code')?.connected, ollama: !!by('ollama')?.connected, api: states.api !== 'No keys' };
    for (const node of document.querySelectorAll('[data-state]')) { node.textContent = states[node.dataset.state]; node.classList.toggle('ready', ready[node.dataset.state]); }
    const notes = (c.connections || []).filter(item => item.error && item.provider !== 'ollama').map(item => text('p', `${item.provider}: ${item.error}`, 'muted'));
    if (chat.connecting) notes.unshift(text('p', 'Connecting… Complete sign-in in your browser, or cancel it here.'));
    if (c.error) notes.push(text('p', c.error, 'error'));
    el('connection-status').replaceChildren(...notes);
    el('remember').disabled = !c.secureStorage; if (!c.secureStorage) el('remember').checked = false;
    el('remember').parentElement.title = c.secureStorage ? '' : 'Secure storage is unavailable; sign-ins last for this session.';
    options(el('account'), (c.chatgpt?.accounts || []).map(a => ({ id: a.id, name: a.label })), c.chatgpt?.activeId, 'Add account');
    el('chatgpt-welcome').hidden = !c.chatgpt?.welcome;
}
function render(data) {
    latest = data; sessionId = data.chat?.id; generation = data.review.generation;
    for (const node of document.querySelectorAll('nav [data-mode]')) node.setAttribute('aria-pressed', String(node.dataset.mode === data.state.mode));
    for (const field of ['draft', 'brief']) if (el(field) && el(field).value !== data.state[field]) el(field).value = data.state[field];
    for (const node of document.querySelectorAll('[data-page]')) node.hidden = node.dataset.page !== data.state.mode;
    el('scope').textContent = data.scope;
    if (el('mode-note')) el('mode-note').textContent = modeNotes[data.state.mode] || '';
    if (el('research-form')) {
        const research = data.research;
        el('research-open').disabled = research.busy;
        el('research-open').textContent = research.busy ? 'Opening…' : research.opened ? 'Open Address in Browser' : 'Open Research Browser';
        el('research-close').hidden = !research.opened && !research.busy;
        el('research-state').textContent = research.error || (research.loading ? 'Loading…' : research.opened ? research.title || research.url : 'Enter a website or search query to begin.');
        for (const node of document.querySelectorAll('[data-command^="capture"]')) node.disabled = !research.opened || research.loading;
        sources(data.research.sources || []);
    }
    for (const controls of document.querySelectorAll('[data-review-controls]')) controls.hidden = !data.review.pending;
    for (const node of document.querySelectorAll('[data-command="propose"], [data-command="apply"], [data-command="discard"]')) node.disabled = data.review.busy || !!data.chat?.busy;
    el('status').textContent = data.chat?.error || data.status || localStatus;
    if (data.chat) {
        if (surface === 'conversation') renderChat(data.chat, data.research);
        else renderConnections(data.chat);
    }
}
window.addEventListener('message', ({ data }) => {
    if (data.type === 'connections' && el('connections')) { el('connections').hidden = false; el('workspace-pages').hidden = true; return; }
    if (data.type !== 'state') return;
    if (data.status !== latest?.status) localStatus = '';
    render(data);
});
send('ready');
