import { BrowserDock } from "./BrowserDock";
import { useCallback, useEffect, useRef, useState } from "react";
import Editor from "@monaco-editor/react";
import Markdown from "react-markdown";
import {
  ArrowUp,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  Code2,
  Command,
  FileCode2,
  Folder,
  FolderOpen,
  Globe2,
  History,
  Layers3,
  MessageSquare,
  PanelBottom,
  Paperclip,
  Plus,
  Radio,
  RefreshCw,
  Save,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  TerminalSquare,
  Unplug,
  X,
} from "lucide-react";
import type {
  AgentMode,
  AgentStatus,
  Attachment,
  Document,
  FileProposal,
  ResearchSource,
  Entry,
  Message,
  Project,
  Selection,
  Session,
  SessionSummary,
} from "../../shared/types";
import Terminal from "./Terminal";
import WindowControls from "./WindowControls";
import { workspaceCommands } from "./workspace-commands";
import SlashMenu from "./SlashMenu";
import FileReview from "./FileReview";
import ProviderConnection from "./ProviderConnection";
import ChatGPTConnection from "./ChatGPTConnection";
import ClaudeConnection from "./ClaudeConnection";
import SessionPicker from "./SessionPicker";

const api = window.workspace;
const availableModels = (status: AgentStatus | null) => [...(status?.models ?? []), ...(status?.claude?.models ?? []).map(model => `claude-code/${model.id}`), ...(status?.chatgpt?.models ?? []).map(model => `chatgpt/${model.id}`), ...(status?.providers ?? []).flatMap(provider => provider.models.map(model => `${provider.provider}/${model.id}`))];
const INITIAL_PLAN =
  "# Project brief\n\n## What are we building?\n\nDescribe the problem and who this helps.\n\n## Ideas to explore\n\n- \n\n## Decisions\n\nRecord the choices you and your agent make together.\n\n## Next steps\n\n- [ ] Define a small first milestone\n";
const formatSize = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1048576
      ? `${Math.round(n / 1024)} KB`
      : `${(n / 1048576).toFixed(1)} MB`;

function Tree({
  path = "",
  depth = 0,
  active,
  onOpen,
  onError,
}: {
  path?: string;
  depth?: number;
  active?: string;
  onOpen: (path: string) => void;
  onError: (error: unknown) => void;
}) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [expanded, setExpanded] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    void api.project
      .list(path)
      .then((value) => {
        if (live) setEntries(value);
      })
      .catch(onError);
    return () => {
      live = false;
    };
  }, [path, onError]);
  return (
    <>
      {entries.map((entry) => (
        <div key={entry.path}>
          <button
            className={`tree-row ${active === entry.path ? "active" : ""}`}
            style={{ paddingLeft: 12 + depth * 14 }}
            onClick={() =>
              entry.directory
                ? setExpanded((old) =>
                    old.includes(entry.path)
                      ? old.filter((p) => p !== entry.path)
                      : [...old, entry.path],
                  )
                : onOpen(entry.path)
            }
            title={entry.path}
          >
            {entry.directory ? (
              <>
                {expanded.includes(entry.path) ? (
                  <ChevronDown size={12} />
                ) : (
                  <ChevronRight size={12} />
                )}
                <Folder size={14} className="folder-icon" />
              </>
            ) : (
              <>
                <span className="tree-spacer" />
                <FileCode2 size={14} />
              </>
            )}
            <span>{entry.name}</span>
          </button>
          {entry.directory && expanded.includes(entry.path) && (
            <Tree
              path={entry.path}
              depth={depth + 1}
              active={active}
              onOpen={onOpen}
              onError={onError}
            />
          )}
        </div>
      ))}
    </>
  );
}

