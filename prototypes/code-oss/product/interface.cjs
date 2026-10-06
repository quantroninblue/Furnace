'use strict';
const vscode = require('vscode');
const crypto = require('node:crypto');
const { modes } = require('../../shared/product-core.cjs');

// Minimal stroke icons, matching the original app's lucide-style set.
const paths = {
    plus: '<path d="M12 5v14M5 12h14"/>',
    history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>',
    plug: '<path d="M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0zM12 18v4"/>',
    layout: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/>',
    clip: '<path d="m21.4 11-8.5 8.6a5.5 5.5 0 0 1-7.8-7.8l8.6-8.5a3.7 3.7 0 0 1 5.2 5.2l-8.6 8.5a1.8 1.8 0 0 1-2.6-2.6l7.9-7.8"/>',
    up: '<path d="M12 19V5M5 12l7-7 7 7"/>',
    stop: '<rect x="7" y="7" width="10" height="10" rx="1.5"/>',
    sparkle: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
    arrow: '<path d="M7 17 17 7M8 7h9v9"/>',
    layers: '<path d="m12 2 9 5-9 5-9-5z"/><path d="m3 12 9 5 9-5M3 17l9 5 9-5"/>',
    book: '<path d="M2 4h7a3 3 0 0 1 3 3v14a2 2 0 0 0-2-2H2zM22 4h-7a3 3 0 0 0-3 3v14a2 2 0 0 1 2-2h8z"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
    code: '<path d="m16 18 6-6-6-6M8 6l-6 6 6 6"/>',
    folder: '<path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    shield: '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/><path d="m9 12 2 2 4-4"/>',
    chevron: '<path d="m9 6 6 6-6 6"/>',
};
const icon = (name, size = 15) => `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
exports.icon = icon;

function conversation() {
    const navigation = `<nav class="modes" aria-label="Workspace modes">${modes.map(mode => `<button data-mode="${mode}" aria-pressed="false">${mode}</button>`).join('')}</nav>`;
    const tool = (command, label, name, title) => `<button class="icon-button" data-command="${command}" aria-label="${label}" title="${title}">${icon(name)}</button>`;
    return `<div class="conversation">
