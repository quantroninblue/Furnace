import { app, BrowserWindow, dialog, ipcMain, session, safeStorage, shell } from "electron";
import { promises as fs, constants } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import * as pty from "node-pty";
import { Workspace } from "./workspace";
import { chat, listModels } from "./ollama";
import { runCommand } from "./commands";
import { Sessions } from "./sessions";
import { ProviderKeys } from "./provider-keys";
import { remoteChat, remoteModels, chatgptModels } from "./remote-models";
import { ChatGPTAuth } from "./chatgpt-auth";
import { findClaude, claudeStatus, claudeChat } from "./claude-code";
import { ResearchBrowser } from "./browser-window";
import { FileReviews } from "./file-reviews";
import { capturePage, normalizeSource } from "./research";
import { createAgentTools } from "./agent-tools";
import type { AgentMode, ChatEvent, Session, Selection, ResearchSource, RemoteProvider, ProviderConnection } from "../shared/types";

if (process.env.AI_GUI_USER_DATA)
  app.setPath("userData", process.env.AI_GUI_USER_DATA);
const ownsInstance = app.requestSingleInstanceLock();
if (!ownsInstance) app.quit();
let mainWindow: BrowserWindow;
let sessions: Sessions;
let providerKeys: ProviderKeys;
let chatgpt: ChatGPTAuth;
let claudeLogin: pty.IPty | null = null;
let claudeLoginGeneration = 0;
let claudeLoginTimer: ReturnType<typeof setTimeout> | undefined;
let claudeDirectory: string;
let chatgptStorageError: string | undefined;
let accountChanging = false;
let chatgptCatalog: { accountId: string | null; models: { id: string; name: string }[] } = { accountId: null, models: [] };
const remoteCatalog = new Map<RemoteProvider, ProviderConnection>();
let browser: ResearchBrowser;
let workspace: Workspace | null = null;
let terminal: pty.IPty | null = null;
let activeChat: AbortController | null = null;
let activeCommand: ReturnType<typeof runCommand> | null = null;
const fileReviews = new FileReviews();
const researchSources = new Map<string, ResearchSource>();
let browserSelection: Selection | null = null;
let discovery: Promise<Awaited<ReturnType<typeof discover>>> | null = null;
const rendererFile = path.join(__dirname, "../renderer/index.html");
const rendererURL = new URL(
  process.env.ELECTRON_RENDERER_URL || pathToFileURL(rendererFile).href,
).href;

function project() {
  if (!workspace) throw new Error("Open a project folder first.");
  return workspace;
}

function handle(channel: string, listener: (...args: any[]) => unknown) {
  ipcMain.handle(channel, (event, ...args) => {
    if (
      event.sender !== mainWindow.webContents ||
      event.senderFrame !== mainWindow.webContents.mainFrame ||
      event.senderFrame.url !== rendererURL
    )
      throw new Error("Untrusted IPC sender.");
    return listener(...args);
  });
}

async function executable(name: string) {
  const suffixes =
    process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const directory of (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)) {
    for (const suffix of suffixes) {
      const candidate = path.resolve(directory, name + suffix);
      try {
        await fs.access(
          candidate,
          process.platform === "win32" ? constants.F_OK : constants.X_OK,
        );
        if ((await fs.stat(candidate)).isFile()) return candidate;
      } catch {
        /* Try the next PATH entry. */
      }
    }
  }
  return null;
}

