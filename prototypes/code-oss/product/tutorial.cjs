'use strict';
// Furnace's interactive tutorial. It walks through every part of Furnace one step at a time:
// each step opens what it talks about (a view, page, mode or pane, pressing buttons the way a
// user would) and shows a bubble pointing at it. Steps in the editor window are drawn by the
// window (furnace.tutorial.* commands, patches/furnace-tutorial.patch); steps inside Furnace's
// panels are drawn by the panels (webview/tutorial.tsx). A welcome card offers it on startup.

/**
 * where: 'window' (targets are CSS selectors in the workbench, first visible wins; menubar points
 * at the native menu bar) or a panel surface ('conversation', 'home'; target is a selector in it).
 * mode, page, command, press, demo and panes prepare the step; after undoes the command when leaving it.
 */
const STEPS = [
    { id: 'welcome', where: 'window', title: 'Welcome to Furnace',
        body: 'Furnace is a coding workspace where you and an AI agent work on the same project. This tour points out each part and opens it for you.\n\nUse **Next** and **Back** (or the arrow keys); **End Tutorial** or Escape stops at any time.' },
    { id: 'layout-chat', where: 'window', targets: ['.part.auxiliarybar'], command: 'aiGui.conversation.focus', title: 'The conversation',
        body: 'The panel on the right is your chat with the agent: its messages, its work and the message box. It stays open while you edit code.' },
    { id: 'layout-workspace', where: 'window', targets: ['.action-item[aria-label^="Furnace Workspace"]', '.action-item a[aria-label^="Furnace Workspace"]', '.part.activitybar', '.part.sidebar .composite-bar'], command: 'aiGui.workspace.focus',
        title: 'The Furnace Workspace', body: 'This icon opens the Furnace Workspace in the left side bar. It has a page for each way of working, plus your rules, the activity log and connections.' },
    { id: 'pages', where: 'home', target: '.page-tabs', page: 'start', mode: 'Discuss', title: 'Pages set the mode',
        body: '**Start** is Discuss mode (talk only), **Plan** reads your project and drafts a plan, **Build** lets the agent change files and run commands, and **Research** works with web sources you capture.\n\nAlt+1…4 or Ctrl+Alt+M switch modes from the chat too.' },
    { id: 'connections', where: 'home', target: '#connections .provider-tabs', page: 'connections', title: 'Connect a model',
        body: 'Connections lists every way to bring a model: your **ChatGPT** plan, **Claude** through Claude Code, **Local** models with Ollama, or **API keys**. Each uses its own account and billing; nothing falls back to paid billing on its own.' },
    { id: 'model', where: 'conversation', target: '#model', title: 'Pick a model',
        body: 'Choose the model here. Each mode remembers the model you last picked for it, and the status bar always shows the active one.' },
    { id: 'chips', where: 'conversation', target: '#chips', title: 'Share only what helps',
        body: 'These chips decide what the agent sees besides the chat: the current document, your selection, Git changes, Problems and the planning brief. Highlighted chips are shared.\n\nType **@** in the message box to add a file or folder, paste a screenshot with Ctrl+V, or attach files with the paperclip.' },
    { id: 'draft', where: 'conversation', target: '#draft', title: 'The message box',
        body: 'Describe what you want. **Enter** sends (while the agent works it queues the message), **Shift+Enter** adds a line, **Escape** stops a reply.\n\nType **/** for commands such as /compact, /timeline, /review or /background.' },
    { id: 'input-mode', where: 'conversation', target: '.input-mode', title: 'Ask or Run',
        body: '**Ask** talks to the agent. **Run** runs your own shell command in the project and shows the output in the chat.' },
    { id: 'meter', where: 'conversation', target: '.composer-hint', title: 'Usage and context',
        body: 'Below the box: how this chat is billed, its cost with API keys, and the context meter. Long chats are condensed into a summary automatically; click the meter or type /compact to do it now.' },
    { id: 'permissions', where: 'conversation', target: '#permission', mode: 'Build', title: 'How much it may do',
        body: '**Ask first** approves every change and command. **Auto** (the default) edits inside the project and runs commands in a sandbox with no network. **Full access** asks nothing; keep it for tasks you watch.\n\nOutside the project, secret files, .git and the web always ask, except with Full access.' },
    { id: 'autocompute', where: 'conversation', target: '#autocompute', mode: 'Build', title: 'Autocompute',
        body: 'In Build, tick **Autocompute** to let your online model hand small tasks (tests, small edits, docs) to local Ollama models and review their work, saving online usage. Furnace only gives each model the tasks it has shown it can do.' },
    { id: 'reply', where: 'conversation', target: '#message-tutorial-reply .step-group, #message-tutorial-reply .work-summary', demo: true, title: 'Watch it work',
        body: 'This is a sample reply. Every action the agent takes is a step: files it read, files it changed (with +/− lines) and commands it ran. Finished work collapses into one line; click it to see each step and its diff or output.' },
    { id: 'delegated', where: 'conversation', target: '#message-tutorial-reply .autocompute', demo: true, title: 'Work done by local models',
        body: 'With Autocompute, this card lists each task a local model did, its confidence, the check Furnace ran and the online model\'s verdict, plus the local tokens used.' },
    { id: 'changes', where: 'conversation', target: '#message-tutorial-reply [aria-label="Files changed in this reply"]', demo: true, title: 'Review and revert',
        body: 'Every reply that changed files ends with this list. Click a file or **Review** for its diff, ↶ to put one file back, **Revert All** for the whole reply, and **Second Opinion** to have another model check the diff.' },
    { id: 'rewind', where: 'conversation', target: '#message-tutorial-user [aria-label="Rewind to here"]', demo: true, title: 'Rewind',
        body: '**Rewind to here** removes this message and everything after it, restores the files the agent changed since, and puts your message back in the box to edit and resend. **Branch** starts a new chat from this point.' },
    { id: 'header', where: 'conversation', target: '.conversation-head .tools', title: 'Chat controls',
        body: 'Start a **New Chat**, open the **Timeline** or browse your **Chat History**. The title shows the chat\'s current mode.' },
    { id: 'timeline', where: 'conversation', target: '#timeline', press: '[aria-label="Timeline"]', panes: 'keep', title: 'The timeline',
        body: 'The timeline lists each of your messages with the files changed and checks passed since. Jump to one, **Compare with Now** to diff everything since, or **Restore** to rewind to it.' },
    { id: 'history', where: 'conversation', target: '.history', press: '[aria-label="Chat History"]', panes: 'keep', title: 'Chat history',
        body: 'Every conversation is saved on this device. Search, reopen, rename or delete them here.' },
    { id: 'plan', where: 'home', target: '#brief', page: 'plan', mode: 'Plan', title: 'Plan, then prove each step',
        body: 'The Plan page holds a checklist brief, written by you or proposed in Plan mode. A step can carry a check, such as (check: `npm test`). **Build from Plan** works through the steps and ticks each one only when its check passes.' },
    { id: 'build', where: 'home', target: '#background', page: 'build', mode: 'Build', title: 'Build and background tasks',
        body: 'The Build page links to Source Control and Inline Edit, and runs **background tasks**: the agent works on a copy of your project in its own Git worktree while you keep coding, and you review and apply the result.' },
    { id: 'research', where: 'home', target: '#research-form', page: 'research', mode: 'Research', title: 'Research',
        body: 'Open a website or search in a separate, sandboxed browser. Capture a selection or a page as a source; nothing is shared until you tick it. Replies cite sources as [S1], [S2]….' },
    { id: 'rules', where: 'home', target: '#workspace-pages > section', page: 'rules', title: 'Saved rules',
        body: 'Rules you save from an approval ("Always allow … in this project") are listed here, such as always allowing `npm test` or never touching a folder. Remove them any time.' },
    { id: 'activity', where: 'home', target: '#workspace-pages > section', page: 'activity', title: 'Activity log',
        body: 'Everything the agent did in this project: each step and how it was allowed, your approvals, reverts and rules. It stays on this device.' },
    { id: 'scm', where: 'window', targets: ['.part.sidebar .pane-body', '.part.sidebar'], command: 'workbench.view.scm', title: 'Source Control',
        body: 'Files the agent changed are listed under **AI Agent**, next to Git\'s own changes, so you can diff, revert or stage them. Changed files also get an **AI** badge in the Explorer.' },
    { id: 'editor', where: 'window', targets: ['.part.editor'], title: 'In the editor',
        body: 'Select code and press **Ctrl+Alt+E** for an inline edit: the change appears in place, Ctrl+Enter keeps it and Escape puts the original back. Blocks the agent changed get **Keep** and **Revert** above them.' },
    { id: 'terminal', where: 'window', targets: ['.part.panel'], command: 'workbench.actions.view.problems', after: 'workbench.action.closePanel', title: 'Terminals and Problems',
        body: 'This bottom panel holds **Problems**, **Output** and terminals. The agent\'s commands appear live in the **AI Agent** terminal there, and dev servers it starts get their own. Use Terminal → New Terminal for your own shell.' },
    { id: 'status', where: 'window', targets: ['.part.statusbar [id$="aiGui.model"]', '.part.statusbar'], title: 'Status bar',
        body: 'The status bar shows the active model; click it to open Connections.' },
    { id: 'themes', where: 'window', menubar: true, title: 'Themes',
        body: 'The **Themes** menu at the top changes how Furnace looks: pick a **preset**, or **Create a Custom Theme** with your own background (a colour, gradient or picture), fonts, text and code colours and accent. Each project can keep its own theme, and a night theme can follow your system\'s dark mode.\n\n**Agent Glow** makes the chat panel glow while the agent works. You can also type `/theme` in the message box.' },
    { id: 'menu', where: 'window', menubar: true, title: 'The Furnace menu',
        body: 'The **Furnace** menu at the top has **Begin Tutorial** to take this tour again and **Help** for the full guide. The **Display** menu changes the window\'s opacity.\n\nThat\'s the tour. Open the Start page or Help whenever you need it.' },
];

