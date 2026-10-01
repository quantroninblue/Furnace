import { useState } from "react";
import { History, MessageSquare, Search, X } from "lucide-react";
import type { SessionSummary } from "../../shared/types";
export default function SessionPicker({ sessions, active, project, onClose, onResume }: {
  sessions: SessionSummary[]; active?: string; project: string; onClose(): void; onResume(id: string): Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [working, setWorking] = useState(false);
  const filtered = sessions.filter(session => `${session.title} ${session.model}`.toLowerCase().includes(query.toLowerCase()));
  return <div className="modal-backdrop"><section className="session-modal" role="dialog" aria-modal="true" aria-label="Resume a conversation">
    <header><div><span className="eyebrow">PICK UP THE THREAD</span><h2><History size={20} />Resume a conversation</h2></div><button className="icon-button" aria-label="Close sessions" disabled={working} onClick={onClose}><X size={19} /></button></header>
    <p>{project} · most recent first</p>
    <label className="session-search"><Search size={16} /><input autoFocus aria-label="Search sessions" placeholder="Find a conversation…" value={query} onChange={event => setQuery(event.target.value)} /></label>
    <div className="session-list">{filtered.map(session => <button key={session.id} disabled={working || session.id === active} onClick={async () => { setWorking(true); try { await onResume(session.id); } finally { setWorking(false); } }}><MessageSquare size={17} /><span><strong>{session.title}</strong><small>{new Date(session.updatedAt).toLocaleString()} · {session.messageCount} messages · {session.model || "No model selected"}</small></span>{session.id === active && <em>Current</em>}</button>)}{!filtered.length && <div className="session-empty">{sessions.length ? "No matching conversations." : "Your saved conversations will appear here."}</div>}</div>
    <footer>Resuming restores the conversation, brief and saved sources. File proposals need a fresh review request.</footer>
  </section></div>;
}