export default function App() {
  const [project, setProject] = useState<Project | null>(null);
  const [view, setView] = useState<"build" | "plan" | "research">("build");
  const [document, setDocument] = useState<Document | null>(null);
  const [original, setOriginal] = useState("");
  const [editorVersion, setEditorVersion] = useState(0);
  const [treeVersion, setTreeVersion] = useState(0);
  const [messages, setMessages] = useState<Message[]>([]);
  const [prompt, setPrompt] = useState("");
  const [inputMode, setInputMode] = useState<"ask" | "run">("ask");
  const [agentMode, setAgentMode] = useState<AgentMode>("discuss");
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const [plan, setPlan] = useState(INITIAL_PLAN);
  const [model, setModel] = useState("");
  const [agents, setAgents] = useState<AgentStatus | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [connectionTab, setConnectionTab] = useState<"ollama" | "chatgpt" | "claude" | "openai" | "anthropic">("chatgpt");
  const [connections, setConnections] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [review, setReview] = useState<FileProposal | null>(null);
  const [sources, setSources] = useState<ResearchSource[]>([]);
  const [sourceIds, setSourceIds] = useState<string[]>([]);
  const [capturing, setCapturing] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [includeFile, setIncludeFile] = useState(false);
  const [includePlan, setIncludePlan] = useState(false);
  const [includeSelection, setIncludeSelection] = useState(true);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [url, setURL] = useState("");
  const [browserPlacement, setBrowserPlacement] = useState<"embedded" | "popup">("embedded");
  const [browserDocked, setBrowserDocked] = useState(false);
  useEffect(() => {
    const offState = api.research.onBrowserState(state => { setBrowserDocked(state.opened && state.docked); if (state.opened) setBrowserPlacement(state.docked ? "embedded" : "popup"); });
    const offDock = api.research.onDock(() => setView("research"));
    return () => { offState(); offDock(); };
  }, []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [activeSession, setActiveSession] = useState<Session | null>(null);
  const [pastSessions, setPastSessions] = useState<SessionSummary[] | null>(null);
  const [switchingSession, setSwitchingSession] = useState(false);
  const changingSession = useRef(false);
  const [sessionReady, setSessionReady] = useState(false);
  const [saveStatus, setSaveStatus] = useState("Local workspace");
  const [dragging, setDragging] = useState(false);
  const activeReply = useRef<string | null>(null);
  const scrollEnd = useRef<HTMLDivElement>(null);
  const dirty = Boolean(document && document.text !== original);
  const reportError = useCallback(
    (err: unknown) =>
      setError(
        String(err instanceof Error ? err.message : err).replace(
          /^Error invoking remote method '[^']+': Error: /,
          "",
        ),
      ),
    [],
  );

  const discover = useCallback(async () => {
    setDiscovering(true);
    try {
      const status = await api.agents.discover();
      setAgents(status);
      setModel(
        (current) =>
          current ||
          status.models.find((m) => m.startsWith("gpt-oss:20b")) ||
          availableModels(status)[0] ||
          "",
      );
    } catch (err) {
      reportError(err);
    } finally {
      setDiscovering(false);
    }
  }, [reportError]);

  useEffect(() => {
    void discover();
  }, [discover]);
  useEffect(() => {
    let live = true;
    void (async () => {
      const current = await api.project.current();
      const saved = await api.session.read();
      if (!live) return;
      setProject(current);
      if (saved) {
        setActiveSession(saved);
        setMessages(saved.messages);
        setPlan(saved.plan || INITIAL_PLAN);
        setSources(saved.sources ?? []);
        if (saved.model) setModel(saved.model);
      }
      setSessionReady(true);
    })().catch(reportError);
    return () => {
      live = false;
    };
  }, [reportError]);
  useEffect(() => api.research.onSelection(setSelection), []);
  useEffect(
    () =>
      api.agents.onEvent((event) => {
        if (event.id !== activeReply.current) return;
        if (event.activity || event.proposal)
          setMessages((current) =>
            current.map((message) =>
              message.id === event.id
                ? {
                    ...message,
                    ...(event.activity
                      ? {
                          activity: [
                            ...(message.activity ?? []),
                            event.activity,
                          ],
                        }
                      : {}),
                    ...(event.proposal
                      ? {
                          proposals: [
                            ...(message.proposals ?? []),
                            event.proposal,
                          ],
                        }
                      : {}),
                  }
                : message,
            ),
          );
        if (event.delta)
          setMessages((current) =>
            current.map((message) =>
              message.id === event.id
                ? { ...message, content: message.content + event.delta }
                : message,
            ),
          );
        if (event.error) {
          const error = event.error;
          setMessages((current) =>
            current.map((message) =>
              message.id === event.id
                ? {
                    ...message,
                    content: `${message.content}\n\n*${error.replace(/[\[\]<>]/g, "")}*`,
                  }
                : message,
            ),
          );
        }
        if (event.done) {
          if (event.exitCode !== undefined) {
            setMessages((current) =>
              current.map((message) =>
                message.id === event.id
                  ? { ...message, exitCode: event.exitCode }
                  : message,
              ),
            );
            setTreeVersion((n) => n + 1);
          }
          activeReply.current = null;
          setBusy(false);
        }
      }),
    [],
  );
  useEffect(() => {
    scrollEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (!sessionReady || !activeSession) return;
    if (!messages.length && plan === INITIAL_PLAN && !sources.length) { setSaveStatus("New session"); return; }
    setSaveStatus("Saving locally…");
    const timer = setTimeout(() => {
      void api.session
        .write({ ...activeSession!, messages, model, plan, sources }, project?.root ?? null)
        .then(() => setSaveStatus("Saved locally"))
        .catch(reportError);
    }, 500);
    return () => clearTimeout(timer);
  }, [messages, model, plan, sources, project, sessionReady, activeSession, reportError]);

  const save = useCallback(async () => {
    if (!document) return;
    try {
      const saved = await api.file.save(document);
      setDocument((current) =>
        current?.path === saved.path
          ? { ...current, revision: saved.revision }
          : current,
      );
      setOriginal(saved.text);
      setError("");
    } catch (err) {
      reportError(err);
    }
  }, [document, reportError]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (dirty) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (view === "build") void save();
      }
      if (event.key === "Escape") { setConnections(false); setPastSessions(null); }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [save, view]);

  const saveConversation = async () => {
    if (activeSession && (messages.length || plan !== INITIAL_PLAN || sources.length))
      await api.session.write({ ...activeSession, messages, model, plan, sources }, project?.root ?? null);
  };
  const loadConversation = (saved: Session) => {
    setActiveSession(saved); setMessages(saved.messages); setPlan(saved.plan || INITIAL_PLAN);
    setSources(saved.sources ?? []); setSourceIds([]); setAttachments([]); setSelection(null);
    setReview(null); setPrompt(""); setInputMode("ask"); setAgentMode("discuss"); setError("");
    if (saved.model) setModel(saved.model);
  };
  const changeConversation = async (id?: string) => {
    if (busy || changingSession.current) return;
    changingSession.current = true; setSwitchingSession(true); setSessionReady(false);
    try {
      await saveConversation();
      loadConversation(id ? await api.session.resume(id) : await api.session.start());
      setPastSessions(null);
    } catch (error) { reportError(error); }
    finally { setSessionReady(true); setSwitchingSession(false); changingSession.current = false; }
  };
  const showSessions = async (last = false) => {
    if (busy || changingSession.current) return;
    try {
      await saveConversation();
      const sessions = await api.session.list();
      const previous = sessions.find(session => session.id !== activeSession?.id);
      if (last && previous) await changeConversation(previous.id);
      else setPastSessions(sessions);
    } catch (error) { reportError(error); }
  };
  const openProject = async () => {
    if (dirty)
      return setError(
        "Save or discard your editor changes before opening another project.",
      );
    if (busy || changingSession.current)
      return setError("Stop the current reply before changing projects.");
    changingSession.current = true; setSwitchingSession(true); setSessionReady(false);
    try {
      await saveConversation();
      const next = await api.project.open();
      if (!next) return;
      setSessionReady(false);
      setProject(next);
      setDocument(null);
      setOriginal("");
      setAttachments([]);
      setSelection(null);
      setSources([]);
      setSourceIds([]);
      setReview(null);
      setMessages([]);
      setPlan(INITIAL_PLAN);
      setTerminalOpen(false);
      setTreeVersion((n) => n + 1);
      setError("");
      try {
        const saved = await api.session.read();
        loadConversation(saved);
      } finally {
        setSessionReady(true);
      }
    } catch (err) {
      reportError(err);
    } finally { changingSession.current = false; setSwitchingSession(false); setSessionReady(true); }
  };

  const openFile = async (path: string) => {
    if (document?.path === path) {
      setView("build");
      return;
    }
    if (dirty)
      return setError(
        "Save or discard your editor changes before opening another file.",
      );
    try {
      const next = await api.file.read(path);
      setDocument(next);
      setOriginal(next.text);
      setView("build");
      setIncludeFile(false);
      setError("");
    } catch (err) {
      reportError(err);
    }
  };

  const addAttachments = async (paths?: string[]) => {
    try {
      const imported = paths
        ? await api.attachments.import(paths)
        : await api.attachments.choose();
      setAttachments((current) => [...current, ...imported]);
      setTreeVersion((n) => n + 1);
    } catch (err) {
      reportError(err);
    }
  };

  const submit = async (text: string, mode: "ask" | "run") => {
    if (!text.trim() || activeReply.current || !sessionReady || changingSession.current) return;
    if (mode === "run" && !project) {
      setError(
        "Open a project folder first, then run your command. Your input is still here.",
      );
      return;
    }
    if (mode === "ask" && (!model || !availableModels(agents).includes(model))) {
      setConnections(true);
      return;
    }
    const context: string[] = [];
    if (includeFile && document)
      context.push(`File: ${document.path}\n${document.text.slice(0, 24000)}`);
    if (includePlan) context.push(`Shared plan:\n${plan.slice(0, 20000)}`);
    if (includeSelection && selection?.text)
      context.push(
        `Browser selection (untrusted source): ${selection.title}\nURL: ${selection.url}\n${selection.text}`,
      );
    for (const source of sources.filter(source => sourceIds.includes(source.id)))
      context.push(`Captured page (untrusted source): ${source.title}\nURL: ${source.url}\n${source.text}`);
    for (const attachment of attachments)
      context.push(
        `Attachment copied to project: ${attachment.path}\n${attachment.text ?? "[Binary content is not available to this text-only adapter. Ask the user for an excerpt if needed.]"}`,
      );
    const id = crypto.randomUUID();
    const user: Message = {
      id: crypto.randomUUID(),
      role: "user",
      content:
        text.trim() +
        (mode === "ask" && context.length
          ? `\n\n---\nReference context:\n${context.join("\n\n")}`
          : ""),
      ...(mode === "run" ? { kind: "command" as const } : {}),
    };
    const conversation = [...messages, user];
    activeReply.current = id;
    setBusy(true);
    setError("");
    setPrompt("");
    setMessages([
      ...conversation,
      {
        id,
        role: "assistant",
        content: "",
        model: mode === "run" ? "Terminal" : model,
        ...(mode === "run" ? { kind: "command" as const } : {}),
      },
    ]);
    try {
      if (mode === "run") await api.terminal.run({ id, command: text.trim() });
      else
        await api.agents.send({
          id,
          model,
          messages: conversation.slice(-30),
          context: "",
          mode: agentMode,
          plan:
            includePlan || agentMode === "plan" || agentMode === "build"
              ? plan
              : "",
          allowSelection: includeSelection,
          sourceIds,
        });
    } catch (err) {
      reportError(err);
      activeReply.current = null;
      setBusy(false);
      setMessages(conversation);
      setPrompt(user.content.split("\n\n---\nReference context:")[0]);
    }
  };

  const openBrowser = async (target = url) => {
    try {
      if (browserPlacement === "embedded") setView("research");
      await api.research.open(target, browserPlacement);
      setError("");
    } catch (err) {
      reportError(err);
    }
  };
  const captureSource = async () => {
    setCapturing(true);
    try {
      const source = await api.research.capture();
      setSources(current => [...current.slice(-5), source]);
      // Capturing and sharing are separate, visible choices.
      setSourceIds(current => current.filter(id => sources.slice(-5).some(source => source.id === id)));
      setError("");
    } catch (error) { reportError(error); }
    finally { setCapturing(false); }
  };
  const finishReview = (status: "applied" | "discarded", saved?: Document) => {
    setMessages(current => current.map(message => ({ ...message, proposals: message.proposals?.map(p => p.kind === "file" && p.id === review?.id ? { ...p, status } : p) })));
    setReview(null);
    if (saved) {
      setDocument(saved); setOriginal(saved.text); setEditorVersion(n => n + 1);
      setTreeVersion(n => n + 1); setView("build"); setError("");
    }
  };
  const startShell = async () => {
    try {
      await api.terminal.start();
    } catch (err) {
      reportError(err);
    }
  };
  const dispatchSlash = async (name: string, argument: string) => {
    if (!workspaceCommands.some((command) => command.name === name)) {
      setError(
        `Unknown workspace command /${name}. Type /help to see the available commands.`,
      );
      return;
    }
    setSlashDismissed(true);
    if (name === "ask" || name === "run") {
      setInputMode(name);
      if (!argument) {
        setPrompt(`/${name} `);
        composerRef.current?.focus();
        return;
      }
      await submit(argument, name);
      return;
    }
    setPrompt("");
    if (name === "help")
      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          kind: "workspace",
          model: "Workspace",
          content: `Workspace commands\n\n${workspaceCommands.map((command) => `- **/${command.name}**${command.argument ? ` ${command.argument}` : ""} — ${command.description}`).join("\n")}\n\nAsk sends text to your model. Run executes your exact command with your normal OS permissions. Each command starts in the project folder; use the shell panel for interactive sessions. The workspace owns the agent loop and tool permissions.`,
        },
      ]);
    if (name === "new") await changeConversation();
    if (name === "resume") await showSessions(argument === "last");
    if (name === "discuss") {
      setAgentMode("discuss");
      setInputMode("ask");
    }
    if (name === "plan" || name === "build") {
      setView(name);
      setAgentMode(name);
      setInputMode("ask");
    }
    if (name === "research") {
      setView("research");
      setAgentMode("research");
      setInputMode("ask");
      if (argument) {
        setURL(argument);
        await openBrowser(argument);
      }
    }
    if (name === "open") await openProject();
    if (name === "attach") await addAttachments();
    if (name === "agents") setConnections(true);
    if (name === "terminal") {
      setTerminalOpen(true);
      await startShell();
    }
    if (name === "stop") await api.agents.stop().catch(reportError);
  };
  const send = async () => {
    const text = prompt.trim();
    if (!text) return;
    if (text.startsWith("/")) {
      const match = /^\/(\S+)\s*([\s\S]*)$/.exec(text);
      if (match) await dispatchSlash(match[1].toLowerCase(), match[2]);
      return;
    }
    await submit(text, inputMode);
  };
  const slashMatches =
    !slashDismissed && /^\/\S*$/.test(prompt)
      ? workspaceCommands.filter((command) =>
          command.name.startsWith(prompt.slice(1).toLowerCase()),
        )
      : [];
  const chooseSlash = (name: string) => {
    if (["ask", "run", "research"].includes(name)) {
      setPrompt(`/${name} `);
      setSlashDismissed(true);
      if (name === "ask" || name === "run") setInputMode(name);
      composerRef.current?.focus();
    } else void dispatchSlash(name, "").catch(reportError);
  };
  const resizeChat = (event: React.PointerEvent) => {
    const startX = event.clientX;
    const initial = documentElementWidth();
    const move = (moveEvent: PointerEvent) =>
      window.document.documentElement.style.setProperty(
        "--chat-width",
        `${Math.min(580, Math.max(300, initial + startX - moveEvent.clientX))}px`,
      );
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  };
  const connected = Boolean(model && availableModels(agents).includes(model));

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">
            <Layers3 size={20} />
          </div>
          <strong>
            AI<span>GUI</span>
          </strong>
          <span className="preview-label">PREVIEW</span>
        </div>
        <button className="project-switch" onClick={() => void openProject()}>
          <FolderOpen size={15} />
          <span>{project?.name ?? "Open a workspace"}</span>
          <ChevronDown size={13} />
        </button>
        <nav className="view-switch" aria-label="Workspace view">
          <button
            className={view === "plan" ? "selected" : ""}
            onClick={() => setView("plan")}
          >
            <BookOpen size={14} />
            Plan
          </button>
          <button
            className={view === "build" ? "selected" : ""}
            onClick={() => setView("build")}
          >
            <Code2 size={15} />
            Build
          </button>
          <button
            className={view === "research" ? "selected" : ""}
            onClick={() => setView("research")}
          >
            <Globe2 size={14} />
            Research
          </button>
        </nav>
        <div className="topbar-spacer" />
        <button className="agent-pill" onClick={() => setConnections(true)}>
          <span className={`status-dot ${connected ? "online" : ""}`} />
          <span>{connected ? model : "Connect an agent"}</span>
          <ChevronDown size={13} />
        </button>
        <button
          className="icon-button"
          title="Connections"
          aria-label="Connections"
          onClick={() => setConnections(true)}
        >
          <Settings2 size={17} />
        </button>
        <WindowControls onError={reportError} />
      </header>

      <div className="workspace-grid">
        <aside className="sidebar">
          <div className="section-label">
            WORKSPACE
            <button
              className="icon-button"
              title="Refresh files"
              aria-label="Refresh files"
              disabled={!project}
              onClick={() => setTreeVersion((n) => n + 1)}
            >
              <RefreshCw size={13} />
            </button>
          </div>
          <button
            className={`side-item ${view === "plan" ? "active" : ""}`}
            onClick={() => setView("plan")}
          >
            <BookOpen size={16} />
            <span>Project brief</span>
            <span className="tiny-tag">LOCAL</span>
          </button>
          <button
            className={`side-item ${view === "research" ? "active" : ""}`}
            onClick={() => setView("research")}
          >
            <Globe2 size={16} />
            <span>Research</span>
            {selection?.text && <span className="purple-dot" />}
          </button>
          <div className="section-label files-label">
            FILES
            <button
              className="icon-button"
              title="Open project"
              aria-label="Open project"
              onClick={() => void openProject()}
            >
              <Plus size={14} />
            </button>
          </div>
          <div className="tree-scroll">
            {project ? (
              <Tree
                key={`${project.root}:${treeVersion}`}
                active={document?.path}
                onOpen={(path) => void openFile(path)}
                onError={reportError}
              />
            ) : (
              <div className="sidebar-empty">
                <Folder size={25} />
                <p>Your project starts here.</p>
                <button onClick={() => void openProject()}>
                  Open a folder <ChevronRight size={12} />
                </button>
              </div>
            )}
          </div>
          <div className="sidebar-footer">
            <ShieldCheck size={16} />
            <div>
              <strong>On your machine</strong>
              <span>Local files. No app backend.</span>
            </div>
          </div>
        </aside>

        <main className="workbench">
          <div className="editor-toolbar">
            <div className="file-tab">
              {view === "build" ? (
                <FileCode2 size={14} />
              ) : view === "plan" ? (
                <BookOpen size={14} />
              ) : (
                <Globe2 size={14} />
              )}
              <span>
                {view === "build"
                  ? (document?.path.split(/[\\/]/).pop() ?? "Start here")
                  : view === "plan"
                    ? "Project brief"
                    : "Research desk"}
              </span>
              {dirty && view === "build" && <span className="dirty-dot" />}
            </div>
            <div className="toolbar-fill" />
            {document && view === "build" && (
              <>
                <button
                  className="text-button"
                  disabled={!dirty}
                  onClick={() => {
                    setDocument({ ...document, text: original });
                    setEditorVersion((n) => n + 1);
                    setError("");
                  }}
                >
                  Discard
                </button>
                <button
                  className="text-button"
                  disabled={!dirty}
                  onClick={() => void save()}
                >
                  <Save size={13} />
                  Save
                </button>
              </>
            )}
            <button
              className={`icon-button ${terminalOpen ? "lit" : ""}`}
              title="Toggle terminal"
              aria-label="Toggle terminal"
              onClick={() => setTerminalOpen(!terminalOpen)}
            >
              <PanelBottom size={16} />
            </button>
          </div>
          {view === "build" &&
            (document ? (
              <div className="editor-container">
                <div className="breadcrumb">
                  {project?.name}
                  <ChevronRight size={11} />
                  {document.path}
                </div>
                <Editor
                  key={`${document.path}:${editorVersion}`}
                  path={document.path}
                  theme="workspace"
                  defaultValue={document.text}
                  onChange={(text) =>
                    setDocument((current) =>
                      current ? { ...current, text: text ?? "" } : null,
                    )
                  }
                  options={{
                    editContext: false,
                    fontSize: 13,
                    fontFamily: '"DejaVu Sans Mono", monospace',
                    minimap: { enabled: false },
                    padding: { top: 16 },
                    scrollBeyondLastLine: false,
                    automaticLayout: true,
                    wordWrap: "on",
                    bracketPairColorization: { enabled: true },
                  }}
                />
              </div>
            ) : (
              <section className="welcome">
                <div className="eyebrow">
                  <span className="purple-dot" /> A SHARED PLACE TO THINK &
                  BUILD
                </div>
                <div className="welcome-symbol">
                  <Layers3 size={38} strokeWidth={1.2} />
                </div>
                <h1>
                  Your ideas.
                  <br />
                  <span>A little more possibility.</span>
                </h1>
                <p>
                  A workspace for you and your agents.
                  <br />
                  Explore the plan, work in the code, stay in control.
                </p>
                <button
                  className="primary-button open-folder"
                  onClick={() => void openProject()}
                >
                  <FolderOpen size={17} />
                  {project ? "Choose another project" : "Open a project"}
                  <ChevronRight size={16} />
                </button>
                <div className="welcome-cards">
                  <button onClick={() => setView("plan")}>
                    <BookOpen size={18} />
                    <strong>Think it through</strong>
                    <span>Shape a brief together</span>
                    <ChevronRight size={14} />
                  </button>
                  <button onClick={() => setView("research")}>
                    <Globe2 size={18} />
                    <strong>Bring the context</strong>
                    <span>Research without losing place</span>
                    <ChevronRight size={14} />
                  </button>
                </div>
                <div className="welcome-footnote">
                  <Command size={12} />
                  Built for collaboration. You keep the controls.
                </div>
              </section>
            ))}
          {view === "plan" && (
            <section className="plan-view">
              <div className="page-heading">
                <span className="eyebrow">THINK TOGETHER</span>
                <h2>A little clarity before the code.</h2>
                <p>
                  Keep your brief, tradeoffs, and decisions in one place.
                  Include it in your next message when you want a second
                  perspective.
                </p>
              </div>
              <div className="plan-toolbar">
                <span>
                  <BookOpen size={14} />
                  Project brief <small>Markdown</small>
                </span>
                <label>
                  <input
                    type="checkbox"
                    checked={includePlan}
                    onChange={(e) => setIncludePlan(e.target.checked)}
                  />
                  Include in chat
                </label>
              </div>
              <textarea
                className="plan-editor"
                aria-label="Project brief"
                value={plan}
                onChange={(e) => setPlan(e.target.value)}
                spellCheck={false}
              />
              <div className="plan-footnote">
                {project
                  ? "Saved in local app data for this project. The brief is not yet exported as a project file."
                  : "Saved locally with your quick chat. No project folder needed."}
              </div>
            </section>
          )}
          {view === "research" && (
            <section className={`research-view ${browserDocked ? "has-browser" : ""}`}>
              <div className="page-heading">
                <span className="eyebrow">FOLLOW YOUR CURIOSITY</span>
                <h2>The web, in the conversation.</h2>
                <p>
                  Open a page, highlight a passage, and ask about it. Your
                  selection appears here and can travel with your next message.
                </p>
              </div>
              <form
                className="browser-address"
                onSubmit={(e) => {
                  e.preventDefault();
                  void openBrowser();
                }}
              >
                <Globe2 size={17} />
                <input
                  aria-label="Research URL"
                  value={url}
                  onChange={(e) => setURL(e.target.value)}
                  placeholder="Search or enter a website"
                />
                <select aria-label="Browser placement" value={browserPlacement} onChange={event => setBrowserPlacement(event.target.value as "embedded" | "popup")}><option value="embedded">In workspace</option><option value="popup">Pop-out window</option></select>
                <button className="primary-button" type="submit">
                  Open browser <ArrowUp size={14} className="diagonal" />
                </button>
              </form>
              {browserDocked && <BrowserDock hidden={connections || !!pastSessions || !!review} />}
              <div className="research-details">
              <div className="research-card">
                <div className="section-label">
                  <span>
                    <Radio size={14} /> LIVE SELECTION
                  </span>
                  <span className="tiny-tag">
                    {selection?.text ? "CAPTURED" : "LISTENING"}
                  </span>
                </div>
                {selection?.text ? (
                  <>
                    <h3>{selection.title || "Selected passage"}</h3>
                    <div className="source-url">{selection.url}</div>
                    <blockquote>{selection.text}</blockquote>
                    <label className="context-check">
                      <input
                        type="checkbox"
                        checked={includeSelection}
                        onChange={(e) => setIncludeSelection(e.target.checked)}
                      />
                      Include with my next message
                    </label>
                  </>
                ) : (
                  <div className="research-empty">
                    <Search size={28} />
                    <p>Highlight something worth discussing.</p>
                    <span>
                      Selection capture works on the main page.
                      <br />
                      Forms and embedded frames are excluded.
                    </span>
                  </div>
                )}
              </div>
              <div className="sources-heading"><span className="section-label">COLLECTED SOURCES · {sources.length}/6</span><button className="secondary-button" disabled={capturing} onClick={() => void captureSource()}>{capturing ? "Capturing…" : "Capture current page"}</button></div>
              <p className="sources-hint">Capture page text, links and image references. Share up to three sources with your next message.</p>
              {sources.map(source => <article className="source-card" key={source.id}>
                <div className="source-title"><h3>{source.title || "Untitled page"}</h3><label><input type="checkbox" checked={sourceIds.includes(source.id)} disabled={!sourceIds.includes(source.id) && sourceIds.length >= 3} onChange={event => setSourceIds(ids => event.target.checked ? [...ids, source.id] : ids.filter(id => id !== source.id))} />Share in chat</label></div>
                <button className="markdown-link source-url" onClick={() => void openBrowser(source.url)}>{source.url}</button>
                <small>{new Date(source.capturedAt).toLocaleString()} · {source.text.length.toLocaleString()} characters{source.truncated ? " · excerpt" : ""}</small>
                <details><summary>Read captured text</summary><pre>{source.text || "No readable page text found."}</pre></details>
                {!!source.links.length && <details><summary>{source.links.length} page links</summary>{source.links.map(link => <button key={link.url} className="source-reference" onClick={() => void openBrowser(link.url)}>{link.label || link.url}</button>)}</details>}
                {!!source.images.length && <details><summary>{source.images.length} image references</summary>{source.images.map(image => <button key={image.url} className="source-reference" onClick={() => void openBrowser(image.url)}>{image.label || image.url}</button>)}</details>}
              </article>)}
              <div className="research-note">
                <ShieldCheck size={18} />
                <p>
                  The research browser is sandboxed and has no terminal or
                  filesystem bridge. Live selection is visible to you; it is
                  sent to the model only with your message.
                </p>
              </div>
              </div>
            </section>
          )}
          <div className={`terminal-panel ${terminalOpen ? "visible" : ""}`}>
            <div className="terminal-toolbar">
              <span>
                <TerminalSquare size={14} />
                TERMINAL
              </span>
              <small>User-controlled shell</small>
              <div className="toolbar-fill" />
              <button
                className="text-button"
                disabled={!project}
                onClick={() => void startShell()}
              >
                Start shell
              </button>
              <button
                className="icon-button"
                title="Hide terminal"
                aria-label="Hide terminal"
                onClick={() => setTerminalOpen(false)}
              >
                <X size={14} />
              </button>
            </div>
            {project ? (
              <Terminal
                key={project.root}
                project={project.root}
                onError={reportError}
              />
            ) : (
              <div className="terminal-placeholder">
                Open a project to use its terminal.
              </div>
            )}
          </div>
        </main>

        <div
          className="resize-handle"
          role="separator"
          aria-label="Resize conversation"
          aria-orientation="vertical"
          onPointerDown={resizeChat}
        />
        <aside
          className={`conversation ${dragging ? "drop-active" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node))
              setDragging(false);
          }}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const files = Array.from(e.dataTransfer.files)
              .map((file) => api.attachments.path(file))
              .filter(Boolean);
            if (files.length) void addAttachments(files);
          }}
        >
          <div className="conversation-title">
            <span>
              <MessageSquare size={16} />
              Conversation
            </span>
            <select
              className="agent-mode-select"
              aria-label="Agent mode"
              value={agentMode}
              disabled={busy}
              onChange={(event) =>
                setAgentMode(event.target.value as AgentMode)
              }
            >
              <option value="discuss">Discuss</option>
              <option value="plan">Plan</option>
              <option value="build">Build</option>
              <option value="research">Research</option>
            </select>
          </div>
          <div className="session-toolbar"><span title={activeSession?.id}>{messages.length ? activeSession?.title === "New conversation" ? messages.find(message => message.role === "user")?.content.split("\n")[0]?.slice(0, 35) || "Conversation" : activeSession?.title : "New conversation"}</span><button className="icon-button" aria-label="New chat" title="New chat · /new" disabled={busy || switchingSession} onClick={() => void changeConversation()}><Plus size={15} /></button><button className="icon-button" aria-label="Resume chat" title="Resume chat · /resume" disabled={busy || switchingSession} onClick={() => void showSessions()}><History size={15} /></button></div>
          <div className="conversation-subtitle">
            {
              {
                discuss: "Conversation · no tools",
                plan: "Read project files · propose a brief",
                build: "Read files · propose edits and commands",
                research: "Read shared sources · suggest pages",
              }[agentMode]
            }
          </div>
          <div className="messages" aria-live="polite">
            {!messages.length && (
              <div className="chat-empty">
                <div className="assistant-avatar">
                  <Sparkles size={21} strokeWidth={1.4} />
                </div>
                <h3>What are we thinking about?</h3>
                <p>
                  Bring a half-formed idea, a tricky function,
                  <br />
                  or the question you haven’t asked yet.
                </p>
                <div className="prompt-suggestions">
                  {[
                    "Help me shape the project brief",
                    "Talk through the tradeoffs with me",
                    "Review the file I’m working on",
                  ].map((text, index) => (
                    <button
                      key={text}
                      onClick={() => {
                        setPrompt(text);
                        if (index === 0) {
                          setIncludePlan(true);
                          setView("plan");
                        }
                        if (index === 2) setIncludeFile(true);
                      }}
                    >
                      <span>{text}</span>
                      <ArrowUp size={13} className="diagonal" />
                    </button>
                  ))}
                </div>
                <div className="empty-chat-note">
                  <ShieldCheck size={12} />
                  You choose the mode. You review the actions.
                </div>
              </div>
            )}
            {messages.map((message) => (
              <article key={message.id} className={`message ${message.role}`}>
                <div className="message-byline">
                  {message.role === "user" ? (
                    <div className="user-avatar">Y</div>
                  ) : (
                    <div className="small-avatar">
                      <Sparkles size={13} />
                    </div>
                  )}
                  <strong>
                    {message.role === "user"
                      ? "You"
                      : message.model || "Assistant"}
                  </strong>
                  {message.role === "assistant" && (
                    <span>
                      {message.kind === "command"
                        ? "SHELL"
                        : message.kind === "workspace"
                          ? "WORKSPACE"
                          : message.model?.startsWith("claude-code/") ? "CLAUDE CODE" : message.model?.startsWith("chatgpt/") ? "PLAN" : /^(openai|anthropic)\//.test(message.model ?? "") ? "API" : "LOCAL"}
                    </span>
                  )}
                </div>
                <div className="message-body">
                  {message.activity?.length ? (
                    <details className="tool-activity">
                      <summary>
                        {message.activity.length} tool{" "}
                        {message.activity.length === 1 ? "call" : "calls"}
                      </summary>
                      {message.activity.map((name, index) => (
                        <div key={index}>{name}</div>
                      ))}
                    </details>
                  ) : null}
                  {message.kind === "command" ? (
                    <>
                      <pre className="command-output">
                        {message.role === "user"
                          ? `$ ${message.content}`
                          : message.content ||
                            (message.exitCode === undefined
                              ? "Running…"
                              : "No output.")}
                      </pre>
                      {message.role === "assistant" &&
                        message.exitCode !== undefined && (
                          <div className="command-exit">
                            {message.exitCode === null
                              ? "Command stopped"
                              : `Exited with code ${message.exitCode}`}
                          </div>
                        )}
                    </>
                  ) : (
                    <Markdown
                      components={{
                        a: ({ href, children }) => (
                          <button
                            className="markdown-link"
                            onClick={() => {
                              if (href) void openBrowser(href);
                            }}
                          >
                            {children}
                          </button>
                        ),
                        img: () => <span>[Remote image omitted]</span>,
                      }}
                    >
                      {message.content.split(
                        "\n\n---\nReference context:",
                      )[0] || (busy ? "Thinking…" : "")}
                    </Markdown>
                  )}
                  {message.content.includes("\n\n---\nReference context:") && (
                    <details>
                      <summary>Reference context sent</summary>
                      <pre>
                        {
                          message.content.split(
                            "\n\n---\nReference context:",
                          )[1]
                        }
                      </pre>
                    </details>
                  )}
                  {message.proposals?.map((proposal, index) => (
                    <div className="proposal-card" key={index}>
                      <strong>{proposal.kind === "file" ? `Proposed file · ${proposal.path}` : proposal.kind === "command" ? "Proposed command" : proposal.kind === "browse" ? "Suggested page" : "Proposed brief"}</strong>
                      <p>{proposal.reason}</p>
                      {proposal.kind !== "file" && <pre>{proposal.text}</pre>}
                      <button className="secondary-button"
                        disabled={busy || (proposal.kind === "file" && (proposal.status !== "pending" || !project))}
                        onClick={() => {
                          if (proposal.kind === "file") {
                            if (dirty) { setError("Save or discard your editor changes before reviewing a proposal."); return; }
                            setReview(proposal);
                          } else if (proposal.kind === "command") {
                            setInputMode("run"); setPrompt(proposal.text); composerRef.current?.focus();
                          } else if (proposal.kind === "browse") { void openBrowser(proposal.text); setView("research"); }
                          else { setPlan(proposal.text); setView("plan"); }
                        }}>
                        {proposal.kind === "file" ? (proposal.status === "pending" ? "Review changes" : proposal.status === "applied" ? "Applied" : proposal.status === "expired" ? "Expired · request again" : "Discarded") : proposal.kind === "command" ? "Use command" : proposal.kind === "browse" ? "Open page" : "Apply to brief"}
                      </button>
                      <small>{proposal.kind === "file" ? "Inspect and edit the diff before applying." : proposal.kind === "command" ? "Fills the input. Press Run when ready." : proposal.kind === "browse" ? "Opens in your research browser." : "Replaces the current brief after your review."}</small>
                    </div>
                  ))}
                </div>
              </article>
            ))}
            <div ref={scrollEnd} />
          </div>
          <div className="composer-area">
            {model.startsWith("claude-code/") && <div className="remote-context-note">Runs Claude Code · its account and billing apply · shared context is sent to Claude</div>}
            {model.startsWith("chatgpt/") && <div className="remote-context-note chatgpt-plan-note"><span>Using ChatGPT plan · {agents?.chatgpt?.accounts.find(account => account.id === agents.chatgpt?.activeId)?.label ?? "account"}</span><button className="text-button" onClick={() => void window.workspace.chatgpt.usage().catch(reportError)}>Manage usage</button></div>}
            {/^(openai|anthropic)\//.test(model) && <div className="remote-context-note">{model.startsWith("openai/") ? "OpenAI" : "Anthropic"} API · sends recent chat and shared context · API billing applies</div>}
            {slashMatches.length > 0 && (
              <SlashMenu
                commands={slashMatches}
                active={slashIndex}
                onSelect={chooseSlash}
                onHighlight={setSlashIndex}
              />
            )}
            {(document ||
              includePlan ||
              sourceIds.length > 0 ||
              selection?.text ||
              attachments.length > 0) && (
              <div className="context-area">
                <div className="context-label">
                  <Layers3 size={12} />
                  CONTEXT FOR NEXT MESSAGE
                </div>
                <div className="context-chips">
                  {sources.filter(source => sourceIds.includes(source.id)).map(source => <button key={source.id} className="context-chip included" onClick={() => setSourceIds(ids => ids.filter(id => id !== source.id))} title={source.url}><Globe2 size={12} />{source.title.slice(0, 28) || "Captured page"}<X size={11} /></button>)}
                  {document && (
                    <button
                      className={`context-chip ${includeFile ? "included" : ""}`}
                      onClick={() => setIncludeFile(!includeFile)}
                      title="Toggle current editor contents"
                    >
                      <FileCode2 size={12} />
                      {document.path.split(/[\\/]/).pop()}
                      {includeFile ? <Check size={11} /> : <Plus size={11} />}
                    </button>
                  )}
                  {includePlan && (
                    <button
                      className="context-chip included"
                      onClick={() => setIncludePlan(false)}
                    >
                      <BookOpen size={12} />
                      Project brief
                      <X size={11} />
                    </button>
                  )}
                  {selection?.text && (
                    <button
                      className={`context-chip ${includeSelection ? "included" : ""}`}
                      onClick={() => setIncludeSelection(!includeSelection)}
                    >
                      <Globe2 size={12} />
                      Browser selection
                      {includeSelection ? (
                        <Check size={11} />
                      ) : (
                        <Plus size={11} />
                      )}
                    </button>
                  )}
                  {attachments.map((item) => (
                    <button
                      className="context-chip included"
                      key={item.id}
                      onClick={() =>
                        setAttachments((current) =>
                          current.filter((a) => a.id !== item.id),
                        )
                      }
                      title={`${item.path} · ${formatSize(item.size)} · ${item.text ? "Text included" : "File copied; binary contents not sent"} · Click to remove from context`}
                    >
                      <Paperclip size={12} />
                      {item.name}
                      {!item.text && <small>file only</small>}
                      <X size={11} />
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="composer">
              <textarea
                ref={composerRef}
                aria-label="Workspace input"
                aria-controls={
                  slashMatches.length ? "workspace-command-list" : undefined
                }
                aria-activedescendant={
                  slashMatches[slashIndex]
                    ? `workspace-command-${slashMatches[slashIndex].name}`
                    : undefined
                }
                placeholder={
                  inputMode === "run"
                    ? "Enter a shell command, or / for commands…"
                    : "Ask anything, or / for commands…"
                }
                value={prompt}
                onChange={(e) => {
                  setPrompt(e.target.value);
                  setSlashIndex(0);
                  setSlashDismissed(false);
                }}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing) return;
                  if (slashMatches.length) {
                    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                      e.preventDefault();
                      setSlashIndex(
                        (index) =>
                          (index +
                            (e.key === "ArrowDown"
                              ? 1
                              : slashMatches.length - 1)) %
                          slashMatches.length,
                      );
                      return;
                    }
                    if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
                      e.preventDefault();
                      chooseSlash(
                        slashMatches[slashIndex]?.name ?? slashMatches[0].name,
                      );
                      return;
                    }
                    if (e.key === "Escape") {
                      e.preventDefault();
                      setSlashDismissed(true);
                      return;
                    }
                  }
                  if (
                    e.key === "Enter" &&
                    !e.shiftKey &&
                    !e.nativeEvent.isComposing
                  ) {
                    e.preventDefault();
                    void send();
                  }
                }}
              />
              <div className="composer-actions">
                <div className="input-mode" aria-label="Input mode">
                  <button
                    aria-pressed={inputMode === "ask"}
                    className={inputMode === "ask" ? "selected" : ""}
                    onClick={() => {
                      setInputMode("ask");
                      composerRef.current?.focus();
                    }}
                  >
                    Ask
                  </button>
                  <button
                    aria-pressed={inputMode === "run"}
                    className={inputMode === "run" ? "selected" : ""}
                    onClick={() => {
                      setInputMode("run");
                      composerRef.current?.focus();
                    }}
                  >
                    Run
                  </button>
                </div>
                <button
                  className="icon-button"
                  title="Copy attachments into project"
                  aria-label="Attach files"
                  disabled={!project}
                  onClick={() => void addAttachments()}
                >
                  <Paperclip size={16} />
                </button>
                <button
                  className="composer-model"
                  onClick={() => setConnections(true)}
                >
                  {connected ? model : "Select a model"}
                  <ChevronDown size={11} />
                </button>
                <div className="toolbar-fill" />
                {busy ? (
                  <button
                    className="send-button stopping"
                    aria-label="Stop task"
                    onClick={() => void api.agents.stop().catch(reportError)}
                  >
                    <Square size={13} fill="currentColor" />
                  </button>
                ) : (
                  <button
                    className="send-button"
                    disabled={!prompt.trim()}
                    aria-label={
                      inputMode === "run" ? "Run command" : "Send message"
                    }
                    onClick={() => void send()}
                  >
                    <ArrowUp size={18} />
                  </button>
                )}
              </div>
            </div>
            <div className="composer-hint">
              <span>
                {inputMode === "run"
                  ? `Runs in ${project?.name ?? "a project folder"} · /help`
                  : "Ask your agent · /run for shell · /help"}
              </span>
              <span>↵ send</span>
            </div>
          </div>
          {dragging && (
            <div className="drop-overlay">
              <Paperclip size={30} />
              <strong>Add to your project</strong>
              <span>Files are copied, never moved.</span>
            </div>
          )}
        </aside>
      </div>
      <footer className="statusbar">
        <span>
          <span className={`status-dot ${connected ? "online" : ""}`} />
          {connected ? model.startsWith("claude-code/") ? "Claude Code ready" : model.startsWith("chatgpt/") ? "ChatGPT plan ready" : /^(openai|anthropic)\//.test(model) ? "Online API ready" : "Local inference ready" : "No model connected"}
        </span>
        <span className="status-divider" />
        <span>
          {project ? saveStatus : `Quick chat · ${saveStatus.toLowerCase()}`}
        </span>
        <div className="toolbar-fill" />
        <span>TEXT CONTEXT</span>
        <span className="status-divider" />
        <span>Draft 0.1</span>
      </footer>
      {error && (
        <div className="toast" role="alert">
          <span>{error}</span>
          <button
            className="icon-button"
            aria-label="Dismiss notice"
            onClick={() => setError("")}
          >
            <X size={15} />
          </button>
        </div>
      )}

      {pastSessions && <SessionPicker sessions={pastSessions} active={activeSession?.id} project={project?.name ?? "Quick chats"} onClose={() => setPastSessions(null)} onResume={changeConversation} />}
      {review && <FileReview key={review.id} proposal={review} onClose={() => setReview(null)} onApplied={saved => finishReview("applied", saved)} onDiscarded={() => finishReview("discarded")} />}
      {connections && (
        <div
          className="modal-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setConnections(false);
          }}
        >
          <section
            className="connection-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="connections-title"
          >
            <div className="modal-heading">
              <div className="assistant-avatar">
                <Unplug size={21} />
              </div>
              <button
                className="icon-button"
                aria-label="Close connections"
                onClick={() => setConnections(false)}
              >
                <X size={19} />
              </button>
            </div>
            <span className="eyebrow">YOUR TOOLS, ONE WORKSPACE</span>
            <h2 id="connections-title">Connect a model.</h2>
            <p>
              Connect a model. This workspace provides its goals, context,
              tools, and permissions.
            </p>
            <div className="provider-tabs" role="tablist" aria-label="Model providers">{(["chatgpt", "claude", "ollama", "openai", "anthropic"] as const).map(provider => <button key={provider} role="tab" aria-selected={connectionTab === provider} onClick={() => setConnectionTab(provider)}>{provider === "chatgpt" ? "ChatGPT" : provider === "claude" ? "Claude" : provider === "ollama" ? "Local" : provider === "openai" ? "OpenAI API" : "Anthropic API"}</button>)}</div>
            {connectionTab === "claude" && <ClaudeConnection connection={agents?.claude} disabled={busy} onUpdated={status => { setAgents(status); if (status.claude?.models.length) setModel(model.startsWith("claude-code/") ? model : "claude-code/default"); else if (model.startsWith("claude-code/")) setModel(""); }} />}
            {connectionTab === "chatgpt" && <ChatGPTConnection connection={agents?.chatgpt} secureStorage={agents?.secureStorage ?? false} disabled={busy} onUpdated={status => { setAgents(status); const ids = availableModels(status); if (status.chatgpt?.models.length) setModel(`chatgpt/${status.chatgpt.models.find(item => `chatgpt/${item.id}` === model)?.id ?? status.chatgpt.models[0].id}`); else if (model.startsWith("chatgpt/") || !ids.includes(model)) setModel(""); }} />}
            {connectionTab === "ollama" && <div className="connection-card">
              <div className="connection-card-title">
                <div className="provider-icon">
                  <Radio size={21} />
                </div>
                <div>
                  <strong>Ollama</strong>
                  <span>Local model provider · scoped workspace tools</span>
                </div>
                <span
                  className={`connection-state ${agents?.models.length ? "ready" : ""}`}
                >
                  {agents?.models.length ? "Available" : "Not connected"}
                </span>
              </div>
              {agents?.models.length ? (
                <>
                  <label className="model-select-label">
                    Installed model
                    <select
                      aria-label="Local model"
                      value={agents?.models.includes(model) ? model : ""}
                      disabled={busy}
                      onChange={(e) => setModel(e.target.value)}
                    >
                      <option value="" disabled>Choose local model</option>
                      {agents.models.map((name) => (
                        <option key={name}>{name}</option>
                      ))}
                    </select>
                  </label>
                  <p className="connection-detail">
                    Switching preserves this session’s conversation. The most
                    recent 30 messages are sent to the selected local model.
                  </p>
                </>
              ) : (
                <p className="connection-detail">
                  {agents?.ollamaError ||
                    "No installed models found. Start Ollama and install a model, then refresh."}
                </p>
              )}
            </div>}
            {(["openai", "anthropic"] as const).filter(provider => provider === connectionTab).map(provider => <ProviderConnection key={provider} provider={provider} connection={agents?.providers.find(item => item.provider === provider)} secureStorage={agents?.secureStorage ?? false} disabled={busy} onUpdated={status => { setAgents(status); if (!model) setModel(availableModels(status)[0] ?? ""); }} />)}
            <label className="model-select-label">Active model<select aria-label="Active model" value={model} disabled={busy} onChange={event => setModel(event.target.value)}>
              <option value="">Choose a model</option>
              <optgroup label="Claude · installed Claude Code">{agents?.claude?.models.map(item => <option key={item.id} value={`claude-code/${item.id}`}>{item.name}</option>)}</optgroup>
              <optgroup label="ChatGPT · plan">{agents?.chatgpt?.models.map(item => <option key={item.id} value={`chatgpt/${item.id}`}>{item.name}</option>)}</optgroup>
              <optgroup label="Ollama · local">{agents?.models.map(id => <option key={id} value={id}>{id}</option>)}</optgroup>
              {agents?.providers.map(provider => <optgroup key={provider.provider} label={`${provider.provider === "openai" ? "OpenAI" : "Anthropic"} · API`}>{provider.models.map(item => <option key={item.id} value={`${provider.provider}/${item.id}`}>{item.name}</option>)}</optgroup>)}
            </select></label>
            <div className="upcoming-providers"><ShieldCheck size={16} /><p>Requests go directly to the selected provider. Switching models or accounts shares this session’s recent messages and selected context. ChatGPT sign-in uses eligible plan access; API keys have separate billing. Credentials stay on this device.</p></div>
            <div className="modal-actions">
              <button
                className="secondary-button"
                disabled={discovering}
                onClick={() => void discover()}
              >
                <RefreshCw size={14} className={discovering ? "spin" : ""} />
                {discovering ? "Scanning…" : "Refresh discovery"}
              </button>
              <button
                className="primary-button"
                onClick={() => setConnections(false)}
              >
                Back to workspace
                <ChevronRight size={14} />
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function documentElementWidth() {
  return (
    window.document.querySelector(".conversation")?.getBoundingClientRect()
      .width ?? 390
  );
}