function createTutorial({ vscode, context, views, getMode, setMode, showHome, log }) {
    let run = 0, pending;
    const settings = () => ({ dontShow: false, completed: false, ...context.globalState.get('tutorial') });
    const remember = changes => context.globalState.update('tutorial', { ...settings(), ...changes });
    const panels = surface => [...views.values()].filter(view => view.surface === surface && view.ready);
    const post = (surface, message) => { for (const view of panels(surface)) void view.webview.postMessage(message); };
    const clearPanels = except => { for (const surface of ['conversation', 'home']) if (surface !== except) post(surface, { type: 'tutorial', step: null }); };
    const hideWindow = () => vscode.commands.executeCommand('furnace.tutorial.hide').then(undefined, () => {});
    const settle = action => { const current = pending; pending = undefined; current?.resolve(action); };
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

    async function windowPoint(payload) {
        try { return await vscode.commands.executeCommand('furnace.tutorial.point', payload); }
        catch (error) {
            // Without the window overlay (an unpatched editor), steps become notifications.
            log('warn', `Tutorial overlay unavailable: ${error.message}`);
            const choice = await vscode.window.showInformationMessage(`${payload.title}: ${payload.body.replace(/\*\*/g, '')}`, payload.last ? 'Finish' : 'Next', 'End Tutorial');
            return choice === 'Next' ? 'next' : 'end';
        }
    }
    async function prepare(step) {
        if (step.mode && getMode() !== step.mode) setMode(step.mode);
        if (step.command) await vscode.commands.executeCommand(step.command).then(undefined, error => log('warn', `Tutorial: ${step.command}: ${error.message}`));
        if (step.where === 'home') await showHome(step.page);
        if (step.where === 'conversation') await vscode.commands.executeCommand('aiGui.conversation.focus');
        // A panel opened for the first time needs a moment to load before it can draw the bubble.
        for (let wait = 0; step.where !== 'window' && !panels(step.where).length && wait < 40; wait++) await delay(100);
    }

    async function begin() {
        const token = ++run; settle('replaced');
        const startMode = getMode();
        let index = 0, finished = false;
        try {
            while (index >= 0 && index < STEPS.length) {
                const step = STEPS[index], last = index === STEPS.length - 1;
                await prepare(step);
                if (token !== run) return;
                const base = { id: `${token}-${step.id}`, index, total: STEPS.length, title: step.title, body: step.body, last };
                let action;
                if (step.where !== 'window' && panels(step.where).length) {
                    await hideWindow(); clearPanels(step.where);
                    action = await new Promise(resolve => {
                        pending = { id: base.id, resolve };
                        post(step.where, { type: 'tutorial', step: { ...base, target: step.target, press: step.press, demo: !!step.demo, panes: step.panes, page: step.page } });
                    });
                } else {
                    clearPanels();
                    action = await windowPoint({ ...base, targets: step.targets || [], menubar: !!step.menubar });
                }
                // Undo what this step opened only for the tour (the panel), whichever way the user goes.
                if (step.after) await vscode.commands.executeCommand(step.after).then(undefined, () => {});
                if (token !== run || action === 'replaced') return;
                if (action === 'next') index++;
                else if (action === 'back') index = Math.max(0, index - 1);
                else { finished = last; break; }
            }
            if (index >= STEPS.length) finished = true;
        } finally {
            if (token === run) {
                clearPanels(); await hideWindow();
                if (getMode() !== startMode) setMode(startMode);
                // Leave the Furnace Workspace in the side bar (the tour ends on Source Control) and focus the chat.
                await vscode.commands.executeCommand('aiGui.workspace.focus').then(undefined, () => {});
                await vscode.commands.executeCommand('aiGui.conversation.focus').then(undefined, () => {});
            }
        }
        if (finished) await remember({ completed: true });
        return finished;
    }

    return {
        steps: STEPS,
        begin,
        /** A panel's Next, Back or End Tutorial. */
        action(message) {
            if (typeof message.id !== 'string' || !['next', 'back', 'end'].includes(message.action)) throw new Error('Invalid tutorial action.');
            if (pending?.id === message.id) settle(message.action);
        },
        /** On startup: offer the tutorial unless the user said not to, or already finished it. */
        async welcome() {
            const state = settings();
            if (state.dontShow || state.completed) return;
            let answer;
            try {
                answer = await vscode.commands.executeCommand('furnace.tutorial.welcome', {
                    title: 'Welcome to Furnace',
                    body: 'Is this your first time here? A short interactive tutorial points out each part of Furnace and opens it for you. It takes about five minutes, and you can leave it at any step.\n\nYou can start it later from **Furnace → Begin Tutorial** at the top.',
                    start: 'Start the Tutorial', later: 'Not Now', dontShow: 'Don\'t show this again',
                });
            } catch (error) { log('warn', `Tutorial welcome unavailable: ${error.message}`); return; }
            if (answer?.dontShow) await remember({ dontShow: true });
            if (answer?.choice === 'start') await begin();
        },
        stop() { run++; settle('replaced'); clearPanels(); void hideWindow(); },
    };
}

module.exports = { createTutorial, STEPS };