async function discover() {
  const ollamaPath = await executable("ollama");
  let models: string[] = [], ollamaError: string | undefined;
  const chatgptStatus = chatgpt.status();
  const selectedAccount = chatgptStatus.accounts.find(account => account.id === chatgptStatus.activeId);
  const claude = await claudeStatus(await findClaude(), claudeDirectory);
  const results = await Promise.allSettled([
    listModels(),
    ...(["openai", "anthropic"] as const).map(async provider => {
      const saved = providerKeys.get(provider);
      let state: ProviderConnection = { provider, connected: Boolean(saved), storage: saved?.storage ?? "none", models: [] };
      if (saved) {
        try { state.models = await remoteModels(provider, saved.key); }
        catch (error) { state.error = String((error as Error).message); }
      }
      remoteCatalog.set(provider, state);
      return state;
    }),
    (async () => {
      if (chatgptStorageError) { chatgptStatus.error = chatgptStorageError; return; }
      if (selectedAccount?.signedIn && selectedAccount.planEnabled) {
        try { chatgptStatus.models = await chatgptModels(await chatgpt.accessToken()); }
        catch (error) { chatgptStatus.error = (error as Error).message; }
      }
      if (chatgpt.status().activeId === chatgptStatus.activeId) chatgptCatalog = { accountId: chatgptStatus.activeId, models: chatgptStatus.models };
    })(),
  ]);
  if (results[0].status === "fulfilled") models = results[0].value as string[];
  else ollamaError = "Ollama is not responding at 127.0.0.1:11434. Start it, then refresh.";
  return { ollamaPath, models, ollamaError, providers: [...remoteCatalog.values()], secureStorage: providerKeys.secureStorage(), claude, chatgpt: { ...chatgpt.status(), models: chatgptCatalog.accountId === chatgpt.status().activeId ? chatgptCatalog.models : [], error: chatgptStatus.error } };
}
function assertProvider(provider: string): asserts provider is RemoteProvider {
  if (provider !== "openai" && provider !== "anthropic") throw new Error("Unknown provider.");
}
function idle() {
  if (activeChat || activeCommand || accountChanging || claudeLogin) throw new Error("Finish the current task or sign-in before changing sessions or connections.");
}
async function changeAccount<T>(work: () => Promise<T>) {
  idle();
  if (chatgptStorageError) throw new Error(chatgptStorageError);
  accountChanging = true;
  try { if (discovery) await discovery; return await work(); }
  finally { accountChanging = false; }
}
function restoreSources(saved: Session) {
  researchSources.clear();
  saved.sources = (Array.isArray(saved.sources) ? saved.sources : []).slice(0, 6).flatMap(source => {
    try {
      const restored = normalizeSource(source, source.url, typeof source.id === "string" ? source.id : randomUUID());
      researchSources.set(restored.id, restored); return [restored];
    } catch { return []; }
  });
  return saved;
}

