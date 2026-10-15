# Data usage and privacy

Furnace runs entirely on your computer. There is no Furnace server, account or
cloud service, so we (the developers) never receive your prompts, files, API keys
or AI-provider sign-ins. This page explains what the app does with your data and
where it lives.

## In short

- **We never see or store your credentials.** API keys and sign-in tokens stay on
  your device, used only to talk directly to the provider you chose.
- **Your conversations stay on your computer.** They are saved as local files in
  your Furnace profile, not uploaded anywhere except to the AI provider you are
  chatting with, as part of the conversation.
- **No telemetry or analytics.** Furnace collects no usage data, and its launcher
  turns off the editor's built-in telemetry and update checks. The only other
  network use is what you trigger: the Extensions view (Open VSX), the research
  browser, and web pages the agent fetches, plus a model-list check with the
  providers you already connected and, only in builds that name one, a daily
  update check (see below).

## What is sent to AI providers

When you send a message, Furnace sends it **directly from your computer** to the
provider behind the model you picked (OpenAI, ChatGPT, Anthropic, Claude Code or
your local Ollama). A request contains:

- recent messages in the current conversation;
- context you explicitly shared: the current document, your selection, Git changes,
  Problems, the planning brief, research sources or attachments (each controlled by
  a chip above the message box), files and folders you added with `@`, and images
  you pasted (sent with that one message only);
- in Plan, Build and Research modes, the results of tools the AI used during that
  reply (for example, the contents of a file it read or a command's output).

Some features send the same kind of content in extra requests to a model you chose:

- **Token counts.** With API keys and ChatGPT, Furnace asks the provider's
  token-counting endpoint how large the next request would be (the same messages,
  context and tool list), so the context meter is accurate. No reply is generated.
- **Summaries.** When a conversation gets long, older messages are sent to the same
  model to be condensed into a summary.
- **Second opinion.** A review sends your request, the agent's summary and the diff
  of the files it changed to the reviewing model (the same model unless you set
  `aiGui.review.model`).
- **Inline edits** send the selected code, the instruction and up to about 60 lines
  around it.
- **Background tasks** work like Build replies, on a copy of the project.
- **Autocompute** (when you tick it): your online model also receives a short profile
  of your local Ollama models (name, size and their record on this machine) and, for each
  task it delegates, the local model's summary, the check's output and the diff. The task
  itself runs on your local model (`127.0.0.1`), so its file reads stay on your machine.

Nothing is shared just because it is open or captured. Each provider handles that
data under its own terms and privacy policy. API-key use is billed by the provider;
ChatGPT sign-in uses your ChatGPT plan; Claude Code uses its own account and billing.
Furnace never switches you to a different paid route automatically.

Local models through Ollama run on your machine; requests go to Ollama's local
address (`127.0.0.1`).

To have your connections ready, Furnace checks them when it starts, when you open a
different folder and when you refresh Connections: it asks each provider you have
connected (a remembered API key or ChatGPT account) for its list of models, asks your
installed Claude Code whether it is signed in, and looks for Ollama on your machine.
These checks send no conversation data.

## Credentials

| Connection | What Furnace keeps | Where |
| --- | --- | --- |
| OpenAI / Anthropic admin key (optional) | Same as API keys. Used only to read your organization's cost report for the spend display; never for chats. | Same as API keys |
| OpenAI / Anthropic API key | By default, held in memory for the current session only. If you tick **Remember securely on this device**, it is encrypted with your operating system's keychain (Electron safeStorage) before being written. | A separate local connection process; encrypted files in your profile |
| ChatGPT sign-in | Sign-in happens in your browser with OpenAI. Access tokens are held in memory, or encrypted with your keychain if you chose to remember the account. The account email and the app's registration ID are saved so you can reconnect. | Same as above |
| Claude Code | **Nothing.** Furnace runs your installed Claude Code, which keeps its own sign-in. Furnace never reads or copies Claude credentials. | Managed by Claude Code |
| Ollama | Nothing. | — |

- Keys and tokens are never written into your projects, conversations or logs, and
  are never shown back to the interface.
- If your system has no secure keychain, "remember" is unavailable and keys last
  only until you close the app.
- **Disconnect** deletes the stored key from your device; it does not revoke the key
  with the provider. **Sign Out** for ChatGPT also asks OpenAI to revoke the session.

## What is stored on your computer

All app data lives in your Furnace profile folder (by default
`prototypes/code-oss/.profile/` in the Furnace folder, or the folder set by
`AI_GUI_CODE_OSS_PROFILE`), under
`user-data/User/globalStorage/ai-gui.workspace-product/`:

- `conversations/`: your chats, planning briefs, captured research text and
  attachment snapshots, saved as **unencrypted** JSON files. Treat them like any
  other document on your disk.
- `conversations/checkpoints/`: for each reply in which the agent changed files, a
  copy of those files' contents before and after the change (unencrypted), so you
  can review, revert or rewind them. The newest 60 replies per conversation are kept.
  These copies can include anything in the files the agent edited.
- `conversations/settings/permissions.json`: the allow and deny rules you saved,
  per project.
- `conversations/settings/autocompute.json`: whether Autocompute is on, and each local
  model's recent results per kind of task (accepted, accepted after revision, taken over),
  plus the online model's one-time assessment of it (Ollama's size, family and abilities,
  and a confidence score per kind of task).
