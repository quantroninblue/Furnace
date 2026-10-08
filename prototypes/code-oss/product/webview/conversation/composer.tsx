import { useEffect, useRef, useState } from "react";
import type { ChatState, Mode, ResearchState, Usage } from "../protocol";
import { Icon } from "../icons";
import { currentMessages, post, setHistoryOpen, setNote, setPrefs, setTimelineOpen, useStore, useSyncedText } from "../store";
import { money } from "./messages";

export const modeNotes: Record<Mode, string> = {
  Discuss: "Discuss · uses only the context you share", Plan: "Plan · reads and searches the project, proposes a brief",
  Build: "Build · reads, edits and creates files, runs commands", Research: "Research · uses shared sources, suggests pages",
};
type Command = { name: string; hint?: string; description: string; run: (arg: string) => void };
type Option = { key: string; label: string; hint?: string; description?: string; icon?: "folder" | "file"; run: () => void };

function Chip({ label, on, toggle, remove, disabled, title }: { label: string; on: boolean; toggle: () => void; remove?: () => void; disabled?: boolean; title?: string }) {
  return (
    <span className={`context-chip${on ? " included" : ""}${disabled ? " disabled" : ""}`}>
      <button aria-pressed={on} disabled={disabled} onClick={toggle} title={title || (on ? "Included with the next message. Click to stop sharing." : "Click to include with the next message.")}>{label}</button>
      {remove && <button className="chip-remove" aria-label={`Remove ${label}`} onClick={remove}>×</button>}
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

const thousands = (value: number) => value >= 10000 ? `${Math.round(value / 1000)}k` : value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
// How full the model's context window is for the next message (estimated), with what fills it.
function ContextMeter({ usage, busy }: { usage: Usage; busy: boolean }) {
  const percent = Math.min(100, Math.round((usage.used / usage.window) * 100));
  const title = [`Context for the next message: about ${thousands(usage.used)} of ${thousands(usage.window)} tokens (${percent}%).`,
    `Instructions and tools ~${thousands(usage.system)} · conversation ~${thousands(usage.history)} · shared context ~${thousands(usage.shared)}.`,
    usage.condensed ? `Earlier messages condensed ${usage.condensed} time${usage.condensed === 1 ? "" : "s"}.` : "Older messages are summarised automatically when the conversation fills 60% of the window.",
    usage.measured ? `Last reply: ${thousands(usage.measured.input)} input tokens measured by the provider.` : "",
    usage.source === "counted" ? "Counted with the provider's own tokenizer." : usage.source === "calibrated" ? "Estimate corrected by the provider's count for the last reply." : "Estimated (about 4 characters per token).",
    "Click to condense the conversation now (/compact)."].filter(Boolean).join("\n");
  return (
    <button id="context-meter" className={`context-meter${percent >= 80 ? " high" : percent >= 60 ? " medium" : ""}`} disabled={busy} title={title} aria-label={`Context ${percent}% used. Condense now`}
      onClick={() => post({ type: "compact" })}>
      <span className="meter-track"><span className="meter-fill" style={{ width: `${Math.max(2, percent)}%` }} /></span>{percent}%
    </button>
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
  const title = [chat.cost ? `Estimated from provider-reported tokens at list prices${chat.cost.unpriced ? `; ${chat.cost.unpriced} repl${chat.cost.unpriced === 1 ? "y has" : "ies have"} no known price (set aiGui.pricing)` : ""}.` : "",
    month ? `API spend from this machine this month: ${money(month)} (today ${money(chat.spend?.today.total || 0)}).` : "",
    budget ? `Monthly budget ${money(budget)} (aiGui.budget.monthlyUsd)${level === " over" ? ": exceeded" : level === " near" ? ": over 80% used" : ""}.` : "Set a monthly budget with aiGui.budget.monthlyUsd.",
    plan ? `ChatGPT plan: ${Math.round(plan.usedPercent)}% of the ${plan.windowMinutes ? `${Math.round(plan.windowMinutes / 60)}-hour` : "current"} window used${plan.resetSeconds ? `, resets in ${Math.ceil(plan.resetSeconds / 60)} min` : ""}.` : ""].filter(Boolean).join("\n");
  return <span id="spend" className={`spend${level}`} title={title}>{parts.join(" · ")}{level === " over" ? " · over budget" : ""}</span>;
}

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
    { name: "permissions", hint: "ask|auto|full", description: "Change what the agent may do without asking", run: arg => { update(""); if (arg === "ask" || arg === "auto" || arg === "full") post({ type: "permission", value: arg }); else document.getElementById("permission")?.focus(); } },
    simple("attach", "Import files as context", { type: "attach" }),
    simple("changes", "Show agent and Git changes in Source Control", { type: "openScm" }),
    simple("workspace", "Open the workspace view (plan, research, rules, activity)", { type: "home" }),
    simple("stop", "Stop the current reply or command", { type: "stop" }),
    simple("tour", "Show the getting started guide", { type: "tourShow" }),
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
    for (const file of images.slice(0, 4)) {
      if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(file.type) || file.size > 5 * 1024 * 1024) { setNote("Paste PNG, JPEG, GIF or WebP images up to 5 MB."); continue; }
      post({ type: "pasteImage", name: file.name && file.name !== "image.png" ? file.name : `pasted-${new Date().toLocaleTimeString().replace(/\W/g, "")}.${file.type.split("/")[1]}`, mime: file.type, data: await readImage(file) });
    }
  }
  const billing = run ? "Runs with your user permissions" : chat.model.startsWith("chatgpt/") ? "Using ChatGPT plan" : /^(openai|anthropic)\//.test(chat.model) ? "Using provider API billing"
    : chat.model.startsWith("claude-code/") ? "Using Claude Code account" : chat.model ? "Using local Ollama" : "No model selected";
  const permissionTitle = { ask: "Ask first: every change, command and web fetch needs approval.", auto: `Auto: project edits apply directly; ${chat.agent?.sandbox ? "commands run sandboxed (project + temp writes, no network)" : "commands ask first (sandbox unavailable)"}.`, full: "Full access: no approvals, no sandbox." }[chat.permission];
  const info = chat.contextInfo, running = chat.processes.filter(item => item.status === "running");

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
          <div className="context-label"><Icon name="clock" size={11} /> {chat.queuePaused ? "QUEUED · PAUSED AFTER THE LAST REPLY STOPPED" : "QUEUED · SENT WHEN THE CURRENT REPLY FINISHES"}</div>
          {chat.queue.map(item => (
            <div key={item.id} className="queue-row">
              <span title={item.text}>{item.text}</span>
              {chat.queuePaused && !chat.busy && <button className="ghost small" onClick={() => post({ type: "sendQueued", id: item.id })}>Send Now</button>}
              <button className="icon-button" aria-label={`Remove queued message: ${item.text.slice(0, 40)}`} title="Remove from the queue" onClick={() => post({ type: "dequeue", id: item.id })}><Icon name="close" size={12} /></button>
            </div>
          ))}
        </div>
      )}
      <div className="context-area">
        <div className="context-label"><Icon name="layers" size={11} /> CONTEXT FOR NEXT MESSAGE <span className="context-tip">· @ adds files</span></div>
        <div id="chips" className="context-chips">
          <Chip label="Current document" on={chat.shareEditor} title="The active editor, including unsaved changes." toggle={() => post({ type: "context", field: "shareEditor", enabled: !chat.shareEditor })} />
          <Chip label={info?.selection ? `Selection ${info.selection.label}` : "Selection"} on={chat.shareSelection} disabled={!info?.selection && !chat.shareSelection}
            title={info?.selection ? "The text selected in the editor." : "Select text in an editor to share it."} toggle={() => post({ type: "context", field: "shareSelection", enabled: !chat.shareSelection })} />
          <Chip label="Git changes" on={chat.shareDiff} title="git status and the diff of the working tree against the last commit." toggle={() => post({ type: "context", field: "shareDiff", enabled: !chat.shareDiff })} />
          <Chip label={`Problems${info ? ` (${info.problems.count})` : ""}`} on={chat.shareProblems} title="Errors and warnings from the Problems panel." toggle={() => post({ type: "context", field: "shareProblems", enabled: !chat.shareProblems })} />
          <Chip label="Planning brief" on={chat.sharePlan} toggle={() => post({ type: "context", field: "sharePlan", enabled: !chat.sharePlan })} />
          {research.sources.map(source => <Chip key={source.id} label={source.title || source.url} on={source.shared} title={source.url}
            toggle={() => post({ type: "sourceShare", id: source.id, enabled: !source.shared })} remove={() => post({ type: "sourceRemove", id: source.id })} />)}
          {chat.attachments.map(item => <Chip key={item.id} label={item.readable ? item.name : `${item.name} · file only`} on={item.shared} disabled={!item.readable}
            title={item.readable ? undefined : "No extracted text; this file cannot be shared as context."}
            toggle={() => post({ type: "attachmentShare", id: item.id, enabled: !item.shared })} remove={() => post({ type: "attachmentRemove", id: item.id })} />)}
          {chat.untrusted?.length > 0 && <span id="untrusted" className="context-chip untrusted" title={`Untrusted content is in this chat: ${chat.untrusted.join(", ")}. Commands and web access always ask, and “always allow” is off. Start a new chat or stop sharing the source to clear it.`}>⚠ Untrusted content in this chat</span>}
          {chat.images.map(item => <Chip key={item.id} label={`🖼 ${item.name}`} on title="Pasted image: sent with your next message only." toggle={() => {}} remove={() => post({ type: "removeImage", id: item.id })} />)}
        </div>
      </div>
      <div className="agent-bar">
        <label className="permission" title="What the agent may do without asking"><Icon name="shield" size={12} />
          <select id="permission" aria-label="Permissions" title={permissionTitle} value={chat.permission} disabled={chat.busy} onChange={event => post({ type: "permission", value: event.target.value as ChatState["permission"] })}>
            <option value="ask">Ask first</option><option value="auto">Auto</option><option value="full">Full access</option>
          </select>
        </label>
        <AgentState chat={chat} mode={mode} />
      </div>
      <div className="composer">
        <textarea id="draft" ref={field} aria-label="Conversation draft" maxLength={20000} rows={3} value={draft}
          placeholder={run ? "Run a command in this project, e.g. npm test" : chat.busy ? "Type to queue a message for when this reply finishes…" : "Ask anything, @ to add files, / for commands…"}
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
        <div className="composer-actions">
          <div className="input-mode" role="group" aria-label="Input mode">
            <button aria-pressed={!run} title="Ask the assistant" onClick={() => setInput("ask")}>Ask</button>
            <button aria-pressed={run} title="Run a shell command in this project" onClick={() => setInput("run")}>Run</button>
          </div>
          <button className="icon-button" aria-label="Attach Files" title="Attach files (/attach). Paste images with Ctrl+V." onClick={() => post({ type: "attach" })}><Icon name="clip" size={14} /></button>
          <select id="model" className="composer-model" aria-label="Active model" title="Your choice is remembered for this mode" value={chat.model || ""} disabled={chat.busy} onChange={event => post({ type: "model", value: event.target.value })}>
            <option value="">{models.length ? "Choose a model" : "No model connected"}</option>
            {models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
          </select>
          {chat.busy && !run && draft.trim() && <button id="queue" className="send-button queueing" aria-label="Queue" title="Queue: send when the current reply finishes (Enter)" onClick={submit}><Icon name="clock" size={14} /></button>}
          {chat.busy
            ? <button id="stop" className="send-button stopping" aria-label="Stop" title="Stop (Escape)" onClick={() => post({ type: "stop" })}><Icon name="stop" size={14} /></button>
            : <button id="send" className="send-button" aria-label="Send" title="Send (Enter)" disabled={!canSend} onClick={submit}><Icon name="up" size={15} /></button>}
        </div>
      </div>
      <div className="composer-hint"><span id="billing">{billing}</span>{!run && <Spend chat={chat} />}{chat.usage && !run ? <ContextMeter usage={chat.usage} busy={chat.busy} /> : <span title="Enter sends · Shift+Enter adds a line · Escape stops">/ for commands</span>}</div>
    </>
  );
}
