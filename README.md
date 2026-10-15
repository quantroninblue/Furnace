# Furnace

```
███████╗██╗   ██╗██████╗ ███╗   ██╗ █████╗  ██████╗███████╗
██╔════╝██║   ██║██╔══██╗████╗  ██║██╔══██╗██╔════╝██╔════╝
█████╗  ██║   ██║██████╔╝██╔██╗ ██║███████║██║     █████╗
██╔══╝  ██║   ██║██╔══██╗██║╚██╗██║██╔══██║██║     ██╔══╝
██║     ╚██████╔╝██║  ██║██║ ╚████║██║  ██║╚██████╗███████╗
╚═╝      ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═══╝╚═╝  ╚═╝ ╚═════╝╚══════╝
```

**The AI coding workspace where you stay in charge.**

Furnace puts you and an AI agent on the same project. Talk an idea through, research it,
turn it into a plan, and let the agent build it: reading code, editing files and running
commands, while you decide how much it may do on its own. Every change can be reviewed,
reverted or rewound.

It's built on Code OSS, the open-source core of Visual Studio Code, so the editor,
terminals, Git, debugger and extensions you already know are all there.

## Why Furnace

**Plan it, build it, prove it.** Write a plan, or let the agent draft one, with a check
for every step: a test, a command or something you confirm yourself. The agent works
through the plan and ticks a step off only when its check passes, keeping the output as
proof.

**Your models, your accounts.** Use your ChatGPT plan, Claude Code, an OpenAI or Anthropic
API key, or local models through Ollama. Furnace never switches accounts or falls back to
paid billing on its own, and every API reply shows what it cost.

**Spend less with Autocompute.** Your online model leads and hands small, well-defined
tasks (unit tests, small edits, renames, docs) to your local models, then reviews their
work. Furnace learns which local model handles what, and gives each task to the smallest
one that can do it well.

**You set the limits.** Choose **Ask first** to approve every change and command,
**Auto** for everyday work, or **Full access** for trusted tasks. On macOS and Linux,
Auto runs commands in a sandbox that can't touch the rest of your computer or the
network. When web content enters the chat, Furnace asks before every command, whatever
the mode.

**Undo anything.** Every reply that changes files is checkpointed. Revert one file, a whole
reply, or rewind the conversation to any earlier message. Ask a second model to review
the changes before you keep them.

**Research with sources.** Browse in a separate, private research window, capture what
matters, and share it with the agent. Answers cite their sources, all the way into your
plan and your code comments.

**Work in parallel.** Hand a task to a background agent that works in its own copy of
the project while you keep coding, then review and apply its changes.

**Make it yours.** Eight built-in themes, or create your own with gradients, pictures,
glass panels and drifting embers.

## Your data stays yours

- **No Furnace account, no server, no telemetry.** We never receive your prompts, files,
  keys or sign-ins.
- **Only what you send leaves your computer**, and only to the model you chose.
- **Conversations, rules and checkpoints stay on your device.** With a local Ollama model,
  nothing leaves your machine at all.

Read exactly what is sent and stored in [DATA_USAGE.md](DATA_USAGE.md).

## Download

| Platform | Get it |
| --- | --- |
| **macOS** (Apple Silicon, macOS 13 or later) | [Download for macOS](https://github.com/quantroninblue/Furnace/releases/latest) |
| **Windows** (Windows 10 or 11, 64-bit) | [Download for Windows](https://github.com/quantroninblue/Furnace/releases/latest) |
| **Linux** (x86-64) | [Build from source](#build-from-source-on-linux) |

### Install on macOS

1. Open `Furnace-darwin-arm64.dmg` and drag **Furnace** into **Applications**.
2. Open Furnace. The first time, macOS asks you to confirm an app downloaded from the
   internet: click **Done**, open **System Settings → Privacy & Security**, scroll down
   to Furnace and click **Open Anyway**.
3. When you first save a sign-in or API key, click **Always Allow** so Furnace can keep it
   in your keychain.

### Install on Windows

1. Run `FurnaceUserSetup-x64.exe`. It installs for your user account; no administrator
   rights needed.
2. If Windows SmartScreen appears, click **More info**, then **Run anyway**.
3. Install [Git for Windows](https://git-scm.com/download/win) as well, so the agent can
   run commands in Git Bash.

### Build from source on Linux

You need Git, Python 3, a C/C++ compiler (`build-essential`), `pkg-config` and about
10 GB of free disk space. From a clone of this repository:

```sh
# 1. Node.js 24.18.0, kept inside the project
mkdir -p prototypes/code-oss/.cache
curl -fsSL https://nodejs.org/dist/v24.18.0/node-v24.18.0-linux-x64.tar.xz \
  | tar -xJ -C prototypes/code-oss/.cache

# 2. The Code OSS source
git clone --depth 1 --branch 1.140.0 https://github.com/microsoft/vscode.git \
  prototypes/code-oss/upstream

# 3. Native libraries (Ubuntu 24.04; installs nothing system-wide).
#    Skip if you already have the -dev packages.
node prototypes/code-oss/scripts/prepare-native.mjs

# 4. Build the editor core, one stage at a time (this takes a while)
node prototypes/code-oss/scripts/run.mjs npm ci --ignore-scripts --no-audit --no-fund
cd prototypes/code-oss
node scripts/setup.mjs build-tools
node scripts/setup.mjs headers electron native transpile
node scripts/setup.mjs extensions extensions-startup extensions-json extensions-markdown
node scripts/setup.mjs extensions-debug builtin-extensions
cd ../..

# 5. Build and start Furnace
npm ci
npm run build
npm start
```

After that, `npm start` opens Furnace (run `npm run build` first after pulling changes).

## Get started

1. **Connect a model.** Open **Connections** (the model name in the status bar, or type
   `/connections`) and choose **ChatGPT**, **Claude** (needs
   [Claude Code](https://code.claude.com) installed), **Local** (needs
   [Ollama](https://ollama.com) with a tool-calling model such as Qwen) or **API keys**.
2. **Open a project.** Open a folder and click **Trust Folder** so the agent can work on
   its files.
3. **Pick a mode and describe the task.** **Discuss** to talk it through, **Plan** to
   draft a plan with checks, **Build** to do the work, **Research** to work from sources.
   For example: *"Add input validation to the signup form and run the tests."*

The first time you open Furnace, a short tutorial shows you around. Take it again any time
from **Furnace → Begin Tutorial**.

## Learn more

- **[User guide](GUIDE.md)**: modes, permissions, checkpoints, Autocompute, background
  tasks, research, themes, commands and troubleshooting. Also inside Furnace under
  **Furnace → Help**.
- **[Data and privacy](DATA_USAGE.md)**: what Furnace sends, to whom, and what it stores.

## License

Furnace is released under the [MIT License](LICENSE). Code OSS and other third-party
components keep their own licenses and notices.