<header class="conversation-head"><div class="conversation-title"><strong id="chat-title">New conversation</strong><span id="scope"></span></div>
<div class="tools">${tool('newChat', 'New Chat', 'plus', 'New chat (/new)')}${tool('resumeChat', 'Resume Chat', 'history', 'Resume a chat (/resume)')}${tool('connections', 'Connections', 'plug', 'Connections (/connections)')}${tool('home', 'Open Workspace', 'layout', 'Open the workspace page')}</div></header>
${navigation}<p id="mode-note" class="mode-note"></p>
<div class="review-bar" data-review-controls hidden><span>${icon('shield', 13)} Reviewed edit ready</span><div class="row"><button class="primary" data-command="apply">Apply Reviewed Changes</button><button class="ghost" data-command="discard">Discard Proposal</button></div></div>
<div class="messages" id="scroller"><div id="messages" aria-label="Conversation messages"></div>
<div id="empty-chat" class="chat-empty"><div class="assistant-avatar">${icon('sparkle', 20)}</div><h3>What are we thinking about?</h3><p>Bring a half-formed idea, a tricky function, or the question you haven’t asked yet.</p>
<div class="prompt-suggestions"><button data-suggest="Help me shape the project brief.">Help me shape the project brief${icon('arrow', 12)}</button><button data-suggest="Talk through the tradeoffs with me.">Talk through the tradeoffs with me${icon('arrow', 12)}</button><button data-suggest="Review the file I’m working on." data-share-editor>Review the file I’m working on${icon('arrow', 12)}</button></div>
<button id="tour-hint" class="connect-hint" data-command="tourShow" hidden></button><button id="connect-hint" class="connect-hint" data-command="connections" hidden>${icon('plug', 13)} Connect a model to start</button>
<p class="empty-chat-note">${icon('shield', 12)} You choose the mode. You review the actions.</p></div></div>
<div class="composer-area"><div id="status" role="status" class="status-line"></div>
<div id="slash" class="slash-palette" hidden><div class="slash-heading"><span>${icon('layers', 13)} Workspace</span><small id="slash-count"></small></div><div id="slash-options" class="slash-options" role="listbox" aria-label="Commands"></div><div class="slash-footer"><span><kbd>↑</kbd><kbd>↓</kbd> navigate</span><span><kbd>↵</kbd> select</span><span><kbd>esc</kbd> close</span></div></div>
<div class="context-area"><div class="context-label">${icon('layers', 11)} CONTEXT FOR NEXT MESSAGE</div><div id="chips" class="context-chips"></div></div>
<div class="agent-bar"><label class="permission" title="What the agent may do without asking">${icon('shield', 12)}<select id="permission" aria-label="Permissions"><option value="ask">Ask first</option><option value="auto">Auto</option><option value="full">Full access</option></select></label><span id="agent-state" class="agent-state"></span></div>
<div class="composer"><textarea id="draft" aria-label="Conversation draft" maxlength="20000" rows="3" placeholder="Ask anything, or / for commands…"></textarea>
<div class="composer-actions"><div class="input-mode" role="group" aria-label="Input mode"><button data-input="ask" aria-pressed="true" title="Ask the assistant">Ask</button><button data-input="run" aria-pressed="false" title="Run a shell command in this project">Run</button></div>
<button class="icon-button" data-command="attach" aria-label="Attach Files" title="Attach files (/attach)">${icon('clip', 14)}</button>
<select id="model" class="composer-model" aria-label="Active model"><option value="">Connect and choose a model</option></select>
<button id="stop" class="send-button stopping" data-command="stop" aria-label="Stop" title="Stop" hidden>${icon('stop', 14)}</button><button id="send" class="send-button" data-command="send" aria-label="Send" title="Send (Enter)" disabled>${icon('up', 15)}</button></div></div>
<div class="composer-hint"><span id="billing"></span><span id="hint" title="Enter sends · Shift+Enter adds a line">/ for commands</span></div></div></div>`;
}

function workspace() {
    const card = (attrs, name, title, detail) => `<button ${attrs}>${icon(name, 17)}<strong>${title}</strong><span>${detail}</span>${icon('chevron', 13)}</button>`;
    const connections = `<section id="connections" class="connections" hidden><div class="connection-modal"><div class="modal-heading"><div class="welcome-symbol small">${icon('plug', 18)}</div></div>
