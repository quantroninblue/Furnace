import { useEffect, useRef, useState } from "react";
import type { ChatState, Mode, Model, ResearchState, Usage } from "../protocol";
import { Icon } from "../icons";
import { InfoTip, Menu, type MenuItem } from "../menu";
import { currentMessages, post, setHistoryOpen, setNote, setPrefs, setTimelineOpen, useStore, useSyncedText } from "../store";
import { money } from "./messages";

export const modeNotes: Record<Mode, string> = {
  Discuss: "Discuss · uses only the context you share", Plan: "Plan · reads and searches the project, proposes a brief",
  Build: "Build · reads, edits and creates files, runs commands", Research: "Research · uses shared sources, suggests pages",
};
type Command = { name: string; hint?: string; description: string; run: (arg: string) => void };
type Option = { key: string; label: string; hint?: string; description?: string; icon?: "folder" | "file"; run: () => void };

function Chip({ label, remove, title, tone }: { label: string; remove?: () => void; title?: string; tone?: "warn" }) {
  return (
    <span className={`context-chip included${tone ? ` ${tone}` : ""}`} title={title}>
      <span className="chip-label">{label}</span>
      {remove && <button className="chip-remove" aria-label={`Stop sharing ${label}`} title="Stop sharing" onClick={remove}><Icon name="close" size={10} /></button>}
    </span>
  );
}

function AgentState({ chat, mode }: { chat: ChatState; mode: Mode }) {
  const project = chat.agent?.project;
  let content;
  if (mode === "Build" || mode === "Plan") {
    if (!project) content = <><span>No project folder</span><button className="link" onClick={() => post({ type: "openFolder" })}>Open Folder</button></>;
    else if (!project.trusted) content = <><span className="warn">Restricted Mode</span><button className="link" onClick={() => post({ type: "trustFolder" })}>Trust Folder</button></>;
    else content = <span>{project.name}{chat.permission === "auto" ? chat.agent?.sandbox ? " · sandboxed" : " · no sandbox" : ""}</span>;
  } else content = <span>{mode === "Research" ? "Research tools" : "No tools in Discuss"}</span>;
  return <span id="agent-state" className={`agent-state${chat.permission === "full" ? " full" : ""}`}>{content}</span>;
}

// Autocompute: the online model leads and delegates small tasks to local models.
function Autocompute({ chat }: { chat: ChatState }) {
  const state = chat.autocompute;
  if (!state) return null;
  const locals = state.locals.map(id => id.slice(id.indexOf("/") + 1)).join(", ");
  const tip = !state.enabled ? <>Your online model plans and reviews, and gives small tasks (tests, small edits, docs) to local Ollama models to save online usage. {locals ? `Local models available: ${locals}.` : "No local model with tool calling is connected yet."}</>
    : state.ready ? <>On: your online model plans and reviews; small tasks go to {locals}, within what each model has proven it can do.</>
    : <>On, but can&apos;t run: {state.reason}</>;
  return (
    <InfoTip tip={tip} align="start" className="autocompute-tip">
      <label className={`autocompute-toggle${state.enabled ? state.ready ? " on" : " warn" : ""}`}>
        <input id="autocompute" type="checkbox" checked={state.enabled} disabled={chat.busy} onChange={event => post({ type: "autocompute", enabled: event.target.checked })} />
        Autocompute{state.enabled && !state.ready ? " ⚠" : ""}
      </label>
    </InfoTip>
  );
}

