# Furnace user guide

Everything you can do in Furnace, from connecting a model to undoing an agent's changes.
What Furnace sends and stores is described in [DATA_USAGE.md](DATA_USAGE.md).

## First launch

On first launch, a welcome card asks whether you'd like the **tutorial**: a short tour
that points at each part of the window (the chat, the Workspace pages, the message box,
Source Control, the editor and the menus) and opens them for you. Use **Next** and
**Back** or the arrow keys; **End Tutorial** or Escape stops it. Choose **Not Now** to
skip it, and tick **Don't show this again** to stop the card appearing.

The **Furnace** menu in the top bar has **Begin Tutorial**, to take the tour again, and
**Help**, which opens this guide and the data usage page inside Furnace, with search.
You can also type `/tour` or `/help` in the message box.

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
yet, Furnace asks when you send your first Build or Plan message; you can also click
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

### Autocompute: save online usage with local models

Tick **Autocompute** next to the permissions menu (Build mode, or `/autocompute on`) to
have your online model (ChatGPT, Claude or an API key) lead and hand small tasks to
local Ollama models. The online model plans the work and keeps the difficult parts. It
gives a local model one precisely described task at a time: a unit test, a small edit in
one or two files, a rename, docs. Each local task runs in its own small context with only
file tools. Furnace runs the task's check, and the online model reviews the diff:
**accept**, **revise** (sent back with notes, at most twice) or **take over** (it finishes
the task itself).

- It works with whatever tool-capable models you have in Ollama. The first time it meets a
  local model, the online model assesses it once from its size, family and abilities and
  gives it a confidence score for each kind of task. Furnace keeps the assessment (until
  the model changes or you reset), so later replies spend no tokens re-checking. For each
  task the online model only rates its difficulty; Furnace works out every model's
  confidence from the assessment, its record and the difficulty, and hands the task to the
  smallest (fastest) model that reaches 50, so bigger, slower models only get tasks the
  smaller ones can't take. When none reaches 50, the online model keeps the task. The card
  shows the scores.
- Furnace refuses kinds of task a model hasn't proven it can do. Once a model has 3 or more results for
  a kind and fewer than half were accepted, that kind stays with the online model.
  `/autocompute reset` clears every record and assessment so models are assessed again and
  earn their tasks again.
- A **Delegated to local models** card on the reply shows each task, its check, the
  verdict and the local tokens used. Steps a local model ran are labelled with its name.
- Local work uses none of your online usage, but the online model still spends tokens
  on planning and reviews. Local models are slower; small, checkable tasks pay off most.
- You need an online model selected and an Ollama model with tool calling (for example
  `qwen3`). Approvals, sandbox, checkpoints and Revert work as usual for local edits.

### Background tasks

For longer work, start a task in the background: type `/background add tests for
the parser`, use the **Build** page, or **Furnace: Start Background Task**. The agent
works in a separate Git worktree, a copy of the project as it is now (including
uncommitted and untracked files), while you keep editing. Approvals arrive as
notifications. When it finishes, **Review** shows each changed file, **Apply to
Project** brings the changes into your working tree (nothing is staged or
committed), and **Discard** deletes the worktree. If you changed the same lines in
the meantime, Furnace asks before merging and marks any conflicts. Background tasks
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
- If you edited a file after the agent did, Furnace warns you before overwriting your
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

Select code in the editor and press `Ctrl+Alt+E` (or right-click → **Furnace: Inline
Edit Selection**, or `/edit`), then describe the change. The new code appears in place,
highlighted, with the original on hover. **Ctrl+Enter** or **Accept** keeps it,
**Escape** or **Reject** puts the original back, and **Show Diff** compares them. With
no selection, the current line is edited. Inline edits use the active model.

### Replies

Replies are formatted (headings, lists, tables, highlighted code). Code blocks have
**Copy** and **Insert**, which puts the code at the cursor in your current editor
(Undo reverses it). Finished work collapses into one line such as *Worked for 1m 05s ·
15 steps*; click it to see each step. Replies never load remote images or run HTML.