- `themes/`: your saved themes (`themes.json`) and copies of the pictures you chose for
  theme backgrounds (`pictures/`). Which theme each project uses is kept in the editor's own
  storage in the same profile. Themes use no network: exported `.furnace-theme` files
  (including their picture) are written only where you save them.
- `conversations/settings/spend.json`: daily dollar totals per provider for
  API-key replies (amounts only, no content), kept for about 400 days.
- `conversations/audit/`: the activity log for each project: titles of the agent's
  steps (for example the commands it ran and files it changed), how each was
  allowed, your approvals, reverts and rules. Up to 5 MB per project; clear it on
  the **Activity** page.
- `background/`: background tasks. `worktrees/` holds a Git worktree for each task,
  a **full copy of your project** (including uncommitted and untracked files) that
  the task changes; it is deleted when you discard the task. `tasks.json` lists the
  tasks and their summaries.
- `connections/`: encrypted remembered keys and ChatGPT account information.

Other data:

- **Attachments** are copied into the open project's `attachments/` folder (your
  original files are never moved). Check that folder before committing a project
  to version control.
- **Editor settings** and window state are stored by the editor in the same profile.

To remove everything, close Furnace and delete the profile folder. To remove only
credentials, use Disconnect / Sign Out, or delete the `connections/` folder.

## When the AI works on your files

In Build mode, the AI can read, create, edit, move and delete files and run
commands. This all happens on your computer, through the editor, under the
permission mode you choose:

- **Ask first**: every change, command and web fetch waits for your approval.
- **Auto**: changes inside the open project apply directly, and commands run in a
  sandbox that can only write to the project and temporary folders and cannot use
  the network. Anything else asks first.
- **Full access**: no approvals and no sandbox. Use it only for trusted work you are
  watching.

File tools are only available in a folder you have trusted. Deleted files go to
your system trash when available. Web pages the AI fetches are requested from your
computer, and only with your approval unless you chose Full access.

## Updates, diagnostics and feedback

- **Update check.** Only when a build names an update feed (development builds do
  not), Furnace downloads that feed once a day to see whether a newer version exists.
  The request carries nothing but the usual HTTP headers. Turn it off with
  `aiGui.updates.check`. Updates are never installed automatically.
- **Copy Diagnostics** puts versions, settings, connection states and recent log
  lines on your clipboard, with your home folder, email addresses and keys removed.
  It contains no conversation text or file contents.
- **Send Feedback** opens your message (and diagnostics if you choose) in your
  browser or email app, or copies it, so you can read it before sending. Nothing is
  sent by Furnace itself.

## Research browser

The research browser runs in a separate window with a temporary session: cookies
and site data are discarded when it closes, downloads and site permissions are
blocked, and websites cannot reach your files. Searches typed into the address bar
go to DuckDuckGo. Captured text stays local until you share it with a conversation.

## Extensions

Furnace is built on Code OSS (the open-source core of Visual Studio Code). The
Extensions view searches and downloads extensions from [Open VSX](https://open-vsx.org)
(run by the Eclipse Foundation), which sees those requests. The built-in JavaScript
debugger is downloaded once from its GitHub release during setup and checked against
a pinned fingerprint. Editor extensions you install yourself run with your user
permissions and follow their own data practices.
