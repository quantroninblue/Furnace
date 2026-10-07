# AI GUI

A desktop coding workspace where you and an AI agent work on the same project. Plan
an idea, research it, and let the agent read, edit and create files and run
commands, with you deciding how much it may do on its own.

AI GUI is built on Code OSS, the open-source core of Visual Studio Code, so you
also get a full editor, terminals, Git, debugging and extensions.

> **Preview.** AI GUI is a Linux development build (tested on Ubuntu 24.04). There
> is no installer yet; you run it from this repository. Windows and macOS are not
> supported yet. The from-source setup below has so far been used on one
> development machine; please report anything that doesn't work.

## Your data stays yours

- **No AI GUI account, no server, no telemetry.** We never receive your prompts,
  files, keys or sign-ins.
- **Only what you send leaves your computer**, and only to the model you chose:
  your message, the context you shared, and what the agent reads to do the task.
- **Your accounts, your billing.** ChatGPT plan, Claude Code, your own API keys or
  local Ollama. Nothing switches accounts or falls back to paid billing on its own.
- **Conversations, rules, checkpoints and the activity log stay on this device.**
  With a local Ollama model, nothing leaves your machine at all.

Details: [DATA_USAGE.md](DATA_USAGE.md).

## Contents

- [Set up](#set-up)
- [Connect a model](#connect-a-model)
- [The workspace](#the-workspace)
- [Working with the agent](#working-with-the-agent)
- [Research](#research)
- [Costs and usage](#costs-and-usage)
- [Debugging and extensions](#debugging-and-extensions)
- [Commands and shortcuts](#commands-and-shortcuts)
- [Tips](#tips)
- [Troubleshooting](#troubleshooting)

## Set up

You need Linux x86-64, Git, Python 3, a C/C++ compiler (`build-essential`),
`pkg-config` and about 10 GB of free disk space. The editor core is built once
from a pinned Code OSS release; later updates only rebuild AI GUI itself.

From the repository folder:

```sh
# 1. Node.js 24.18.0, kept inside the project
mkdir -p prototypes/code-oss/.cache
curl -fsSL https://nodejs.org/dist/v24.18.0/node-v24.18.0-linux-x64.tar.xz \
  | tar -xJ -C prototypes/code-oss/.cache

# 2. The pinned Code OSS source (version 1.140.0)
git clone --depth 1 --branch 1.140.0 https://github.com/microsoft/vscode.git \
  prototypes/code-oss/upstream

# 3. Native libraries (Ubuntu 24.04 only; downloads packages into the project
#    folder, installs nothing system-wide). Skip if you have the -dev packages.
node prototypes/code-oss/scripts/prepare-native.mjs

# 4. Build the editor core, one stage at a time (this takes a while)
node prototypes/code-oss/scripts/run.mjs npm ci --ignore-scripts --no-audit --no-fund
cd prototypes/code-oss
node scripts/setup.mjs build-tools
node scripts/setup.mjs headers electron native transpile
node scripts/setup.mjs extensions extensions-startup extensions-json extensions-markdown
node scripts/setup.mjs extensions-debug builtin-extensions
cd ../..

# 5. Install AI GUI's own dependencies, build and start
npm ci
npm run build
npm start
```

After the first setup, start AI GUI with `npm run build && npm start` (or just
`npm start` if nothing changed).

On first launch, a **Getting started** guide on the workspace page walks you
through connecting a model, opening and trusting a folder, choosing permissions
and giving the agent its first task. Each step ticks itself off as you go. Skip it
any time and bring it back with `/tour` or **AI GUI: Getting Started** in the
command palette (`Ctrl+Shift+P`). **Help → Welcome** also has a short *Get Started
with AI GUI* walkthrough.

## Connect a model

Open **Connections** from the **Connections** tab of the workspace view, the model
name in the status bar, or by typing `/connections`. Choose a tab:

| Tab | What you need | Billing |
| --- | --- | --- |
| **ChatGPT** | A ChatGPT account. Choose **Continue with ChatGPT** and finish sign-in in your browser. | Your ChatGPT plan |
| **Claude** | [Claude Code](https://code.claude.com) 2.1.248 or newer installed. Choose **Sign In with Claude Code**, finish in the terminal that opens (paste the browser code there if asked); connections refresh by themselves. If Claude Code is already signed in, it connects automatically when the app starts. | Your Claude account |
| **Local** | [Ollama](https://ollama.com) running with a model installed. For agent work, pick a model that supports tool calling (for example Qwen or Llama 3.1+). | Free, runs on your machine |
| **API keys** | An OpenAI or Anthropic API key. Tick **Remember securely** to keep it between sessions. | Provider API billing |

Then pick a model in the model menu inside the message box. The status bar always
shows the active model. Each mode remembers the model you last chose for it.

## The workspace

- **Conversation panel (right).** Just the chat: the conversation title with the
  current mode, **New chat**, **Timeline** and **History**, the messages and the
  message box.
- **Workspace view (left).** Pages for **Start**, **Plan**, **Build**, **Research**,
  **Rules**, **Activity** and **Connections**. Choosing Start, Plan, Build or
  Research also sets the conversation's mode (Start is Discuss).
- **Editor, files, terminal, Git.** The usual Code OSS tools, all still available.

### Modes

| Mode | The agent can |
| --- | --- |
| **Discuss** | Talk only. It sees just the messages and context you share. |
| **Plan** | Read and search your project (including go-to-definition, references and errors from the editor's language support), fetch web pages, and propose a planning brief with a check for each step. |
| **Build** | Do the work: read, search, create, edit, move and delete files, rename symbols across files, run commands, fetch docs, keep a task checklist and prove plan steps with their checks. |
| **Research** | Read sources you captured and shared, read your browser selection, and suggest pages. |

You can also switch modes with `Alt+1`…`Alt+4` in the conversation, `Ctrl+Alt+M`, or
`/discuss`, `/plan`, `/build`, `/research`. You can chat without opening a project.
Open a folder (**Open a project**) when you want the agent to work on files.

### Sharing context

The chips under **Context for next message** control exactly what the agent sees
besides the chat: the **Current document** (including unsaved changes), your
**Selection**, **Git changes**, **Problems**, your **Planning brief**, captured
research **sources** and imported **attachments**. Highlighted chips are included;
click to toggle, × to remove.

- Type `@` to add a file or folder from the project to your message.
- Paste a screenshot (`Ctrl+V`) to send it with your next message only (PNG, JPEG,
  GIF or WebP up to 5 MB; the model must support images).
- Use the paperclip or `/attach` to import files (they are copied into the
  project's `attachments/` folder).
- The meter next to the model shows how full the model's context window is. Long
  conversations are condensed into a summary automatically; click the meter or use
  `/compact` to do it now. With API keys and ChatGPT, the count comes from the
  provider's own tokenizer.

## Working with the agent

In **Build** mode, describe what you want ("add input validation to the signup form
and run the tests"). The agent explores the project, makes changes and checks its
work. Each action appears in the reply as a step, such as *Read src/app.ts*,
*Edited src/app.ts (+12 −3)* or *Ran npm test (exit 0)*, with the diff or command
output one click away.

### Trust the folder first

The agent only touches files in a folder you trust. If the folder isn't trusted
yet, AI GUI asks when you send your first Build or Plan message; you can also click
**Trust Folder** above the message box. No folder open? Click **Open Folder** there.

### Choose how much it may do on its own

Use the permissions menu above the message box (or `/permissions`):

| Mode | File changes | Commands | Use it when |
| --- | --- | --- | --- |
| **Ask first** | You approve each one | You approve each one | You want to review everything |
| **Auto** (default) | Applied directly inside the project | Run automatically in a sandbox: they can write only to the project and temp folders, with no network access | Everyday work |
| **Full access** | Applied anywhere, no questions | Run with no sandbox | Trusted tasks you are watching |

In every mode except Full access, the agent asks before touching anything outside
the project, secret files (such as `.env` and keys), the `.git` folder, or the web.
If a command needs to leave the sandbox (for example to install packages), it asks
you, with a reason.

When the agent asks, you'll see **Approve**, **Always allow … in this chat**,
**Always allow … in this project** (saved as a rule on the **Rules** page), **Deny**
and, for file changes, **Open Diff** to view the change in the editor.

**Untrusted content.** Once a chat contains a web page the agent fetched, a shared
research source or selection, an attachment or a file from outside the project, a
⚠ *Untrusted content in this chat* chip appears. From then on commands and web
access always ask, even with Full access, saved allow rules and "always allow" are
skipped, and approval cards show where the untrusted content came from. Text on a
web page could try to steer the agent; read those approvals carefully. Start a new
chat to clear it.

### Plan, then prove each step

On the **Plan** page, write a brief with a checklist, or let Plan mode propose one.
Each step can carry a check that proves it is done:

```
- [ ] Parse ISO dates (check: `npm test -- dates`)
- [ ] The settings page shows the new option (check: manual: open Settings)
```

**Build from Plan** works through the unchecked steps. The agent proves each step
with its check; a step with a check is ticked only when its check passes, and the
result (command, exit code and output) is kept on the Plan page. You can run a check
yourself with **Run Check**, or answer a manual one with **Mark Passed** / **Mark
Failed** (or **It Works** / **It Doesn't** when the agent asks in the chat).

### Background tasks

For longer work, start a task in the background: type `/background add tests for
the parser`, use the **Build** page, or **AI GUI: Start Background Task**. The agent
works in a separate Git worktree, a copy of the project as it is now (including
uncommitted and untracked files), while you keep editing. Approvals arrive as
notifications. When it finishes, **Review** shows each changed file, **Apply to
Project** brings the changes into your working tree (nothing is staged or
committed), and **Discard** deletes the worktree. If you changed the same lines in
the meantime, AI GUI asks before merging and marks any conflicts. Background tasks
need a Git repository with at least one commit; up to three run at once.

### Review, revert and rewind

Every reply that changed files ends with a **Changed files** list showing what was
added (A), modified (M) or deleted (D), with line counts.

- Click a file, or **Review**, to open a diff of what the agent changed.
- The ↶ button next to a file puts just that file back as it was before the reply;
  **Revert All** does it for every file in the reply.
- To undo a whole exchange, hover over one of your messages and click ↶ **Rewind to
  here**. That message and everything after it are removed, files the agent changed
  since then are restored, and your message goes back into the box to edit and resend.
- In the editor, each block the agent changed has **Keep** and **Revert** above it,
  so you can undo part of a change without leaving the file.
- **Second Opinion** under the changed files asks another model to review the diff
  for bugs and missed requirements; **Fix These** sends its notes back to the agent.
  Turn on `aiGui.review.automatic` to review every Build reply, and choose the
  reviewer with `aiGui.review.model`.
- The **Timeline** (in the conversation header, or `/timeline`) lists each of your
  messages with the files changed and checks verified since. Click one to jump to
  it, **Compare with Now** to diff every file the agent changed from there, or
  **Restore** to rewind to it. Branches made from a message appear under it.
- If you edited a file after the agent did, AI GUI warns you before overwriting your
  changes.
- Changes made by **commands** the agent ran (for example `npm install`) are not
  tracked and are not undone.
- A multi-file patch is all or nothing: if one file fails, the others are put back.

### Undo and safety

- Edits go through the editor, so **Undo** works and open files update instantly.
- If a file has unsaved changes of yours, the agent's edit lands in the editor but
  is not saved for you.
- Deleted files go to your system trash.
- **Stop** (the square button, or **Escape** in the conversation panel) cancels the
  reply, any running command and any pending approvals.

### Inline edits

Select code in the editor and press `Ctrl+Alt+E` (or right-click → **AI GUI: Inline
Edit Selection**, or `/edit`), then describe the change. The new code appears in place,
highlighted, with the original on hover. **Ctrl+Enter** or **Accept** keeps it,
**Escape** or **Reject** puts the original back, and **Show Diff** compares them. With
no selection, the current line is edited. Inline edits use the active model.

### Replies

Replies are formatted (headings, lists, tables, highlighted code). Code blocks have
**Copy** and **Insert**, which puts the code at the cursor in your current editor
(Undo reverses it). Finished work collapses into one line such as *Worked for 1m 05s ·
15 steps*; click it to see each step. Replies never load remote images or run HTML.

## Research

Switch to **Research**, type a website or a search, and choose **Open Research
Browser**. It opens in a separate, sandboxed window with its own temporary session.

- **Capture Selection** saves highlighted text; **Capture Page** saves the page's
  text, links and image references (up to six sources).
- Capturing never shares anything. Tick **Share with next reply**, or toggle the
  source's chip, to include it (up to three at a time).
- Keyboard: `Ctrl+L` address bar, `Alt+←/→` back and forward, `Ctrl+R` or `F5` reload.
- Each source gets a citation key such as **[S1]** for the whole conversation. The
  agent cites the sources it relies on; cited replies end with a **Sources** list,
  `[S1]` links to the page, and plans you apply get a *Sources* section. Code that
  follows a source gets a `// Source:` comment.

## Costs and usage

- **Per reply:** replies from API-key models show their estimated cost (provider
  token counts at list prices). The message box shows *≈ $x this chat · $y this
  month*.
- **Budget:** set `aiGui.budget.monthlyUsd`; the cost turns amber at 80% and red
  when exceeded. Override prices with `aiGui.pricing` (US dollars per million
  tokens, keyed by model id).
- **Spend:** Connections → **API keys** shows what replies on this device cost today
  and this month, and rate limits the provider reported. API keys cannot read your
  credit balance; to see your organization's month-to-date cost, add an **admin
  key** (OpenAI `sk-admin-…` or Anthropic `sk-ant-admin…`), used only for that.
- **ChatGPT plan:** the message box shows how much of your plan's current window is
  used, as OpenAI reports it.
- ChatGPT, Claude Code and Ollama replies have no per-reply cost in AI GUI.

## Debugging and extensions

**JavaScript and TypeScript** debugging is built in (Node.js, plus Chrome and Edge
if installed). Open a project, then **Run and Debug** in the sidebar, or press
**F5**. Add a `.vscode/launch.json` for custom setups.

For **other languages** (Python, C/C++, Go, Java, Rust and more), install a debugger
from the **Extensions** view. AI GUI uses [Open VSX](https://open-vsx.org), the open
extension registry used by VSCodium; Microsoft's own marketplace isn't available
to editors built from Code OSS. Search for the language (for example **Python
Debugger**) and choose **Install**. The first time you install from a publisher,
you'll be asked whether you trust it.

Extensions run with your user permissions, outside AI GUI's agent sandbox, so
install only ones you trust.

## Commands and shortcuts

Type `/` in the message box for the command list:

| Command | Does |
| --- | --- |
| `/new`, `/resume` | Start a new chat, or reopen a previous one for this project |
| `/discuss`, `/plan`, `/build`, `/research` | Switch mode |
| `/run <command>` | Run your own shell command in the project and show the output |
| `/permissions [ask\|auto\|full]` | Change what the agent may do on its own |
| `/connections` | Open Connections |
| `/history` | Search, open, rename or delete conversations |
| `/build-plan` | Build the shared brief step by step |
| `/compact` | Condense the conversation into a summary now |
| `/background <task>` | Run a Build task in its own Git worktree |
| `/timeline` | Jump to, compare or restore an earlier point |
| `/review` | Second opinion on the last changes |
| `/edit` | Inline edit the selection in the editor |
| `/attach` | Import files as context |
| `/changes` | Show agent and Git changes in Source Control |
| `/workspace` | Show the workspace view |
| `/stop` | Stop the current reply or command |
| `/tour` | Show the Getting started guide again |
| `/keys` | Show and change keyboard shortcuts |
| `/diagnostics` | Copy diagnostics for a bug report |
| `/feedback` | Send feedback |
| `/zoom [in\|out\|reset]` | Make all text larger or smaller |

- **Enter** sends (while the agent works, it queues the message); **Shift+Enter**
  adds a new line; **Escape** stops a running reply.
- `Ctrl+Alt+I` focus the conversation · `Ctrl+Alt+N` new chat · `Ctrl+Alt+H`
  history · `Ctrl+Alt+M` or `Alt+1…4` switch mode · `Ctrl+Alt+W` workspace view ·
  `Ctrl+Alt+.` stop · `Ctrl+Alt+Enter` / `Ctrl+Alt+Backspace` approve / deny ·
  `Ctrl+Alt+E` inline edit. Change them with `/keys`.
- **Text size:** AI GUI starts at 120% zoom. Use **Text size A− / A+** at the top of
  the workspace page, `/zoom`, or `Ctrl+=` / `Ctrl+-` to adjust it.
- The **Ask / Run** switch in the message box toggles between talking to the agent
  and running your own commands.
- Resuming a chat restores its messages, brief, sources and attachments; shared
  context and pending approvals start fresh.

## Tips

- **Be specific about done.** "Fix the failing date test and run `npm test`" works
  better than "fix the tests".
- **Start big tasks in Plan.** Let the agent read the code and propose a brief, edit
  the brief yourself, then switch to Build and share the brief.
- **Use Ask first in unfamiliar projects.** Switch to Auto once you are comfortable.
- **Keep Full access short-lived.** Turn it on for a specific task, then switch back.
- **Share only what helps.** Context chips keep prompts small and focused.
- **Use the terminal for interactive tools.** The agent's commands can't answer
  prompts; long-running servers belong in the editor's terminal.
- **Commit before large changes**, so `git diff` shows exactly what the agent did.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| The agent says it has no file or command tools | Make sure you're in **Build** mode, a folder is open, and it is trusted (**Trust Folder** above the message box). |
| Commands fail with "Permission denied" or network errors in Auto mode | That's the sandbox. Let the agent retry with escalation and approve it, or switch to Ask first or Full access for that task. |
| "no sandbox" next to the project name | AI GUI couldn't build or start its sandbox (it needs a C compiler and a recent Linux kernel). In Auto mode, commands will ask for approval instead. |
| Claude sign-in finished but nothing changed | Open Connections and choose **Refresh Connections**. |
| "Remember securely" is greyed out | Your system has no unlocked keychain; keys last for the current session only. |
| An Ollama model never uses tools | The model doesn't support tool calling; choose one that does. |
| Send is disabled | Pick a model in the message box, or open Connections. |
| "Background tasks need the project to be a Git repository" | Run `git init` and make a first commit, or use the normal conversation. |
| A local model forgets earlier messages | Ollama requests use a 16k-token context window; long chats are condensed. Pick a model with a larger context for long tasks. |
| Inline edit says the file changed | You typed while the model worked; run the edit again. |
| Something else went wrong | **Copy Diagnostics** (Start page or `/diagnostics`) copies versions, settings and recent errors without conversation text or keys. **Send Feedback** opens a report you can check before sending. **AI GUI: Show Log** opens the log. |
| Run and Debug says "All debug extensions are disabled" | The built-in debugger wasn't downloaded. Run `node scripts/setup.mjs extensions-debug builtin-extensions` in `prototypes/code-oss`, then restart. |

## License and notices

AI GUI is private software in preview. Code OSS and other third-party components
keep their own licenses and notices.
