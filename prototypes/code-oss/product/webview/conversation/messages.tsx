import { memo, useLayoutEffect, useRef } from "react";
import type { ChatMessage, Model } from "../protocol";
import { MarkdownText } from "../markdown";
import { post } from "../store";
import { Icon } from "../icons";
import { Steps, duration, useNow } from "./steps";
import { Changes } from "./changes";

const proposalLabel = { file: "File change", plan: "Plan", command: "Command", browse: "Page", verify: "Check this yourself" } as const;
const approveLabel = { file: "Review Changes", plan: "Apply Plan", command: "Run Proposed Command", browse: "Open Page", verify: "It Works" } as const;
const discardLabel = (kind: string) => kind === "verify" ? "It Doesn’t" : "Discard";
export const money = (value: number) => value >= 1 ? `$${value.toFixed(2)}` : value >= 0.01 ? `$${value.toFixed(3)}` : value > 0 ? "<$0.01" : "$0";
// [S1] citations become links to their sources (Markdown reference definitions).
const withCitations = (message: ChatMessage) => message.citations?.length
  ? `${message.content}\n\n${message.citations.map(item => `[${item.key}]: ${item.url}`).join("\n")}\n` : message.content;
function Sources({ citations }: { citations: NonNullable<ChatMessage["citations"]> }) {
  return (
    <div className="citations" aria-label="Sources cited">
      <span className="context-label">SOURCES</span>
      {citations.map(item => <a key={item.key} href={item.url} title={item.url}><b>{item.key}</b> {item.title}</a>)}
    </div>
  );
}

// What the agent is doing right now, for the byline of a live reply.
function liveState(message: ChatMessage) {
  if (message.state === "running") return "RUNNING";
  if (message.phase === "condensing") return "CONDENSING CONTEXT";
  const steps = message.steps || [];
  if (steps.some(step => step.status === "waiting")) return "WAITING FOR YOU";
  if (steps.some(step => step.status === "running")) return "WORKING";
  return message.content ? "WRITING" : message.reasoning ? "REASONING" : "THINKING";
}

// The model's reasoning: open and following the newest text until the answer starts, then collapsed.
function Reasoning({ text, thinking }: { text: string; thinking: boolean }) {
  const body = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { if (thinking && body.current) body.current.scrollTop = body.current.scrollHeight; }, [text, thinking]);
  return (
    <details className="reasoning" open={thinking}>
      <summary><Icon name="layers" size={12} /> {thinking ? "Reasoning…" : "Reasoning"}</summary>
      <div className="reasoning-text" ref={body}>{text}</div>
    </details>
  );
}

// Where older messages were condensed: above it the model sees only this summary.
function SummaryNote({ message }: { message: ChatMessage }) {
  const count = message.condensed ?? 0, plural = count === 1 ? "" : "s";
  if (message.failed) return <p className="condensed-note failed" role="note"><Icon name="layers" size={12} /> {count} earlier message{plural} are no longer sent to the model. {message.error}</p>;
  return (
    <details className="condensed-note">
      <summary><Icon name="layers" size={12} /> Earlier messages condensed · {count} message{plural} summarised for the model</summary>
      <MarkdownText text={message.content} />
    </details>
  );
}
const kb = (size: number) => size > 1048576 ? `${(size / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(size / 1024))} KB`;