<div class="eyebrow">Your tools, one workspace</div><h2>Connect a model.</h2><p class="lede">Choose a connection, then pick an Active model in the conversation panel. API keys use provider billing; ChatGPT uses your plan; Claude Code owns its sign-in and billing. Nothing falls back to another account automatically.</p>
<div class="provider-tabs" role="tablist" aria-label="Connection type"><button role="tab" data-tab="chatgpt" aria-selected="true">ChatGPT</button><button role="tab" data-tab="claude" aria-selected="false">Claude</button><button role="tab" data-tab="local" aria-selected="false">Local</button><button role="tab" data-tab="api" aria-selected="false">API keys</button></div>
<div id="connection-status" role="status" class="connection-status"></div>
<div class="connection-card" data-panel="chatgpt"><div class="connection-card-title"><div class="provider-icon">${icon('shield', 17)}</div><div><strong>ChatGPT</strong><span>Your account · your plan</span></div><em class="connection-state" data-state="chatgpt"></em></div>
<p class="connection-detail">Use your ChatGPT plan for eligible requests. OpenAI checks your account’s models and limits. This connection never switches to paid API billing.</p>
<label for="account">Saved account</label><select id="account"><option value="">Add account</option></select>
<div class="row"><button class="primary" data-command="chatgptSignIn">Continue with ChatGPT</button><button class="ghost" data-command="chatgptCancel">Cancel Sign-in</button></div>
<div class="row"><button class="ghost" data-command="chatgptSelect">Use Account</button><button class="ghost" data-command="chatgptSignOut">Sign Out</button><button class="ghost" data-command="chatgptUsage">Manage Usage</button></div>
<div id="chatgpt-welcome" class="chatgpt-welcome" hidden><strong>ChatGPT plan usage is enabled.</strong><p>Requests use this app’s allowance; availability and limits depend on your account. There is no automatic API fallback.</p><button class="ghost" data-command="chatgptAcknowledge">Got it</button></div></div>
<div class="connection-card" data-panel="claude" hidden><div class="connection-card-title"><div class="provider-icon">${icon('sparkle', 17)}</div><div><strong>Claude Code</strong><span>Your installed CLI · its account</span></div><em class="connection-state" data-state="claude-code"></em></div>
<p class="connection-detail">Sign-in opens an IDE terminal running Claude Code. Finish there (paste any browser code into the terminal); connections refresh when it closes.</p>
<div class="row"><button class="primary" data-command="claudeLogin">Sign In with Claude Code</button><button class="ghost" data-command="claudeConsole">Use Console Account</button></div></div>
<div class="connection-card" data-panel="local" hidden><div class="connection-card-title"><div class="provider-icon">${icon('layers', 17)}</div><div><strong>Ollama</strong><span>Local models · this machine</span></div><em class="connection-state" data-state="ollama"></em></div>
<p class="connection-detail">Start Ollama separately and install a model, then refresh. Models run only when you send; nothing is downloaded automatically.</p></div>
<div class="connection-card" data-panel="api" hidden><div class="connection-card-title"><div class="provider-icon">${icon('code', 17)}</div><div><strong>API keys</strong><span>Provider billing</span></div><em class="connection-state" data-state="api"></em></div>
<p class="connection-detail">Keys stay in the separate connection service and are cleared from this field after connecting. A verified key confirms model-list access, not credit.</p>
<label for="provider">API provider</label><select id="provider"><option value="openai">OpenAI API</option><option value="anthropic">Anthropic API</option></select>
<label for="api-key">API key</label><input id="api-key" type="password" autocomplete="off" maxlength="4096" placeholder="Paste a key">
<div class="row"><button class="primary" data-command="connect">Connect API Key</button><button class="ghost" data-command="disconnect">Disconnect API Key</button></div></div>
<label class="check remember"><input id="remember" type="checkbox">Remember sign-ins and keys securely on this device</label>
<div class="modal-actions"><button class="ghost" data-command="refreshConnections">Refresh Connections</button><button class="primary" data-command="hideConnections">Close Connections</button></div></div></section>`;
    return `<main class="workspace"><header class="page-top"><span class="eyebrow"><i class="dot"></i>A shared place to think &amp; build</span><div class="page-tools"><span class="text-size" role="group" aria-label="Text size">Text size<button class="ghost small" data-command="textSmaller" aria-label="Smaller text" title="Smaller text (Ctrl+-)">A−</button><button class="ghost small" data-command="textLarger" aria-label="Larger text" title="Larger text (Ctrl+=)">A+</button></span><span id="scope" class="scope-pill"></span></div></header>
