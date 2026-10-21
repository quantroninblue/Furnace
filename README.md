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

Welcome to Furnace. You and an AI agent work on the same project: talk an idea through,
research it, turn it into a plan, and let the agent build it, reading code, editing files
and running commands, while you decide how much it may do on its own.

Furnace is built on Code OSS, the open-source core of Visual Studio Code, so the editor,
terminals, Git, debugger and extensions you already know are all there too.

## Get Furnace

Download the latest version for macOS (Apple Silicon) or Windows (x64) from the
[Releases page](https://github.com/quantroninblue/Furnace/releases/latest). From then on,
Furnace tells you when a new version is out and installs it for you.

## Start with the tutorial

We recommend going through the tutorial first. It takes a few minutes, walks you around
every part of the window and opens each feature for you as it goes. It's offered the
first time you open Furnace, and you can take it again any time from **Furnace → Begin
Tutorial** or by typing `/tour` in the message box.

## What makes Furnace different

**One conversation, every model.** Use your ChatGPT plan, Claude Code, an OpenAI or
Anthropic API key, or local models through Ollama, and switch between them in the middle
of a conversation. The chat, your plan, research sources and the context you shared all
come along, so every model picks up exactly where the last one left off.

**Autocompute: your local models do the small jobs.** Tick **Autocompute** and your
online model leads the work while handing small, well-defined tasks (unit tests, small
edits, renames, docs) to the models running on your own machine. It reviews their work
before accepting it. Furnace learns what each local model is good at and gives every task
to the smallest one that can handle it, saving your online usage for the hard parts.

**Jump between versions of your code, right from the chat.** Every reply that changes
files is saved as a checkpoint. Open the **Timeline** to jump to any earlier message,
compare your project with how it was then, or restore it. Revert a single file or a whole
reply, or rewind the conversation and edit what you asked. Experiment freely.

**Plans that prove themselves.** Write a plan, or let the agent draft one, with a check
for each step: a test, a command, or something you confirm. The agent works through it
and ticks a step off only when its check passes, keeping the output as proof.

**A second opinion before you keep anything.** Ask another model to review the agent's
changes for bugs and missed requirements, then send its notes back with **Fix These**.

**You set the limits.** **Ask first** to approve every change and command, **Auto** for
everyday work, **Full access** for trusted tasks. When content from the web enters the
chat, Furnace asks before every command, whatever the mode.

**Research with sources.** Browse in a separate, private research window, capture what
matters and share it with the agent. Answers cite their sources, all the way into your
plan and code comments.

**Work in parallel.** Hand a task to a background agent that works in its own copy of
your project while you keep coding, then review and apply its changes.

**Make it yours.** Eight built-in themes, or design your own with gradients, pictures,
glass panels and drifting embers.

## Your data stays yours

- **No Furnace account, no server, no telemetry.** We never receive your prompts, files,
  keys or sign-ins.
- **Only what you send leaves your computer**, and only to the model you chose.
- **Your accounts, your billing.** Furnace never switches accounts or falls back to paid
  billing on its own, and API replies show what they cost.
- **Conversations, rules and checkpoints stay on your device.** With a local Ollama model,
  nothing leaves your machine at all.

Read exactly what is sent and stored in [DATA_USAGE.md](DATA_USAGE.md).

## Get going

1. **Connect a model.** Open **Connections** (click the model name in the status bar, or
   type `/connections`) and choose **ChatGPT**, **Claude** (uses your installed
   [Claude Code](https://code.claude.com)), **Local** ([Ollama](https://ollama.com) with
   a tool-calling model such as Qwen) or **API keys**.
2. **Open a project** and click **Trust Folder** so the agent can work on its files.
3. **Pick a mode and describe the task.** **Discuss** to talk it through, **Plan** to
   draft a plan, **Build** to do the work, **Research** to work from sources. For example:
   *"Add input validation to the signup form and run the tests."*

The full user guide is in **Furnace → Help**, or here as [GUIDE.md](GUIDE.md).

## What's next

Furnace is growing, and we're planning more features. If there's something you'd love to
see, use **Send Feedback** (or type `/feedback`) and tell us.

## License

Furnace is released under the [MIT License](LICENSE). Code OSS and other third-party
components keep their own licenses and notices.
