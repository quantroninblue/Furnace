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

Privacy: see [DATA_USAGE.md](DATA_USAGE.md). In short, everything stays on your
computer and your keys and sign-ins are never sent to us.

## Contents

- [Set up](#set-up)
- [Connect a model](#connect-a-model)
- [The workspace](#the-workspace)
- [Working with the agent](#working-with-the-agent)
- [Research](#research)
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
command palette (`Ctrl+Shift+P`).

## Connect a model

Open **Connections** with the plug icon in the conversation panel, the model name
in the status bar, or by typing `/connections`. Choose a tab:

| Tab | What you need | Billing |
| --- | --- | --- |
| **ChatGPT** | A ChatGPT account. Choose **Continue with ChatGPT** and finish sign-in in your browser. | Your ChatGPT plan |
| **Claude** | [Claude Code](https://code.claude.com) 2.1.248 or newer installed. Choose **Sign In with Claude Code**, finish in the terminal that opens (paste the browser code there if asked); connections refresh by themselves. If Claude Code is already signed in, it connects automatically when the app starts. | Your Claude account |
| **Local** | [Ollama](https://ollama.com) running with a model installed. For agent work, pick a model that supports tool calling (for example Qwen or Llama 3.1+). | Free, runs on your machine |
| **API keys** | An OpenAI or Anthropic API key. Tick **Remember securely** to keep it between sessions. | Provider API billing |

Then pick a model in the model menu inside the message box. The status bar always
shows the active model.

## The workspace

- **Conversation panel (right).** Your chat with the agent. At the top: the
  conversation title, **New chat**, **Resume chat**, **Connections** and **Open
  workspace** buttons, and the four modes.
- **Workspace page (centre).** The welcome screen, your **Plan** brief, the **Build**
  overview, the **Research** desk and **Connections**.
- **Editor, files, terminal, Git.** The usual Code OSS tools, all still available.

### Modes

| Mode | The agent can |
| --- | --- |
| **Discuss** | Talk only. It sees just the messages and context you share. |
| **Plan** | Read and search your project, fetch web pages, and propose a planning brief for you to apply. |
| **Build** | Do the work: read, search, create, edit, move and delete files, run commands, fetch docs and keep a task checklist. |
| **Research** | Read sources you captured and shared, read your browser selection, and suggest pages. |

You can chat without opening a project. Open a folder (**Open a project**) when you
want the agent to work on files.

### Sharing context

The chips under **Context for next message** control exactly what the agent sees
besides the chat: the **Current document** (including unsaved changes), your
**Planning brief**, captured research **sources** and imported **attachments**.
Highlighted chips are included; click to toggle, × to remove. Use the paperclip or
`/attach` to import files (they are copied into the project's `attachments/` folder).

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
**Deny** and, for file changes, **Open Diff** to view the change in the editor.

### Review, revert and rewind

Every reply that changed files ends with a **Changed files** list showing what was
added (A), modified (M) or deleted (D), with line counts.

- Click a file, or **Review**, to open a diff of what the agent changed.
- The ↶ button next to a file puts just that file back as it was before the reply;
  **Revert All** does it for every file in the reply.
- To undo a whole exchange, hover over one of your messages and click ↶ **Rewind to
  here**. That message and everything after it are removed, files the agent changed
  since then are restored, and your message goes back into the box to edit and resend.
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
| `/attach` | Import files as context |
| `/workspace` | Show the workspace page |
| `/stop` | Stop the current reply or command |
| `/tour` | Show the Getting started guide again |
| `/zoom [in\|out\|reset]` | Make all text larger or smaller |

- **Enter** sends; **Shift+Enter** adds a new line; **Escape** stops a running reply.
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
| Run and Debug says "All debug extensions are disabled" | The built-in debugger wasn't downloaded. Run `node scripts/setup.mjs extensions-debug builtin-extensions` in `prototypes/code-oss`, then restart. |

## License and notices

AI GUI is private software in preview. Code OSS and other third-party components
keep their own licenses and notices.
