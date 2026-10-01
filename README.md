# AI GUI — desktop preview

An original desktop workspace for hands-on collaboration with agents. The first draft brings together an editor, project files, a terminal, a planning brief, local model discussion, and a research browser. The product name is still a placeholder. This project is private; source access is intended for the owner only. Testers will receive packaged builds separately.

## Run locally

Requires Node.js 22.12 or newer and npm. Native terminal dependencies may require Python and a C/C++ build toolchain (`build-essential` on Ubuntu; Xcode command line tools on macOS; Visual Studio C++ build tools on Windows).

```sh
npm install
npm run dev
```

Or build and run the production preview:

```sh
npm run build
npm start
```

The app starts with a **fresh conversation**. Quick chat works without a project and saves separately in local app data. Use **New chat** or `/new` to start another conversation, and **Resume chat** or `/resume` for a searchable history. `/resume last` opens the most recent previous conversation in the current project (or quick-chat history when no project is open). Opening a project starts a fresh session too; use Resume to choose its previous chats. Existing single-chat data is imported into history without deleting the original. Open a project folder using the top bar or welcome screen when you want file access or shell commands. The app does not automatically open or index your home directory.

On Linux distributions that restrict unprivileged user namespaces, an unpackaged Electron binary may need a configured Chromium sandbox helper. The install script can reuse an existing root-owned helper from a standard Chrome/Chromium installation by creating a local symlink inside `node_modules`. It preserves the bundled helper, makes no system changes, and never disables sandboxing. If neither user namespaces nor a suitable helper are available, follow your distribution’s Electron sandbox setup before launching. The desktop test explicitly enables Chromium sandboxing too.

The appearance uses translucent charcoal surfaces and a muted warm-silver accent. Desktop transparency depends on the compositor; Linux does not provide the same native background blur as macOS vibrancy. Code syntax and terminal output can still use their own semantic colors.

The workspace header also serves as the title bar: drag its empty area to move the window, and use the matching minimize, maximize/restore, and close buttons at the right. The main window has no separate native title strip or File/Edit menu bar. Closing still prompts if an editor file has unsaved changes.

## Working in this draft

- **Build:** browse project files, edit UTF-8 text with Monaco, save with Ctrl/Cmd+S. A content revision check prevents saving over an edit detected on disk. Save or discard before switching files. The conversation panel has a draggable divider.
- **Terminal:** open the bottom panel, then click **Start shell**. This is your real shell, with your normal OS permissions. Run installed tools such as `codex` here; their own authentication and permissions apply.
- **Plan:** write a Markdown brief and choose whether to include it in chat. Briefs and conversation history save in local Electron application data, separately for each project. Resuming a conversation restores its brief, model choice, messages and captured sources. Pending file proposals expire when changing sessions or restarting; request a new proposal before applying.
- **Models:** the connection dialog discovers Ollama on `PATH` and reads its installed model list at `http://127.0.0.1:11434`. Start your Ollama service beforehand and install a model separately. Chat streams replies, supports cancellation, and passes the latest 30 messages when you switch models. No model downloads or inference happen automatically. **OpenAI** and **Anthropic** tabs accept your API key, check it against the provider’s model catalog, and list available text model IDs in **Active model**. Catalog visibility does not guarantee a particular endpoint or tool capability; unsupported requests report an error. Model switching keeps the current conversation.
- **Research:** enter a website or search query; choose **In workspace** or **Pop-out window**. Both views have an address/search bar (DuckDuckGo for searches), back, forward, reload/stop, loading status, and recoverable navigation errors. The title-bar button moves the same page between views, preserving history. Ctrl/Cmd+L focuses the address; Alt+Left/Right navigates history, and Ctrl/Cmd+R or F5 reloads. New-window links open in the current research page. Highlight text on the main page to capture its title, URL, and selection. The visible context chip controls whether it is sent with your next message. Forms and embedded frames are excluded. **Capture current page** collects visible page text (up to 8,000 characters), 20 links and 12 image references. Keep six sources per conversation and explicitly share up to three with the next message. Capturing a page does not automatically share it with a model.
- **Attachments:** drag files into the conversation or use the paperclip. Files are copied under `attachments/<unique-id>/<original-name>` in the project; sources are never moved. Small recognized text files are included as text. Removing a context chip leaves the imported file in the project.