When a model shares its reasoning (local Ollama models do), a **Reasoning** block shows it as
it thinks and collapses once the answer starts. If a Build reply marks its tasks done without
changing a file or running a command, Furnace sends the model back once to do the work, and
warns you on the reply if it still didn't.

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
- ChatGPT, Claude Code and Ollama replies have no per-reply cost in Furnace.

## Themes

The **Themes** menu in the top bar changes how Furnace looks. Pick one of the **Presets**
(Furnace Charcoal, Ember, Forge, Midnight, Synthwave, Forest, Paper, High Contrast),
**Surprise Me** for a random readable theme, or **Create a Custom Theme…**. You can also
type `/theme`, `/theme midnight` or `/theme new`.

A theme has six parts you can mix and match. On the custom theme page, every part has
**Use from theme…** to copy it from another theme.

| Part | Changes |
| --- | --- |
| **Background** | Behind the side bars, the panel area, the status bar and the menus: a solid colour, a gradient or a picture (yours, or one of the included ones; PNG, JPEG, GIF, WebP or SVG up to 10 MB, animated too). Pictures and gradients show through the panels, which are dimmed automatically so text stays readable (or set the dim yourself). Options: **glass panels** (blurred) and the **ember effect** (drifting sparks or a slow glow; it pauses while you type and stays still if your system asks for reduced motion). |
| **Font** | Text outside the code: menus, side bars, the chat, Workspace and Help. Inter, Nunito and Atkinson Hyperlegible Next are included; fonts installed on your computer are listed too. |
| **Font colour** | The main and secondary colours of that text. |
| **Editor font colour** | The code's syntax colours: Charcoal, Midnight Purple, Arctic, Daylight, or any colour theme you installed. |
| **Editor colour** | The code editor's background and the tabs above it (solid colours only). |
| **Accent** | Buttons, focus rings, links and tutorial bubbles. |

The code editor's own font and size never change. Changes show in the window as you make
them; **Save Theme** keeps them (under **My Themes**) and **Cancel** puts the previous theme
back. The **Readability** list checks each pair of colours and offers **Fix** when text
would be hard to read.

- **Use for This Project** keeps the current theme for the open folder, so two windows are
  easy to tell apart. Choosing another theme while it's on changes only that project.
- **Day and Night…** picks a night theme shown while your system is in dark mode.
- **Agent Glow** makes the chat panel glow softly: in the accent colour while the agent
  works, amber when it waits for you, red after an error.
- **Export Current Theme…** saves a `.furnace-theme` file (with its picture);
  **Import Theme…** adds one.

A theme changes only this window's look: nothing is written to your editor settings
apart from the theme's name. A theme appears a moment after the window opens.

## Debugging and extensions

**JavaScript and TypeScript** debugging is built in (Node.js, plus Chrome and Edge
if installed). Open a project, then **Run and Debug** in the sidebar, or press
**F5**. Add a `.vscode/launch.json` for custom setups.