const Message = memo(function Message({ message, models, busy, latest, condensed }: { message: ChatMessage; models: Model[]; busy: boolean; latest: boolean; condensed: boolean }) {
  const live = message.state === "streaming" || message.state === "running";
  const now = useNow(live && !!message.startedAt);
  if (message.kind === "summary") return <SummaryNote message={message} />;
  if (message.kind === "workspace") return <p className={`workspace-note${condensed ? " condensed-out" : ""}`}>{message.content}</p>;
  const command = message.kind === "command", user = message.role === "user";
  const name = user ? (command ? "You ran" : "You") : command ? "Command output"
    : models.find(model => model.id === message.model)?.name || (message.model ? message.model.slice(message.model.indexOf("/") + 1) : "Assistant");
  const ended = message.state && !message.error && !["streaming", "running", "complete"].includes(message.state);
  const waiting = (message.steps || []).some(step => step.status === "waiting");
  return (
    <article id={`message-${message.id}`} className={`message ${message.role}${command ? " command" : ""}${condensed ? " condensed-out" : ""}`}>
      <div className="message-byline">
        <span className={user ? "user-avatar" : "small-avatar"}>{user ? (command ? "$" : "Y") : command ? ">_" : "✦"}</span>
        <strong>{name}</strong>
        {!live && typeof message.cost === "number" && <span className="message-cost" title={`Estimated API cost of this reply: ${message.usage?.billedInput ?? message.usage?.input ?? 0} input and ${message.usage?.output ?? 0} output tokens at list prices`}>{money(message.cost)}</span>}
        {user && message.untrusted?.length ? <span className="untrusted-mark" title={`Sent with untrusted content: ${message.untrusted.join(", ")}`}>⚠ untrusted context</span> : null}
        {live && <span className="live-state">{liveState(message)}{message.startedAt ? ` · ${duration(now - message.startedAt)}` : ""}</span>}
        {!live && !busy && !command && (
          <span className="message-actions">
            {!user && message.content && <button className="message-action" aria-label="Copy reply" title="Copy this reply as Markdown" onClick={() => post({ type: "copy", text: message.content })}><Icon name="copy" size={12} /></button>}
            {!user && latest && <button className="message-action" aria-label="Regenerate" title="Answer again: restores files this reply changed, then sends your message again"
              onClick={() => post({ type: "regenerate", messageId: message.id })}><Icon name="refresh" size={12} /></button>}
            <button className="message-action" aria-label="Branch from here" title="Branch: start a new conversation with the messages up to here (files are not changed)"
              onClick={() => post({ type: "branch", messageId: message.id })}><Icon name="branch" size={12} /></button>
            {user && <button className="message-action" aria-label="Rewind to here" title="Rewind to here: remove this message and everything after it, restore files the agent changed since, and put this message back in the box to edit"
              onClick={() => post({ type: "rewind", messageId: message.id })}><Icon name="undo" size={12} /></button>}
          </span>
        )}
      </div>
      <div className="message-body">
        {message.cwd && user && <small className="muted">{message.cwd}</small>}
        {!user && message.reasoning ? <Reasoning text={message.reasoning} thinking={live && !message.content} /> : null}
        {message.steps?.length ? <Steps steps={message.steps} finished={!live} startedAt={message.startedAt} endedAt={message.endedAt} /> : null}
        {message.content || !message.state
          ? command ? <pre className="command-output">{message.content}</pre> : user ? <div className="message-text">{message.content}</div> : <MarkdownText text={withCitations(message)} />
          : message.state === "streaming" && !waiting && !message.reasoning ? <span className="muted">…</span> : null}
        {(message.mentions?.length || message.images?.length) ? <div className="message-attachments">
          {message.mentions?.map(item => <span key={item.path} className={`attachment-chip ${item.kind}`} title={item.error || (item.kind === "file" ? `${item.lines} lines shared${item.truncated ? " (first 40,000 characters)" : ""}` : item.kind === "folder" ? `${item.entries} entries listed` : "Not shared")}>
            <Icon name={item.kind === "folder" ? "folder" : "file"} size={11} />@{item.path}{item.kind === "blocked" || item.kind === "skipped" ? " · not shared" : ""}</span>)}
          {message.images?.map(item => <span key={item.id} className="attachment-chip" title={`${item.mime} · ${kb(item.size)}`}><Icon name="image" size={11} />{item.name}</span>)}
        </div> : null}
        {!user && message.citations?.length ? <Sources citations={message.citations} /> : null}
        {message.contextNote && <small className="context-note">{message.contextNote}</small>}
        {message.activity?.length && !message.steps?.length ? <p className="tool-activity">{message.activity.join(" · ")}</p> : null}
        {(ended || message.exitCode !== undefined) && <small className="command-exit">{[ended ? message.state : "", message.exitCode !== undefined ? `exit ${message.exitCode}` : ""].filter(Boolean).join(" · ")}</small>}
        {message.error && <p className="error">{message.error}</p>}
        {(message.proposals || []).map(proposal => (
          <div key={proposal.id} className="proposal-card">
            <strong>{proposalLabel[proposal.kind] || proposal.kind}: {proposal.path || proposal.reason}</strong>
            {proposal.reason && proposal.path && <p>{proposal.reason}</p>}
            {proposal.kind === "verify" ? <p className="verify-check">{proposal.text}</p> : <details><summary>View proposal</summary><pre>{proposal.text}</pre></details>}
            {proposal.status === "pending"
              ? <div className="row">
                  <button className="primary" disabled={busy} onClick={() => post({ type: "approveProposal", id: proposal.id })}>{approveLabel[proposal.kind]}</button>
                  <button className="ghost" onClick={() => post({ type: "discardProposal", id: proposal.id })}>{discardLabel(proposal.kind)}</button>
                </div>
              : <small>{proposal.status || "expired"}</small>}
          </div>
        ))}
        {!live && <Changes message={message} busy={busy} />}
      </div>
    </article>
  );
});

// Follows new output while the user is at the bottom or has just sent; otherwise leaves their scroll position alone.
export function MessageList({ messages, models, busy, children }: { messages: ChatMessage[]; models: Model[]; busy: boolean; children?: React.ReactNode }) {
  const summaryAt = messages.findLastIndex(message => message.kind === "summary");
  const latest = messages.findLast(message => message.role === "assistant" && !message.kind)?.id;
  const scroller = useRef<HTMLDivElement>(null), stick = useRef(true), lastUser = useRef<string>(undefined);
  useLayoutEffect(() => {
    const node = scroller.current;
    if (!node) return;
    // Sending (or running a command) always brings the new exchange into view.
    const user = messages.findLast(message => message.role === "user")?.id;
    if (user !== lastUser.current) { lastUser.current = user; stick.current = true; }
    if (!messages.length) node.scrollTop = 0; else if (stick.current) node.scrollTop = node.scrollHeight;
  }, [messages]);
  return (
    <div className="messages" id="scroller" ref={scroller}
      onScroll={event => { const node = event.currentTarget; stick.current = node.scrollHeight - node.scrollTop - node.clientHeight < 100; }}>
      <div id="messages" aria-label="Conversation messages" aria-live="polite" aria-busy={busy}>
        {messages.map((message, index) => <Message key={message.id} message={message} models={models} busy={busy} latest={message.id === latest} condensed={index < summaryAt} />)}
      </div>
      {children}
    </div>
  );
}