const thousands = (value: number) => value >= 10000 ? `${Math.round(value / 1000)}k` : value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
// How full the model's context window is for the next message (estimated), with what fills it.
function ContextMeter({ usage, busy }: { usage: Usage; busy: boolean }) {
  const percent = Math.min(100, Math.round((usage.used / usage.window) * 100));
  const lines = [`Context for the next message: about ${thousands(usage.used)} of ${thousands(usage.window)} tokens (${percent}%).`,
    `Instructions and tools ~${thousands(usage.system)} · conversation ~${thousands(usage.history)} · shared context ~${thousands(usage.shared)}.`,
    usage.condensed ? `Earlier messages condensed ${usage.condensed} time${usage.condensed === 1 ? "" : "s"}.` : "Older messages are summarised automatically when the conversation fills 60% of the window.",
    usage.measured ? `Last reply: ${thousands(usage.measured.input)} input tokens measured by the provider.` : "",
    usage.source === "counted" ? "Counted with the provider's own tokenizer." : usage.source === "calibrated" ? "Estimate corrected by the provider's count for the last reply." : "Estimated (about 4 characters per token).",
    "Click to condense the conversation now (/compact)."].filter(Boolean);
  return (
    <InfoTip tip={<>{lines.map(line => <span key={line} className="tip-line">{line}</span>)}</>} className="meter-tip">
      <button id="context-meter" className={`context-meter${percent >= 80 ? " high" : percent >= 60 ? " medium" : ""}`} disabled={busy} aria-label={`Context ${percent}% used. Condense now`}
        onClick={() => post({ type: "compact" })}>
        <span className="meter-track"><span className="meter-fill" style={{ width: `${Math.max(2, percent)}%` }} /></span>{percent}%
      </button>
    </InfoTip>
  );
}

// What this chat and this month cost with API keys, the monthly budget, and ChatGPT plan usage.
function Spend({ chat }: { chat: ChatState }) {
  const month = chat.spend?.month.total || 0, budget = chat.budget || 0;
  const plan = chat.model.startsWith("chatgpt/") ? chat.limits?.chatgpt?.plan?.find(item => item.window === "primary") : undefined;
  const parts: string[] = [];
  if (chat.cost) parts.push(`≈ ${money(chat.cost.total)} this chat${chat.cost.unpriced ? "+" : ""}`);
  if (month > 0) parts.push(`${money(month)} this month`);
  if (plan) parts.push(`plan ${Math.round(plan.usedPercent)}% used`);
  if (!parts.length) return null;
  const level = budget > 0 ? month >= budget ? " over" : month >= budget * 0.8 ? " near" : "" : "";
  const lines = [chat.cost ? `Estimated from provider-reported tokens at list prices${chat.cost.unpriced ? `; ${chat.cost.unpriced} repl${chat.cost.unpriced === 1 ? "y has" : "ies have"} no known price (set aiGui.pricing)` : ""}.` : "",
    month ? `API spend from this machine this month: ${money(month)} (today ${money(chat.spend?.today.total || 0)}).` : "",
    budget ? `Monthly budget ${money(budget)} (aiGui.budget.monthlyUsd)${level === " over" ? ": exceeded" : level === " near" ? ": over 80% used" : ""}.` : "Set a monthly budget with aiGui.budget.monthlyUsd.",
    plan ? `ChatGPT plan: ${Math.round(plan.usedPercent)}% of the ${plan.windowMinutes ? `${Math.round(plan.windowMinutes / 60)}-hour` : "current"} window used${plan.resetSeconds ? `, resets in ${Math.ceil(plan.resetSeconds / 60)} min` : ""}.` : ""].filter(Boolean);
  return (
    <InfoTip tip={<>{lines.map(line => <span key={line} className="tip-line">{line}</span>)}</>} align="start" className="spend-tip">
      <span id="spend" tabIndex={0} className={`spend${level}`}>{parts.join(" · ")}{level === " over" ? " · over budget" : ""}</span>
    </InfoTip>
  );
}

// Models grouped by how they are billed, with what each one accepts.
const providers: [string, string][] = [["chatgpt/", "ChatGPT plan"], ["claude-code/", "Claude Code"], ["openai/", "OpenAI API"], ["anthropic/", "Anthropic API"]];
const providerOf = (id: string) => providers.find(([prefix]) => id.startsWith(prefix))?.[1] ?? "Local · Ollama";
function modelItems(models: Model[], current: string): MenuItem[] {
  const items: MenuItem[] = [];
  for (const group of [...providers.map(([, name]) => name), "Local · Ollama"]) {
    const inGroup = models.filter(model => providerOf(model.id) === group);
    if (!inGroup.length) continue;
    items.push({ kind: "heading", label: group });
    for (const model of inGroup) items.push({ key: model.id, label: model.name, checked: model.id === current, onSelect: () => post({ type: "model", value: model.id }),
      badges: [model.size, model.vision ? "images" : "", model.tools === false ? "no tools" : ""].filter((badge): badge is string => !!badge) });
  }
  items.push({ kind: "heading", label: models.length ? "More" : "No model connected" });
  items.push({ key: "connections", label: "Manage connections…", description: "ChatGPT, Claude Code, API keys or Ollama", onSelect: () => post({ type: "connections" }) });
  return items;
}
const modeTone: Record<Mode, string> = { Discuss: "discuss", Plan: "plan", Build: "build", Research: "research" };
const placeholders: Record<Mode, string> = { Discuss: "Talk it through", Plan: "What should we plan?", Build: "Describe the change", Research: "What should we look into?" };