app.whenReady().then(async () => {
  if (!ownsInstance) return;
  claudeDirectory = path.join(app.getPath("userData"), "claude-runtime");
  await fs.mkdir(claudeDirectory, { recursive: true, mode: 0o700 });
  sessions = new Sessions(path.join(app.getPath("userData"), "sessions"), path.join(app.getPath("userData"), "workspaces"));
  const cipher = {
    available: () => safeStorage.isEncryptionAvailable() && (process.platform !== "linux" || !["basic_text", "unknown"].includes(safeStorage.getSelectedStorageBackend())),
    encrypt: (value: string) => safeStorage.encryptString(value), decrypt: (value: Buffer) => safeStorage.decryptString(value),
  };
  providerKeys = new ProviderKeys(path.join(app.getPath("userData"), "provider-keys"), cipher);
  await providerKeys.load();
  chatgpt = new ChatGPTAuth(path.join(app.getPath("userData"), "chatgpt"), cipher, url => shell.openExternal(url));
  try { await chatgpt.load(); } catch (error) { chatgptStorageError = (error as Error).message; }
  session.defaultSession.setPermissionRequestHandler(
    (_contents, _permission, callback) => callback(false),
  );
  session.defaultSession.setPermissionCheckHandler(() => false);
  mainWindow = new BrowserWindow({
    title: "AI GUI · Workspace",
    width: 1480,
    height: 940,
    minWidth: 1050,
    minHeight: 680,
    frame: false,
    backgroundColor: "#00000000",
    transparent: true,
    show: false,
    ...(process.platform === "darwin"
      ? { vibrancy: "under-window" as const }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: false,
    },
  });
  // The workspace header owns window chrome; do not show Electron's default
  // File/Edit menu inside the window. macOS retains its system application menu.
  if (process.platform !== "darwin") mainWindow.setMenu(null);
  const publishWindowState = () =>
    mainWindow.webContents.send("window:maximized", mainWindow.isMaximized());
  mainWindow.on("maximize", publishWindowState);
  mainWindow.on("unmaximize", publishWindowState);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  mainWindow.webContents.on("will-prevent-unload", (event) => {
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: "question",
      buttons: ["Keep editing", "Discard and close"],
      defaultId: 0,
      cancelId: 0,
      title: "Unsaved changes",
      message: "This file has unsaved changes.",
      detail: "Save it before closing, or discard the editor changes.",
    });
    if (choice === 1) event.preventDefault();
  });
  mainWindow.on("closed", () => {
    browser?.close();
    activeChat?.abort();
    activeCommand?.stop();
    terminal?.kill();
    terminal = null;
  });
  mainWindow.once("ready-to-show", () => mainWindow.show());
  if (process.env.ELECTRON_RENDERER_URL) void mainWindow.loadURL(rendererURL);
  else void mainWindow.loadFile(rendererFile);

  handle("window:minimize", () => mainWindow.minimize());
  handle("window:toggle-maximize", () => {
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  handle("window:close", () => mainWindow.close());
  handle("window:is-maximized", () => mainWindow.isMaximized());

  handle("project:current", () =>
    workspace
      ? { root: workspace.root, name: path.basename(workspace.root) }
      : null,
  );
  handle("project:open", async () => {
    if (activeChat || activeCommand)
      throw new Error("Stop the current reply before changing projects.");
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Open a project folder",
      properties: ["openDirectory"],
    });
    if (result.canceled) return null;
    const root = await fs.realpath(result.filePaths[0]);
    terminal?.kill();
    terminal = null;
    workspace = new Workspace(root);
    sessions.start(root);
    fileReviews.clear();
    researchSources.clear();
    browserSelection = null;
    browser?.close();
    return { root, name: path.basename(root) };
  });
  handle("project:list", (relative: string) => project().list(relative));
  handle("file:read", (relative: string) => project().read(relative));
  handle("file:save", (document) => project().save(document));
  handle("file:apply-proposal", (id: string, text: string) => {
    if (activeChat || activeCommand) throw new Error("Wait for the current task to finish before applying edits.");
    return fileReviews.apply(project(), id, text);
  });
  handle("file:discard-proposal", (id: string) => fileReviews.discard(id));
  handle("attachments:choose", async () => {
    const target = project();
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Copy files into this project",
      properties: ["openFile", "multiSelections"],
    });
    return result.canceled ? [] : target.importFiles(result.filePaths);
  });
  handle("attachments:import", (paths: string[]) =>
    project().importFiles(paths),
  );
  handle("session:read", () => restoreSources(sessions.current()));
  handle("session:write", (data: Session, root: string | null) => {
    if (root !== (workspace?.root ?? null)) throw new Error("Project changed before saving this session.");
    return sessions.write(data, root);
  });
  handle("session:list", () => sessions.list(workspace?.root ?? null));
  handle("session:start", () => {
    idle(); fileReviews.clear(); researchSources.clear(); browserSelection = null;
    return sessions.start(workspace?.root ?? null);
  });
  handle("session:resume", async (id: string) => {
    idle();
    const saved = await sessions.resume(id, workspace?.root ?? null);
    fileReviews.clear(); browserSelection = null;
    saved.messages = saved.messages.map(message => ({ ...message, proposals: message.proposals?.map(proposal => proposal.kind === "file" && proposal.status === "pending" ? { ...proposal, status: "expired" as const } : proposal) }));
    return restoreSources(saved);
  });
  handle("agents:connect", async (provider: string, key: string, remember: boolean) => {
    idle(); assertProvider(provider);
    if (typeof key !== "string" || key.trim().length < 8 || key.length > 4096 || /[\r\n\0]/.test(key)) throw new Error("Enter a valid API key.");
    if (typeof remember !== "boolean") throw new Error("Invalid storage choice.");
    // Verify via a free catalog request; never send a conversation during setup.
    await remoteModels(provider, key.trim());
    await providerKeys.set(provider, key, remember);
    return discover();
  });
  handle("chatgpt:sign-in", (accountId: string | null, remember: boolean) => changeAccount(async () => {
    if ((accountId !== null && typeof accountId !== "string") || typeof remember !== "boolean") throw new Error("Invalid sign-in request.");
    await chatgpt.signIn(accountId, remember);
    chatgptCatalog = { accountId: null, models: [] };
    return discover();
  }));
  handle("chatgpt:cancel", () => chatgpt.cancel());
  handle("chatgpt:select", (accountId: string) => changeAccount(async () => {
    if (typeof accountId !== "string") throw new Error("Invalid account.");
    await chatgpt.select(accountId); chatgptCatalog = { accountId: null, models: [] }; return discover();
  }));
  handle("chatgpt:sign-out", (accountId: string) => changeAccount(async () => {
    if (typeof accountId !== "string") throw new Error("Invalid account.");
    const warning = await chatgpt.signOut(accountId); chatgptCatalog = { accountId: null, models: [] };
    return { status: await discover(), warning };
  }));
  handle("chatgpt:acknowledge", () => changeAccount(async () => { await chatgpt.acknowledge(); return discover(); }));
  handle("chatgpt:usage", () => shell.openExternal("https://chatgpt.com/settings/usage"));
  handle("claude:guide", () => shell.openExternal("https://code.claude.com/docs/en/setup"));
  handle("claude:login", async (consoleAccount: boolean) => {
    idle();
    const generation = ++claudeLoginGeneration;
    if (typeof consoleAccount !== "boolean") throw new Error("Invalid sign-in choice.");
    accountChanging = true;
    try {
      const file = await findClaude();
      const status = await claudeStatus(file, claudeDirectory);
      if (!file || !status.compatible) throw new Error(status.error ?? "Install Claude Code first, then refresh Connections.");
      if (generation !== claudeLoginGeneration) return;
      const current = pty.spawn(file, ["auth", "login", ...(consoleAccount ? ["--console"] : [])], { name: "xterm-256color", cols: 82, rows: 16, cwd: claudeDirectory, env: { ...process.env, TERM: "xterm-256color" } });
      claudeLogin = current;
      let size = 0;
      current.onData(data => {
        size += data.length;
        if (size > 512000) { current.kill(); return; }
        if (!mainWindow.isDestroyed()) mainWindow.webContents.send("claude:login-data", data);
      });
      claudeLoginTimer = setTimeout(() => current.kill(), 300000);
      current.onExit(({ exitCode }) => {
        if (claudeLogin === current) { claudeLogin = null; if (claudeLoginTimer) clearTimeout(claudeLoginTimer); }
        if (!mainWindow.isDestroyed()) mainWindow.webContents.send("claude:login-exit", exitCode);
      });
    } finally { accountChanging = false; }
  });
  handle("claude:stop-login", () => { claudeLoginGeneration++; claudeLogin?.kill(); });
  handle("claude:write", (data: string) => {
    if (typeof data !== "string" || data.length > 8192) throw new Error("Invalid sign-in input.");
    claudeLogin?.write(data);
  });
  handle("claude:resize", (cols: number, rows: number) => {
    if (Number.isInteger(cols) && Number.isInteger(rows) && cols > 0 && cols < 400 && rows > 0 && rows < 200) claudeLogin?.resize(cols, rows);
  });
  handle("agents:disconnect", async (provider: string) => {
    idle(); assertProvider(provider); await providerKeys.remove(provider); return discover();
  });
  handle("agents:discover", () => {
    if (!discovery)
      discovery = discover().finally(() => {
        discovery = null;
      });
    return discovery;
  });
  handle(
    "agents:send",
    (request: {
      id: string;
      model: string;
      messages: any[];
      context: string;
      mode?: AgentMode;
      plan?: string;
      allowSelection?: boolean;
      sourceIds?: string[];
    }) => {
      if (activeChat || activeCommand || accountChanging || claudeLogin)
        throw new Error("A reply or command is already in progress.");
      if (
        !request ||
        typeof request.id !== "string" ||
        typeof request.model !== "string" ||
        typeof request.context !== "string" ||
        !Array.isArray(request.messages) ||
        JSON.stringify(request).length > 300000 ||
        request.messages.some(
          (m) =>
            !["user", "assistant"].includes(m?.role) ||
            typeof m.content !== "string",
        )
      )
        throw new Error("Invalid or oversized conversation.");
      const mode = request.mode ?? "discuss";
      if (
        !["discuss", "plan", "build", "research"].includes(mode) ||
        (request.plan !== undefined && typeof request.plan !== "string") ||
        (request.sourceIds !== undefined && (!Array.isArray(request.sourceIds) || request.sourceIds.length > 3 || request.sourceIds.some(id => typeof id !== "string")))
      )
        throw new Error("Invalid agent mode or plan.");
      const controller = new AbortController();
      activeChat = controller;
      const emit = (event: ChatEvent) => {
        if (!mainWindow.isDestroyed())
          mainWindow.webContents.send("agents:event", event);
      };
      const tools = createAgentTools(
        mode,
        workspace,
        request.plan ?? "",
        request.allowSelection === true ? browserSelection : null,
        (proposal) => emit({ id: request.id, proposal }),
        { files: fileReviews, sources: (request.sourceIds ?? []).flatMap(id => researchSources.has(id) ? [researchSources.get(id)!] : []) },
      );
      const remote = /^(openai|anthropic)\/(.+)$/.exec(request.model);
      const run = async () => {
        if (request.model.startsWith("claude-code/")) {
          const file = await findClaude();
          const status = await claudeStatus(file, claudeDirectory);
          if (!file || !status.compatible || !status.connected) throw new Error(status.error ?? "Sign in to Claude Code from Connections first.");
          controller.signal.throwIfAborted();
          return claudeChat(file, claudeDirectory, { ...request, model: request.model.slice("claude-code/".length) }, controller.signal, emit, tools);
        }
        if (request.model.startsWith("chatgpt/")) {
          const modelId = request.model.slice("chatgpt/".length);
          if (chatgptCatalog.accountId !== chatgpt.status().activeId || !chatgptCatalog.models.some(model => model.id === modelId)) throw new Error("Refresh the selected ChatGPT account’s models in Connections.");
          return remoteChat("openai", await chatgpt.accessToken(), { ...request, model: modelId }, controller.signal, emit, tools, undefined, { chatgpt: true });
        }
        if (!remote) return chat(request, controller.signal, emit, tools);
        const provider = remote[1] as RemoteProvider;
        const credential = providerKeys.get(provider);
        if (!credential) throw new Error("Connect this provider in Connections first.");
        if (!remoteCatalog.get(provider)?.models.some(model => model.id === remote[2])) throw new Error("Refresh this provider's model list before sending.");
        return remoteChat(provider, credential.key, { ...request, model: remote[2] }, controller.signal, emit, tools);
      };
      void run()
        .catch((error) =>
          emit({
            id: request.id,
            error: controller.signal.aborted
              ? "Reply stopped."
              : String(error.message ?? error),
          }),
        )
        .finally(() => {
          if (activeChat === controller) activeChat = null;
          emit({ id: request.id, done: true });
        });
    },
  );
  handle("agents:stop", () => {
    activeChat?.abort();
    activeCommand?.stop();
  });
  handle("terminal:run", (request: { id: string; command: string }) => {
    const cwd = project().root;
    if (activeChat || activeCommand)
      throw new Error("A reply or command is already in progress.");
    if (
      !request ||
      typeof request.id !== "string" ||
      typeof request.command !== "string" ||
      !request.command.trim() ||
      request.command.length > 8000 ||
      request.command.includes("\0")
    )
      throw new Error("Invalid command. Use up to 8,000 characters.");
    const operation = runCommand(request.id, request.command, cwd, (event) => {
      if (!mainWindow.isDestroyed())
        mainWindow.webContents.send("agents:event", event);
    });
    activeCommand = operation;
    void operation.done.finally(() => {
      if (activeCommand === operation) activeCommand = null;
    });
  });
  handle("terminal:start", () => {
    if (terminal) return;
    const cwd = project().root;
    const shell =
      process.platform === "win32"
        ? process.env.COMSPEC || "powershell.exe"
        : process.env.SHELL || "/bin/bash";
    terminal = pty.spawn(shell, [], {
      name: "xterm-256color",
      cols: 100,
      rows: 18,
      cwd,
      env: { ...process.env, TERM: "xterm-256color" },
    });
    const current = terminal;
    current.onData((data) => {
      if (!mainWindow.isDestroyed())
        mainWindow.webContents.send("terminal:data", data);
    });
    current.onExit(() => {
      if (terminal === current) terminal = null;
      if (!mainWindow.isDestroyed())
        mainWindow.webContents.send(
          "terminal:data",
          "\r\n[Shell exited. Use Start shell to reconnect.]\r\n",
        );
    });
  });
  handle("terminal:write", (data: string) => {
    if (typeof data !== "string" || data.length > 65536)
      throw new Error("Invalid terminal input.");
    terminal?.write(data);
  });
  handle("terminal:resize", (cols: number, rows: number) => {
    if (
      Number.isInteger(cols) &&
      Number.isInteger(rows) &&
      cols > 0 &&
      cols < 1000 &&
      rows > 0 &&
      rows < 500
    )
      terminal?.resize(cols, rows);
  });
  browser = new ResearchBrowser(mainWindow, () => {
    browserSelection = null;
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send("research:selection", { url: "", title: "", text: "" });
  });
  handle("research:capture-page", async () => {
    if (!browser.contents) throw new Error("Open a research page first.");
    const target = workspace;
    const source = await capturePage(browser.contents);
    if (workspace !== target) throw new Error("Project changed during capture. Try again.");
    if (researchSources.size >= 6) researchSources.delete(researchSources.keys().next().value!);
    researchSources.set(source.id, source);
    return source;
  });
  handle("research:open", (value: string, placement: unknown) => browser.open(value, placement));
  handle("research:browser-bounds", (bounds: unknown) => browser.setBounds(bounds));
  ipcMain.on("research:selection", (event, selection) => {
    if (
      !browser.contents ||
      event.sender !== browser.contents ||
      event.senderFrame !== browser.contents.mainFrame
    )
      return;
    if (
      !selection ||
      typeof selection.text !== "string" ||
      typeof selection.title !== "string"
    )
      return;
    browserSelection = {
      url: browser.contents.getURL(),
      title: selection.title.slice(0, 300),
      text: selection.text.slice(0, 16000),
    };
    mainWindow.webContents.send("research:selection", browserSelection);
  });
  app.on("activate", () => {
    if (!mainWindow.isDestroyed()) mainWindow.show();
  });
});

app.on("before-quit", () => {
  chatgpt?.cancel();
  claudeLogin?.kill();
  if (claudeLoginTimer) clearTimeout(claudeLoginTimer);
  activeChat?.abort();
  activeCommand?.stop();
  terminal?.kill();
  terminal = null;
});
app.on("window-all-closed", () => app.quit());
app.on("second-instance", () => { if (mainWindow && !mainWindow.isDestroyed()) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); } });
