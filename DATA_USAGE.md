# Data usage and privacy

AI GUI runs entirely on your computer. There is no AI GUI server, account or
cloud service, so we (the developers) never receive your prompts, files, API keys
or AI-provider sign-ins. This page explains what the app does with your data and
where it lives.

## In short

- **We never see or store your credentials.** API keys and sign-in tokens stay on
  your device, used only to talk directly to the provider you chose.
- **Your conversations stay on your computer.** They are saved as local files in
  your AI GUI profile, not uploaded anywhere except to the AI provider you are
  chatting with, as part of the conversation.
- **No telemetry or analytics.** AI GUI collects no usage data, and its launcher
  turns off the editor's built-in telemetry and update checks.

## What is sent to AI providers

When you send a message, AI GUI sends it **directly from your computer** to the
provider behind the model you picked (OpenAI, ChatGPT, Anthropic, Claude Code or
your local Ollama). A request contains:

- recent messages in the current conversation;
- context you explicitly shared (the current document, planning brief, research
  sources or attachments, each controlled by a chip above the message box);
- in Plan, Build and Research modes, the results of tools the AI used during that
  reply (for example, the contents of a file it read or a command's output).

Nothing is shared just because it is open or captured. Each provider handles that
data under its own terms and privacy policy. API-key use is billed by the provider;
ChatGPT sign-in uses your ChatGPT plan; Claude Code uses its own account and billing.
AI GUI never switches you to a different paid route automatically.

Local models through Ollama run on your machine; requests go to Ollama's local
address (`127.0.0.1`).

## Credentials

| Connection | What AI GUI keeps | Where |
| --- | --- | --- |
| OpenAI / Anthropic API key | By default, held in memory for the current session only. If you tick **Remember securely on this device**, it is encrypted with your operating system's keychain (Electron safeStorage) before being written. | A separate local connection process; encrypted files in your profile |
| ChatGPT sign-in | Sign-in happens in your browser with OpenAI. Access tokens are held in memory, or encrypted with your keychain if you chose to remember the account. The account email and the app's registration ID are saved so you can reconnect. | Same as above |
| Claude Code | **Nothing.** AI GUI runs your installed Claude Code, which keeps its own sign-in. AI GUI never reads or copies Claude credentials. | Managed by Claude Code |
| Ollama | Nothing. | — |

- Keys and tokens are never written into your projects, conversations or logs, and
  are never shown back to the interface.
- If your system has no secure keychain, "remember" is unavailable and keys last
  only until you close the app.
- **Disconnect** deletes the stored key from your device; it does not revoke the key
  with the provider. **Sign Out** for ChatGPT also asks OpenAI to revoke the session.

## What is stored on your computer

All app data lives in your AI GUI profile folder (by default
`prototypes/code-oss/.profile/` in the AI GUI folder, or the folder set by
`AI_GUI_CODE_OSS_PROFILE`), under
`user-data/User/globalStorage/ai-gui.workspace-product/`:

- `conversations/`: your chats, planning briefs, captured research text and
  attachment snapshots, saved as **unencrypted** JSON files. Treat them like any
  other document on your disk.
- `connections/`: encrypted remembered keys and ChatGPT account information.

Other data:

- **Attachments** are copied into the open project's `attachments/` folder (your
  original files are never moved). Check that folder before committing a project
  to version control.
- **Editor settings** and window state are stored by the editor in the same profile.

To remove everything, close AI GUI and delete the profile folder. To remove only
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

## Research browser

The research browser runs in a separate window with a temporary session: cookies
and site data are discarded when it closes, downloads and site permissions are
blocked, and websites cannot reach your files. Searches typed into the address bar
go to DuckDuckGo. Captured text stays local until you share it with a conversation.

## Extensions

AI GUI is built on Code OSS (the open-source core of Visual Studio Code). Editor
extensions you install yourself run with your user permissions and follow their own
data practices.