The workspace owns the agent loop; models connect directly through provider adapters. There is no Codex integration dependency. The optional Claude connection runs the user’s installed Claude Code, exposing the same scoped workspace tools through MCP. Ollama is the first provider. Select **Discuss**, **Plan**, **Build**, or **Research** in the conversation header. Discuss has no tools; Plan can read project files and propose a brief; Build can read project files and propose commands or complete file changes; Research can read shared selections and captured sources and suggest pages to open. Tool access is enforced in the main process. File tools exclude escaping paths and common secret files. Agent turns are bounded to six rounds and sixteen tool calls. Plan, command, file and browser-navigation proposals require user action; model output is never automatically executed.

The bottom-right input accepts natural-language prompts in **Ask** mode and shell commands in **Run** mode. Explicit commands stream output into the conversation, start in the project root, and have a two-minute/512 KB output limit. They run with normal user permissions. **Use command** copies a model proposal into the input; submitting Run executes it. Use the separate shell panel for interactive or persistent shell sessions.

Type `/` for the command palette. Commands include `/new`, `/resume`, `/ask`, `/run`, `/discuss`, `/plan`, `/build`, `/research`, `/open`, `/attach`, `/agents`, `/terminal`, `/stop`, and `/help`. Arrow keys navigate; Enter selects; Escape dismisses.

## Reviewed file changes

Build mode can propose replacements for files it has read completely, or new UTF-8 files in existing directories. Choose **Review changes** for an editable side-by-side diff, adjust the proposed side, then **Apply reviewed changes** or **Discard proposal**. Proposing changes never writes a file. The main process binds each approval handle to its project and checks the file revision again at apply time; new files never overwrite existing paths. Review proposals are limited to 24,000 characters per file. Save or discard your own editor changes before opening a review.

## Online providers and keys