// The @mention or slash token being typed at the cursor.
function tokenAt(text: string, caret: number) {
  const before = text.slice(0, caret);
  const mention = /(?:^|\s)@("?[^\s"@]*)$/.exec(before);
  if (mention) return { kind: "mention" as const, query: mention[1], start: caret - mention[1].length - 1 };
  const slash = /^\/(\S*)$/.exec(text);
  if (slash) return { kind: "slash" as const, query: slash[1], start: 0 };
  return null;
}
const readImage = (file: File) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, "")); reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(file);
});

export function Composer({ chat, research, mode, draft: serverDraft }: { chat: ChatState; research: ResearchState; mode: Mode; draft: string }) {
  const input = useStore(value => value.prefs.input), mentions = useStore(value => value.mentions);
  const [draft, setDraft] = useSyncedText(serverDraft, value => post({ type: "draft", value }));
  const [index, setIndex] = useState(0);
  const [paletteOpen, setPaletteOpen] = useState(true);
  const [caret, setCaret] = useState(0);
  const field = useRef<HTMLTextAreaElement>(null);
  const update = (value: string, focus = false, at = value.length) => {
    setDraft(value); setIndex(0); setPaletteOpen(true); setCaret(at);
    if (focus) requestAnimationFrame(() => { field.current?.focus(); field.current?.setSelectionRange(at, at); });
  };
  const setInput = (value: "ask" | "run") => { setPrefs({ input: value }); field.current?.focus(); };

  const modeCommand = (name: Mode): Command => ({ name: name.toLowerCase(), description: modeNotes[name].split(" · ")[1].replace(/^./, c => c.toUpperCase()), run: () => { update(""); post({ type: "mode", value: name }); } });
  const simple = (name: string, description: string, action: Parameters<typeof post>[0]): Command => ({ name, description, run: () => { update(""); post(action); } });
  const commands: Command[] = [
    { name: "ask", hint: "prompt", description: "Talk to your selected model", run: arg => { setInput("ask"); update(arg, true); } },
    { name: "run", hint: "command", description: "Run a shell command in this project", run: arg => { if (arg) { post({ type: "run", value: arg }); update(""); } else { setInput("run"); update("", true); } } },
    simple("new", "Start a fresh conversation", { type: "newChat" }),
    { name: "history", description: "Search, open, rename or delete conversations", run: () => { update(""); setHistoryOpen(true); } },
    simple("resume", "Resume a previous conversation", { type: "resumeChat" }),
    ...(["Discuss", "Plan", "Build", "Research"] as Mode[]).map(modeCommand),
    simple("build-plan", "Build the shared brief step by step, ticking off its checklist", { type: "buildPlan" }),
    simple("compact", "Condense the conversation into a summary now", { type: "compact" }),
    { name: "background", hint: "task", description: "Run a Build task in its own Git worktree while you keep working", run: arg => { if (arg) { post({ type: "backgroundStart", value: arg }); update(""); } else update("/background ", true); } },
    { name: "timeline", description: "Jump to, compare or restore earlier points", run: () => { update(""); setTimelineOpen(true); } },
    { name: "review", description: "Second opinion: another model reviews the last changes", run: () => { update(""); const reply = [...currentMessages()].reverse().find(message => message.changes?.files.some(file => !file.reverted)); if (reply) post({ type: "reviewChanges", messageId: reply.id }); else setNote("No agent changes to review yet."); } },
    simple("edit", "Inline edit: change the selected code in the editor", { type: "inlineEdit" }),
    simple("connections", "Connect ChatGPT, Claude, API keys or Ollama", { type: "connections" }),
    { name: "autocompute", hint: "on|off|reset", description: "Let your online model delegate small Build tasks to local models (reset clears their records)", run: arg => { update(""); if (arg === "reset") post({ type: "autocomputeReset" }); else post({ type: "autocompute", enabled: arg === "on" ? true : arg === "off" ? false : !chat.autocompute?.enabled }); } },
    { name: "permissions", hint: "ask|auto|full", description: "Change what the agent may do without asking", run: arg => { update(""); if (arg === "ask" || arg === "auto" || arg === "full") post({ type: "permission", value: arg }); else document.getElementById("permission")?.focus(); } },
    simple("attach", "Import files as context", { type: "attach" }),
    simple("changes", "Show agent and Git changes in Source Control", { type: "openScm" }),
    simple("workspace", "Open the workspace view (plan, research, rules, activity)", { type: "home" }),
    simple("stop", "Stop the current reply or command", { type: "stop" }),
    simple("tour", "Begin the interactive tutorial", { type: "tutorial" }),
    simple("help", "Open Furnace Help", { type: "help" }),
    { name: "theme", hint: "name|new", description: "Choose a theme, or create your own (also the Themes menu)", run: arg => { update(""); post({ type: "themeCommand", value: arg }); } },
    simple("keys", "Show and change keyboard shortcuts", { type: "keys" }),
    simple("diagnostics", "Copy diagnostics for a bug report", { type: "diagnostics" }),
    simple("feedback", "Send feedback about Furnace", { type: "feedback" }),
    { name: "zoom", hint: "in|out|reset", description: "Make all text larger or smaller", run: arg => { update(""); post({ type: arg === "out" ? "textSmaller" : arg === "reset" ? "textReset" : "textLarger" }); } },
    { name: "help", description: "Show these commands", run: () => update("/", true) },
  ];
  const token = tokenAt(draft, caret);
  // @ asks the extension for matching project paths; results arrive in the store.
  useEffect(() => {
    if (token?.kind !== "mention") return;
    const timer = setTimeout(() => post({ type: "mentionSearch", value: token.query }), 100);
    return () => clearTimeout(timer);
  }, [token?.kind, token?.query]);
  const insertMention = (path: string) => {
    if (!token) return;
    const value = /\s/.test(path) ? `@"${path}" ` : `@${path} `, end = caret;
    update(draft.slice(0, token.start) + value + draft.slice(end), true, token.start + value.length);
  };
  const options: Option[] = token?.kind === "slash"
    ? commands.filter(item => item.name.startsWith(token.query.toLowerCase())).map(item => ({ key: item.name, label: `/${item.name}`, hint: item.hint, description: item.description, run: () => item.run("") }))
    : token?.kind === "mention" && mentions.query === token.query
      ? mentions.items.map(item => ({ key: item.path, label: item.path + (item.kind === "folder" ? "/" : ""), icon: item.kind, run: () => insertMention(item.path) }))
      : [];
  const showPalette = paletteOpen && options.length > 0;
  const selected = Math.min(index, options.length - 1);
  const optionsRef = useRef<HTMLDivElement>(null);
  useEffect(() => { optionsRef.current?.children[selected]?.scrollIntoView({ block: "nearest" }); }, [selected, showPalette]);

  const models = chat.connections.models || [];
  const run = input === "run";
  const hasModel = models.some(model => model.id === chat.model);
  const canSend = !chat.switching && !chat.connecting && (run ? !chat.busy : hasModel);
  function submit() {
    const value = draft.trim();
    if (value.startsWith("/")) {
      const [, name = "", arg = ""] = /^\/(\S*)\s*([\s\S]*)$/.exec(value) || [];
      const item = commands.find(entry => entry.name === name.toLowerCase());
      if (item) { item.run(arg.trim()); return; }
      // "/usr/bin/…" is a path in a message, not a command.
      if (!name.includes("/")) { setNote(`Unknown command /${name}. Type / to see commands.`); return; }
    }
    if (!value) return;
    if (run) { post({ type: "run", value }); update(""); }
    else if (chat.busy) { post({ type: "enqueue", value: draft }); update(""); }
    else post({ type: "send", value: draft });
  }
  async function paste(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    const images = [...event.clipboardData.files].filter(file => file.type.startsWith("image/"));
    if (!images.length) return;
    event.preventDefault();
    const active = (chat.connections.models || []).find(model => model.id === chat.model);
    if (active?.vision === false) setNote(`${active.name} can't see images. Choose a model that supports images before sending.`);
    for (const file of images.slice(0, 4)) {
      if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(file.type) || file.size > 5 * 1024 * 1024) { setNote("Paste PNG, JPEG, GIF or WebP images up to 5 MB."); continue; }
      post({ type: "pasteImage", name: file.name && file.name !== "image.png" ? file.name : `pasted-${new Date().toLocaleTimeString().replace(/\W/g, "")}.${file.type.split("/")[1]}`, mime: file.type, data: await readImage(file) });
    }
  }
  const billing = run ? "Runs with your user permissions" : chat.model.startsWith("chatgpt/") ? "Using ChatGPT plan" : /^(openai|anthropic)\//.test(chat.model) ? "Using provider API billing"
    : chat.model.startsWith("claude-code/") ? "Using Claude Code account" : chat.model ? "Using local Ollama" : "No model selected";
  const permissions: { value: ChatState["permission"]; label: string; description: string }[] = [
    { value: "ask", label: "Ask first", description: "Every change, command and web fetch needs your approval." },
    { value: "auto", label: "Auto", description: chat.agent?.sandbox ? "Project edits apply directly; commands run sandboxed (project and temp writes, no network)." : "Project edits apply directly; commands ask first (no sandbox here)." },
    { value: "full", label: "Full access", description: "No approvals and no sandbox. For trusted tasks you are watching." },
  ];
  const info = chat.contextInfo, running = chat.processes.filter(item => item.status === "running");
  const share = (field: "shareEditor" | "shareSelection" | "shareDiff" | "shareProblems" | "sharePlan", enabled: boolean) => post({ type: "context", field, enabled });
  // Everything that can go with the next message, plus adding files and switching to Run.
  const contextItems: MenuItem[] = [
    { kind: "heading", label: "Share with the next message" },
    { key: "editor", label: "Current document", description: "The active editor, including unsaved changes", checked: chat.shareEditor, onSelect: () => share("shareEditor", !chat.shareEditor) },
    { key: "selection", label: info?.selection ? `Selection ${info.selection.label}` : "Selection", description: info?.selection ? "The text selected in the editor" : "Select text in an editor to share it", checked: chat.shareSelection, disabled: !info?.selection && !chat.shareSelection, onSelect: () => share("shareSelection", !chat.shareSelection) },
    { key: "diff", label: "Git changes", description: "git status and the diff against the last commit", checked: chat.shareDiff, onSelect: () => share("shareDiff", !chat.shareDiff) },
    { key: "problems", label: `Problems${info ? ` (${info.problems.count})` : ""}`, description: "Errors and warnings from the Problems panel", checked: chat.shareProblems, onSelect: () => share("shareProblems", !chat.shareProblems) },
    { key: "plan", label: "Planning brief", description: "The brief on the Plan page", checked: chat.sharePlan, onSelect: () => share("sharePlan", !chat.sharePlan) },
    ...research.sources.map((source): MenuItem => ({ key: `source-${source.id}`, label: source.title || source.url, description: "Research source", checked: source.shared, onSelect: () => post({ type: "sourceShare", id: source.id, enabled: !source.shared }) })),
    ...chat.attachments.map((item): MenuItem => ({ key: `attachment-${item.id}`, label: item.name, description: item.readable ? "Attachment" : "File only: no text to share", checked: item.shared, disabled: !item.readable, onSelect: () => post({ type: "attachmentShare", id: item.id, enabled: !item.shared }) })),
    { kind: "heading", label: "Add" },
    { key: "attach", label: "Attach files…", description: "Copied into the project's attachments folder", onSelect: () => post({ type: "attach" }) },
    { key: "mention", label: "Mention a file or folder", description: "Type @ in the message", onSelect: () => update(`${draft}${draft && !/\s$/.test(draft) ? " " : ""}@`, true) },
    { kind: "heading", label: "Message box" },
    { key: "ask", label: "Ask the agent", checked: !run, onSelect: () => setInput("ask") },
    { key: "run", label: "Run a command yourself", description: "In this project, with your user permissions", checked: run, onSelect: () => setInput("run") },
  ];
  const included = [
    chat.shareEditor && <Chip key="editor" label="Current document" title="The active editor, including unsaved changes" remove={() => share("shareEditor", false)} />,
    chat.shareSelection && <Chip key="selection" label={info?.selection ? `Selection ${info.selection.label}` : "Selection"} remove={() => share("shareSelection", false)} />,
    chat.shareDiff && <Chip key="diff" label="Git changes" remove={() => share("shareDiff", false)} />,
    chat.shareProblems && <Chip key="problems" label={`Problems${info ? ` (${info.problems.count})` : ""}`} remove={() => share("shareProblems", false)} />,
    chat.sharePlan && <Chip key="plan" label="Planning brief" remove={() => share("sharePlan", false)} />,
    ...research.sources.filter(source => source.shared).map(source => <Chip key={source.id} label={source.title || source.url} title={source.url} remove={() => post({ type: "sourceShare", id: source.id, enabled: false })} />),
    ...chat.attachments.filter(item => item.shared).map(item => <Chip key={item.id} label={item.name} remove={() => post({ type: "attachmentShare", id: item.id, enabled: false })} />),
    ...chat.images.map(item => <Chip key={item.id} label={`🖼 ${item.name}`} title="Pasted image: sent with your next message only." remove={() => post({ type: "removeImage", id: item.id })} />),
  ].filter(Boolean);
  const current = models.find(model => model.id === chat.model);

  return (
    <>
      {showPalette && (
        <div id="slash" className="slash-palette">
          <div className="slash-heading">{token?.kind === "mention"
            ? <><span><Icon name="at" size={13} /> Files and folders</span><small>{options.length} match{options.length === 1 ? "" : "es"}</small></>
            : <><span><Icon name="layers" size={13} /> Workspace</span><small>{options.length} command{options.length === 1 ? "" : "s"}</small></>}</div>
          <div className="slash-options" role="listbox" aria-label={token?.kind === "mention" ? "Files and folders" : "Commands"} ref={optionsRef}>
            {options.map((item, position) => (
              <button key={item.key} role="option" aria-selected={position === selected} className={position === selected ? "highlighted" : ""} onMouseDown={event => { event.preventDefault(); item.run(); }}>
                {item.icon ? <span className="mention-option"><Icon name={item.icon} size={13} /><span>{item.label}</span></span>
                  : <span className="slash-command-copy"><span className="slash-command-name"><strong>{item.label}</strong>{item.hint && <small>{item.hint}</small>}</span><span className="slash-description">{item.description}</span></span>}
              </button>
            ))}
          </div>
          <div className="slash-footer"><span><kbd>↑</kbd><kbd>↓</kbd> navigate</span><span><kbd>↵</kbd> select</span><span><kbd>esc</kbd> close</span></div>
        </div>
      )}
      {running.length > 0 && (
        <div className="processes" aria-label="Background processes">
          {running.map(item => (
            <div key={item.id} className="process-row">
              <span className="process-dot" aria-hidden="true" /><code title={`${item.command}\n${item.cwd}${item.sandboxed ? "\nSandboxed" : ""}`}>{item.command}</code>
              <button className="ghost small" onClick={() => post({ type: "processShow", id: item.id })}><Icon name="terminal" size={12} />Show</button>
              <button className="ghost small" aria-label={`Stop ${item.command}`} onClick={() => post({ type: "processStop", id: item.id })}><Icon name="stop" size={11} />Stop</button>
            </div>
          ))}
        </div>
      )}
      {chat.queue.length > 0 && (
        <div className="queue" aria-label="Queued messages">
          <div className="context-label"><Icon name="clock" size={11} /> {chat.queuePaused ? "Queued · paused after the last reply stopped" : "Queued · sent when the current reply finishes"}</div>
          {chat.queue.map(item => (
            <div key={item.id} className="queue-row">
              <span title={item.text}>{item.text}</span>
              {chat.queuePaused && !chat.busy && <button className="ghost small" onClick={() => post({ type: "sendQueued", id: item.id })}>Send Now</button>}
              <button className="icon-button" aria-label={`Remove queued message: ${item.text.slice(0, 40)}`} title="Remove from the queue" onClick={() => post({ type: "dequeue", id: item.id })}><Icon name="close" size={12} /></button>
            </div>
          ))}
        </div>
      )}
      <div id="composer" className={`composer${run ? " run" : ""}`} data-mode={modeTone[mode]}>
        {(included.length > 0 || chat.untrusted?.length > 0) && (
          <div id="chips" className="context-chips" aria-label="Shared with the next message">
            {included}
            {chat.untrusted?.length > 0 && <InfoTip tip={`Untrusted content is in this chat: ${chat.untrusted.join(", ")}. Commands and web access always ask, and “always allow” is off. Start a new chat or stop sharing the source to clear it.`} align="start">
              <span id="untrusted" tabIndex={0} className="context-chip untrusted">⚠ Untrusted content in this chat</span></InfoTip>}
          </div>
        )}
        <textarea id="draft" ref={field} aria-label="Conversation draft" maxLength={20000} rows={2} value={draft}
          placeholder={run ? "Run a command in this project, e.g. npm test" : chat.busy ? "Type to queue a message for when this reply finishes…" : `${placeholders[mode]}… @ adds files, / for commands`}
          onChange={event => update(event.target.value, false, event.target.selectionStart)}
          onSelect={event => setCaret(event.currentTarget.selectionStart)}
          onPaste={event => { void paste(event); }}
          onBlur={() => setTimeout(() => { if (document.activeElement !== field.current) setPaletteOpen(false); }, 150)} onFocus={() => setPaletteOpen(true)}
          onKeyDown={event => {
            if (showPalette) {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setIndex((selected + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length); return; }
              if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); options[selected]?.run(); return; }
              if (event.key === "Escape") { event.preventDefault(); setPaletteOpen(false); return; }
            }
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (canSend || draft.trim().startsWith("/")) submit(); }
          }} />
        <div className="composer-footer">
          <div className="composer-controls">
            <Menu id="context-menu" className="context-menu icon-only" label="Context and attachments" title="Share context, attach files, or run a command yourself" items={contextItems}
              trigger={<><Icon name="plus" size={14} />{run && <span className="run-flag">Run</span>}</>} />
            <Menu id="mode-menu" className={`mode-menu ${modeTone[mode]}`} label="Mode" title="What the agent can do (Alt+1…4)" disabled={chat.busy}
              trigger={<><span className="mode-dot" aria-hidden="true" />{mode}</>}
              items={(["Discuss", "Plan", "Build", "Research"] as Mode[]).map((name, index): MenuItem => ({ key: name, label: name, description: modeNotes[name].split(" · ")[1], badges: [`Alt+${index + 1}`], checked: name === mode, onSelect: () => post({ type: "mode", value: name }) }))} />
            <Menu id="permission" className={`permission-menu${chat.permission === "full" ? " full" : ""}`} label="Permissions" title="What the agent may do without asking" disabled={chat.busy}
              trigger={<><Icon name="shield" size={12} />{permissions.find(item => item.value === chat.permission)?.label}</>}
              items={permissions.map((item): MenuItem => ({ key: item.value, label: item.label, description: item.description, checked: item.value === chat.permission, tone: item.value === "full" ? "warn" : undefined, onSelect: () => post({ type: "permission", value: item.value }) }))} />
            {mode === "Build" && <Autocompute chat={chat} />}
          </div>
          <div className="composer-send">
            <Menu id="model" className="model-menu" label="Active model" title="Your choice is remembered for this mode" disabled={chat.busy} align="end"
              trigger={<span className="model-name">{current?.name || (models.length ? "Choose a model" : "No model connected")}</span>} items={modelItems(models, chat.model)} />
            {chat.busy && !run && draft.trim() && <button id="queue" className="send-button queueing" aria-label="Queue" title="Queue: send when the current reply finishes (Enter)" onClick={submit}><Icon name="clock" size={14} /></button>}
            {chat.busy
              ? <button id="stop" className="send-button stopping" aria-label="Stop" title="Stop (Escape)" onClick={() => post({ type: "stop" })}><Icon name="stop" size={14} /></button>
              : <button id="send" className="send-button" aria-label={run ? "Run" : "Send"} title={run ? "Run (Enter)" : "Send (Enter)"} disabled={!canSend} onClick={submit}><Icon name={run ? "play" : "up"} size={15} /></button>}
          </div>
        </div>
      </div>
      <div className="composer-hint">
        <AgentState chat={chat} mode={mode} />
        <span className="hint-right"><span id="billing">{billing}</span>{!run && <Spend chat={chat} />}{chat.usage && !run ? <ContextMeter usage={chat.usage} busy={chat.busy} /> : null}</span>
      </div>
    </>
  );
}