<section id="tour" class="tour" hidden aria-label="Getting started"><div class="tour-head"><div><div class="eyebrow">Getting started</div><h2 id="tour-title">Set up AI GUI in a few steps</h2></div><div class="row"><span id="tour-progress" class="tour-progress"></span><button class="ghost small" data-command="tourDismiss" id="tour-dismiss">Skip tour</button></div></div><ol id="tour-steps" class="tour-steps"></ol></section>${connections}<div id="workspace-pages">
<section data-page="Discuss" class="welcome"><div class="welcome-symbol">${icon('layers', 30)}</div><h1>Your ideas.<br><span>A little more possibility.</span></h1><p class="lede">A workspace for you and your agents.<br>Explore the plan, work in the code, stay in control.</p>
<button class="primary large" data-command="openFolder">${icon('folder', 15)} Open a project ${icon('chevron', 13)}</button>
<div class="welcome-cards">${card('data-mode="Plan"', 'book', 'Think it through', 'Shape a brief together')}${card('data-mode="Research"', 'globe', 'Bring the context', 'Research without losing place')}${card('data-command="connections"', 'plug', 'Connect a model', 'ChatGPT, Claude, API keys or Ollama')}</div>
<p class="footnote">${icon('shield', 12)} Built for collaboration. You keep the controls.</p></section>
<section data-page="Plan" hidden><div class="page-heading"><h2>Make the next step clear.</h2><p class="lede">An editable brief saved with this conversation. Share it from the conversation’s context chips to include it in replies.</p></div>
<div class="plan-toolbar">${icon('book', 14)}<span>Project brief</span><small>LOCAL</small></div><textarea id="brief" class="plan-editor" maxlength="40000" aria-label="Planning brief" placeholder="What are we building?&#10;&#10;Goals&#10;Constraints&#10;Next steps"></textarea></section>
<section data-page="Build" hidden><div class="page-heading"><h2>Your code. Your decisions.</h2><p class="lede">Ask for a change in the conversation. The agent explores, edits and creates files and runs commands within your permission mode (Ask first, Auto or Full access), showing each step and its diff. Edits go through the editor, so Undo works.</p></div>
<div class="row"><button class="ghost" data-command="openFile">${icon('code', 14)} Open File</button><button class="ghost" data-command="propose">Propose Example Edit</button></div>
<div class="row" data-review-controls hidden><button class="primary" data-command="apply">Apply Reviewed Changes</button><button class="ghost" data-command="discard">Discard Proposal</button></div>
<div class="note">${icon('shield', 13)}<p>To run a command, switch the composer to <b>Run</b> or type <code>/run npm test</code>. Commands run with your user permissions in the project folder; output appears in the conversation and Stop cancels it. Use the IDE terminal for interactive work. Example Edit is a deterministic demo.</p></div></section>
<section data-page="Research" hidden><div class="page-heading"><h2>Research desk</h2><p class="lede">Browse references in a separate, sandboxed window while your code stays here. Capturing saves a source; only sharing includes it in a reply.</p></div>
<form id="research-form" class="browser-address">${icon('globe', 15)}<input id="research-address" maxlength="8192" autocomplete="off" spellcheck="false" aria-label="Website or search query" placeholder="Website or search query"><button id="research-open" class="primary" type="submit">Open Research Browser</button><button type="button" class="ghost" data-command="researchClose" id="research-close" hidden>Close Browser</button></form>
<p id="research-state" role="status" class="muted"></p>
<div class="sources-heading"><span class="section-label">COLLECTED SOURCES · <b id="source-count">0</b>/6</span><div class="row"><button class="ghost" data-command="captureSelection">Capture Selection</button><button class="ghost" data-command="capturePage">Capture Page</button></div></div>
<p class="muted small">Select text in the browser, then Capture Selection. Keep up to six sources; share up to three.</p><div id="sources"></div>
<div class="note">${icon('shield', 13)}<p>The research browser has no terminal or filesystem bridge. Captured text reaches a model only when you share it.</p></div></section></div><div id="status" role="status" class="status-line"></div></main>`;
}

exports.content = (webview, extensionUri, surface) => {
    const media = file => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', file));
    const nonce = crypto.randomBytes(16).toString('hex');
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="${media('workspace.css')}"></head><body data-surface="${surface}">${surface === 'conversation' ? conversation() : workspace()}<script nonce="${nonce}" src="${media('workspace.js')}"></script></body></html>`;
};