For **other languages** (Python, C/C++, Go, Java, Rust and more), install a debugger
from the **Extensions** view. Furnace uses [Open VSX](https://open-vsx.org), the open
extension registry used by VSCodium; Microsoft's own marketplace isn't available
to editors built from Code OSS. Search for the language (for example **Python
Debugger**) and choose **Install**. The first time you install from a publisher,
you'll be asked whether you trust it.

Extensions run with your user permissions, outside Furnace's agent sandbox, so
install only ones you trust.

## Updates

Furnace checks once a day whether a newer version is out (turn it off with the
`aiGui.updates.check` setting, or check now with **Furnace: Check for Updates**). When
there is one, a notification offers **Update**, **Release Notes** and **Skip This
Version**.

**Update** downloads the new version and checks that it is genuine before using it. Then
choose **Restart Now** to install it and reopen Furnace, or **Later** to install it the
next time you quit. Your settings, conversations and connections stay as they are.

- **macOS:** keep Furnace in your Applications folder; Furnace can't update a copy
  running from the disk image. After an update, macOS may ask once more whether
  Furnace may use its keychain item; choose **Always Allow**.
- **Windows:** the update runs the Furnace installer in the background once Furnace
  closes, keeping the options you chose when you installed it.

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
| `/autocompute [on\|off\|reset]` | Let your online model delegate small Build tasks to local models; reset clears their records |
| `/background <task>` | Run a Build task in its own Git worktree |
| `/timeline` | Jump to, compare or restore an earlier point |
| `/review` | Second opinion on the last changes |
| `/edit` | Inline edit the selection in the editor |
| `/attach` | Import files as context |
| `/changes` | Show agent and Git changes in Source Control |
| `/workspace` | Show the workspace view |
| `/stop` | Stop the current reply or command |
| `/tour` | Take the tutorial again |
| `/help` | Open Furnace Help (this guide and data usage) |
| `/keys` | Show and change keyboard shortcuts |
| `/diagnostics` | Copy diagnostics for a bug report |
| `/feedback` | Send feedback |
| `/theme [name\|new]` | Choose a theme, or create your own |
| `/zoom [in\|out\|reset]` | Make all text larger or smaller |

- **Enter** sends (while the agent works, it queues the message); **Shift+Enter**
  adds a new line; **Escape** stops a running reply.
- `Ctrl+Alt+I` focus the conversation · `Ctrl+Alt+N` new chat · `Ctrl+Alt+H`
  history · `Ctrl+Alt+M` or `Alt+1…4` switch mode · `Ctrl+Alt+W` workspace view ·
  `Ctrl+Alt+.` stop · `Ctrl+Alt+Enter` / `Ctrl+Alt+Backspace` approve / deny ·
  `Ctrl+Alt+E` inline edit. Change them with `/keys`.
- **Text size:** Furnace starts at 120% zoom. Use **Text size A− / A+** at the top of
  the workspace page, `/zoom`, or `Ctrl+=` / `Ctrl+-` to adjust it.
- **Window opacity:** the window is very slightly see-through. Change it with
  **Display → Window Opacity…** or the `aiGui.window.opacity` setting (0.5–1; 1 is
  solid). It works on Linux with X11 and a compositing window manager.
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
| "no sandbox" next to the project name | Furnace couldn't build or start its sandbox (on Linux it needs a C compiler and a recent kernel). In Auto mode, commands will ask for approval instead. |
| Claude sign-in finished but nothing changed | Open Connections and choose **Refresh Connections**. |
| "Remember securely" is greyed out | Your system has no unlocked keychain; keys last for the current session only. |
| "… doesn't support tool calling" | That local model can't use tools, which Plan, Build and Research need. Choose one that does (for example Qwen or Llama 3.1+), or use Discuss. |
| "Autocompute is on, but …" | Autocompute needs an online model selected and a local Ollama model with tool calling. Choose one, refresh Connections, or untick Autocompute. |
| "… can't see images" | That model is text-only. Choose a vision model (for example `qwen3-vl`) for screenshots. The agent can't open image files from the project; paste them into the message box instead. |
| Send is disabled | Pick a model in the message box, or open Connections. |
| "Background tasks need the project to be a Git repository" | Run `git init` and make a first commit, or use the normal conversation. |
| A local model forgets earlier messages | Ollama requests use a 16k-token context window; long chats are condensed. Pick a model with a larger context for long tasks. |
| Inline edit says the file changed | You typed while the model worked; run the edit again. |
| "Furnace couldn't update itself" | Choose **Download Instead** and install the new version from the Releases page. On macOS, move Furnace to Applications first if it says it is running from the disk image or a temporary copy. |
| Something else went wrong | **Copy Diagnostics** (Start page or `/diagnostics`) copies versions, settings and recent errors without conversation text or keys. **Send Feedback** opens a report you can check before sending. **Furnace: Show Log** opens the log. |
| Run and Debug says "All debug extensions are disabled" | The built-in debugger wasn't downloaded. Run `node scripts/setup.mjs extensions-debug builtin-extensions` in `prototypes/code-oss`, then restart. |