Cloud adapters use the official [OpenAI Responses API](https://developers.openai.com/api/docs/guides/function-calling) and [Anthropic Messages API](https://platform.claude.com/docs/en/build-with-claude/streaming), with streamed text, cancellation and the same app-owned scoped tools. Model names come from provider responses rather than an assumed entitlement list. The UI shows which replies used an API and warns that recent history and shared context are sent to that provider.

Keys are held only in the main process after entry. By default they last for the current app process. **Remember securely on this device** uses Electron safeStorage and the OS credential facility; it is disabled when secure storage is unavailable, including Linux’s `basic_text` fallback. Encrypted key files live in local application data, never in the project. Disconnect deletes the local stored key; it does not revoke the key with the provider. The key-entry field clears after submission; neither chat history nor logs contain keys. There is no app backend.

The **Key verified** badge confirms only that the provider’s model list is accessible; it does not confirm inference access or available API credit. Connection setup lists models without making a paid inference request. Errors distinguish quota, rate limits, model permissions, invalid parameters, DNS, TLS, timeout and interrupted connections without forwarding raw SDK errors or keys. API-key usage is billed by the provider. ChatGPT plan sign-in is a separate connection, described below. OpenAI requests use `store: false` and preserve encrypted reasoning within a tool turn; Anthropic preserves signed thinking blocks for tool continuation. These settings do not replace providers’ own data policies. API-key turns have no automatic retries, a 16,384 output-token cap per model request, six rounds and sixteen tool calls; these are execution limits, not a monetary spending cap.

Sessions use local JSON files with atomic, serialized writes and identifiers that prevent a delayed save from overwriting a different session. The picker is scoped to the current project, like [Codex’s directory-scoped resume](https://learn.chatgpt.com/docs/developer-commands#codex-resume). Empty untouched conversations are not added to history. Editor contents remain ordinary project files, shared across that project’s conversations.

## Use your ChatGPT plan

Open **Connections → ChatGPT → Continue with ChatGPT**. Complete sign-in and plan-usage consent in your default browser, return to the app, choose an available model, and send a message. No project folder is required. **Manage usage** opens ChatGPT settings to review your plan, this app’s allowance, and any permitted credit use. Eligibility and model availability are determined by OpenAI; signing in does not guarantee every model or unlimited usage.

The integration uses the official [Sign in with ChatGPT flow for open-source clients](https://developers.openai.com/siwc/token-sharing-open-source/sign-in), directly against the public Responses API. It keeps our own agent loop and scoped tools; Codex is not required. The app dynamically registers itself as **AI GUI**, persists a distinct host identifier, and reuses each account’s issued registration. Separate account entries remain separate even when their email addresses match.

Authentication runs in Electron’s main process: a short-lived `127.0.0.1` callback, one-time state, S256 PKCE, a nonce, and signature/issuer/audience/expiry validation of ID tokens using OpenAI’s discovery document and JWKS. Tokens never enter the renderer, chat history, or project files. Sign-in defaults to this app session; optional remembering encrypts tokens with OS-backed safeStorage. The account mapping and host ID persist in app data so signing out does not create a new registration. Refresh-token rotation is serialized; only one app process can own the account store. Sign-out attempts remote revocation and clears local credentials, with a warning if remote revocation cannot be confirmed.

Account models come from the OAuth-specific catalogue. ChatGPT requests use `store: false`, streaming, explicit history, and namespaced function tools; unsupported token-cap parameters are omitted. The six-round, sixteen-tool, and 512 KB streamed-output limits still apply. The composer identifies **Using ChatGPT plan**. Missing consent, eligibility restrictions, exhausted usage, or network failures stop that route: there is no automatic fallback to an API key or another billing source. See OpenAI’s [current preview restrictions](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations).

Authentication and model transport have simulated tests. Actual account eligibility and successful live inference depend on the selected account.

## Claude through your installed Claude Code

Install the official native Claude Code executable (version 2.1.248 or newer), then open **Connections → Claude** and refresh. The app discovers `claude`/`claude.exe` on PATH and in `~/.local/bin`. Use **Sign in through Claude Code** for its own browser/terminal flow, or **Use Console account** for Console authentication. Existing Claude Code authentication also works. Sign-in changes the account used by that installation; this app does not maintain a separate Claude account vault. Choose a model under **Active model** and use the normal conversation panel, including without a project open.

This runs the unmodified installed binary; it does not collect Claude subscription tokens or use them as direct API credentials. Claude Code owns authentication and billing. The separate **Anthropic API** tab continues to use an API key with separate API billing. See Anthropic’s [current integration and authentication rules](https://code.claude.com/docs/en/legal-and-compliance) and [CLI interface](https://code.claude.com/docs/en/cli-reference). Model choices are CLI aliases, not a verified account catalogue; unavailable models report an error.

Each GUI turn starts a restricted CLI process in a temporary application directory. Shared conversation history goes through stdin, with a custom workspace prompt. Built-in tools, custom commands, automatic memory, and user/project settings are disabled; MCP is restricted to a temporary authenticated loopback server exposing that mode’s workspace tools. Tool calls are serialized and capped at sixteen, with six agent turns, a three-minute timeout, bounded output, and cancellation of the process group. File, command, plan, and browser proposals keep their existing review controls. Native CLI session persistence is disabled; our local chat history supplies subsequent turns. Managed machine policies still apply: this integration is not an OS sandbox. Unexpected tools reported by the CLI stop the turn.

No Claude credentials are copied or logged by the app. Temporary MCP credentials authenticate only that turn’s local tool server and are removed after the turn. Native-binary publisher verification, Windows/macOS integration testing, and a live Claude subscription test remain outstanding; tests use an executable fixture, not a real account.

## Boundaries and unfinished features

This is a development preview, not a packaged public release. Linux is the first tested platform. Windows and macOS still need native testing and packaging.

- Ollama, OpenAI API keys, Anthropic API keys, and ChatGPT plan sign-in are implemented. Other direct provider sign-ins, usage/cost dashboards and model-specific reasoning controls remain future work. ChatGPT sign-in and a live model reply have been user-tested. Other live cloud routes still need testing. The optional Claude Code connection uses that installation’s authentication and billing.
- Git diffs, multi-file transactions, new-directory creation, worktree isolation and architecture diagrams remain future milestones. File review currently handles one complete text file at a time.
- PDFs and images are copied successfully but do not yet have extraction, OCR, visual previews, or vision-model input. The UI labels these attachments **file only**.
- Research extracts the current main page and stores sources; automated web crawling, autonomous search/navigation, structured dataset extraction and pointer targeting are not implemented. Image references are collected as links, not downloaded or sent as vision input. The research session is temporary; credentials should be handled through the provider’s supported login flow, not this browser.
- The editor handles one active UTF-8 file, up to 2 MB. Attachments are limited to 20 files per import, 25 MB each. A directory shows up to 1,000 entries. Refresh the tree after external changes; there is no filesystem watcher yet.
- Context is bounded: editor text 24,000 characters, plan 20,000, selection 16,000, and recognized attachment text 20,000 each. Total chat requests are capped. Conversation size is not a guarantee that it fits every model’s context window.
- Conversations and briefs are local plaintext. They are not an encrypted vault. Files imported into a project follow that project’s Git rules, so review them before committing.
- The UI talks to localhost for Ollama. Use a locally installed model for offline operation; a custom Ollama configuration can itself use network services. Installed paths and endpoint responses do not verify model weights or publisher signatures.

The trusted app renderer, browser toolbar, and untrusted research page run separately, with sandboxing, context isolation, and Node integration disabled. The research preload exposes no page API. Main-process IPC checks the sending window and frame, permissions and downloads are denied in the research window, and arbitrary protocols are blocked. Filesystem helpers reject escaping paths and symlinks. These checks do not make the entire desktop app or user-controlled terminal an OS sandbox, or guarantee protection against a hostile process racing filesystem operations.

## Validation

```sh
npm run typecheck
npm test
npm run test:smoke
```

Current Linux validation: TypeScript, production build, 46 unit tests and four desktop scenarios pass. Claude Code sign-in/chat is verified with a native-process fixture; a real Claude account test remains pending. Browser navigation, failure recovery, docking/pop-out, modal visibility and selection/capture are covered; the embedded native view was also visually checked on Linux.

Unit tests exercise filesystem and review boundaries, stale saves, attachment copying, session isolation/migration, key storage, and all three streaming adapters (including reasoning and tool-call continuity). Playwright launches actual Electron windows and verifies editor saves, imports, shell/composer execution, browser isolation and capture, editable diff approval, slash commands, provider connections/streaming, new sessions, explicit resume and fresh state after a real process restart. It uses temporary project and application data, with no paid inference calls. A graphical desktop session is required; Linux CI will need a virtual display.

An opt-in live check uses an installed Ollama model and temporary files (file edits remain unapproved):

```sh
npx tsx scripts/check-model.ts <installed-model> discuss
# Or choose additional modes:
npx tsx scripts/check-model.ts <installed-model> build,research
```

The live check has no default model. It checks the installed model’s reported size against available memory with reserved headroom before making any inference request. This is a conservative estimate, not a guarantee against resource exhaustion. Run live checks separately from builds and desktop tests. Ordinary unit and desktop tests use simulated inference.

Source layout: `src/main` owns privileged services; `src/preload` holds distinct workspace, browser-control and page-selection bridges; `src/renderer` owns the React interface; `src/shared` defines typed requests and data. Monaco workers are bundled for offline use. There is no hosted application backend or analytics integration.

## Private testing distribution

The source repository is intended to remain private and accessible only to the owner. Share versioned **installer builds**, not repository invitations or the working directory. Planned formats are a Linux package, a Windows installer, and a macOS disk image. Packaging is not configured yet. Build/test native dependencies on each target platform and architecture; sign Windows builds and sign/notarize macOS builds before wider distribution. See [Electron distribution guidance](https://www.electronjs.org/docs/latest/tutorial/distribution-overview).

Start with a small Linux test group using restricted download links, release notes, checksums and a feedback channel. Testers connect their own model accounts. Package an explicit allowlist of runtime files; exclude architecture.md, name_idea.txt, .env files, local application data, credentials, chat histories, screenshots and fixtures. Electron bundles are inspectable even when the Git repository is private. Preserve dependency licenses and notices; choose proprietary distribution terms before release. Automatic updates and signing credentials are separate release tasks.

The existing ChatGPT route remains implemented. OpenAI's [current overview](https://developers.openai.com/siwc/token-sharing-open-source) covers open-source and locally hosted apps, and its [account documentation](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions) mentions private clients. A private repository alone does not establish a need to remove this route. Paid or remotely hosted products are directed to a separate interest process; review eligibility before changing the distribution/business model. Source is kept in the private owner-only repository [quantroninblue/AI_GUI](https://github.com/quantroninblue/AI_GUI). No installer or release has been published.
