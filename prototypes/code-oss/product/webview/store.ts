import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { AuditEntry, ChatMessage, FromWebview, HistoryItem, Mode, OrgSpend, Page, PathItem, State, Timeline, ToWebview } from "./protocol";

declare function acquireVsCodeApi(): { postMessage(message: unknown): void; getState(): unknown; setState(state: unknown): void };
const vscode = acquireVsCodeApi();

// Local view preferences (input mode, Connections tab, code wrapping) survive the webview being hidden.
type ViewPrefs = { input: "ask" | "run"; tab: "chatgpt" | "claude" | "local" | "api"; wrapCode: boolean };
let prefs: ViewPrefs = { input: "ask", tab: "chatgpt", wrapCode: true, ...(vscode.getState() as Partial<ViewPrefs> | undefined) };

type Snapshot = {
  data: State | null;
  /** Messages keep their object identity until they change, so rows re-render only then. */
  messages: ChatMessage[];
  prefs: ViewPrefs;
  /** A local note (e.g. an unknown slash command or a rejected paste), shown over older status text until the next status or error change. */
  note: string;
  /** Workspace view page; it follows the mode until the user picks another page. */
  page: Page;
  /** The page to return to when Connections closes. */
  lastPage: Page;
  mentions: { query: string; items: PathItem[] };
  history: { query: string; items: HistoryItem[]; current: string } | null;
  historyOpen: boolean;
  audit: AuditEntry[] | null;
  /** Conversation timeline (requested when the pane opens). */
  timeline: Timeline | null;
  timelineOpen: boolean;
  /** Organization spend read with admin keys (Connections → API keys). */
  orgSpend: OrgSpend | null;
};
const modePage: Record<Mode, Page> = { Discuss: "start", Plan: "plan", Build: "build", Research: "research" };
let snapshot: Snapshot = { data: null, messages: [], prefs, note: "", page: "start", lastPage: "start", mentions: { query: "", items: [] }, history: null, historyOpen: false, audit: null, timeline: null, timelineOpen: false, orgSpend: null };
const byId = new Map<string, ChatMessage>();
const listeners = new Set<() => void>();
const emit = (next: Partial<Snapshot>) => { snapshot = { ...snapshot, ...next }; for (const listener of listeners) listener(); };

export function post(message: FromWebview) {
  vscode.postMessage({ sessionId: snapshot.data?.chat?.id, ...message });
}
export function setPrefs(changes: Partial<ViewPrefs>) {
  prefs = { ...prefs, ...changes }; vscode.setState(prefs); emit({ prefs });
}
export const setNote = (note: string) => emit({ note });
export const setPage = (page: Page) => emit(page === "connections" ? { page, lastPage: snapshot.page === "connections" ? snapshot.lastPage : snapshot.page } : { page });
export const closeConnections = () => emit({ page: snapshot.lastPage });
export const setHistoryOpen = (historyOpen: boolean) => emit({ historyOpen, ...(historyOpen ? { timelineOpen: false } : { history: null }) });
export const setTimelineOpen = (timelineOpen: boolean) => { emit({ timelineOpen, ...(timelineOpen ? { historyOpen: false, history: null } : {}) }); if (timelineOpen) post({ type: "timeline" }); };
/** The Start, Plan, Build and Research pages each set the conversation's mode. */
const pageMode: Partial<Record<Page, Mode>> = { start: "Discuss", plan: "Plan", build: "Build", research: "Research" };
export function choosePage(page: Page) {
  const mode = pageMode[page];
  setPage(page);
  if (mode && mode !== snapshot.data?.state.mode) post({ type: "mode", value: mode });
}

window.addEventListener("message", ({ data }: MessageEvent<ToWebview>) => {
  if (data?.type === "connections") { setPage("connections"); return; }
  if (data?.type === "page") { setPage(data.page); return; }
  if (data?.type === "showHistory") { emit({ historyOpen: true, timelineOpen: false }); return; }
  if (data?.type === "showTimeline") { setTimelineOpen(true); return; }
  if (data?.type === "timeline") { emit({ timeline: data.timeline }); return; }
  if (data?.type === "spend") { emit({ orgSpend: data.spend }); return; }
  if (data?.type === "mentions") { emit({ mentions: { query: data.query, items: data.items } }); return; }
  if (data?.type === "history") { emit({ history: { query: data.query, items: data.items, current: data.current } }); return; }
  if (data?.type === "audit") { emit({ audit: data.entries }); return; }
  if (data?.type !== "state") return;
  const { type: _type, messages: sync, ...state } = data;
  const next: Partial<Snapshot> = { data: state };
  // Switching mode shows that mode's page (unless Connections is open).
  if (state.state.mode !== snapshot.data?.state.mode && snapshot.page !== "connections") next.page = modePage[state.state.mode];
  // A local note shows until the status or the chat error changes.
  if (state.status !== snapshot.data?.status || state.chat?.error !== snapshot.data?.chat?.error) next.note = "";
  if (sync) {
    if (sync.reset) byId.clear();
    for (const message of sync.upsert) byId.set(message.id, message);
    const order = new Set(sync.order);
    for (const id of [...byId.keys()]) if (!order.has(id)) byId.delete(id);
    next.messages = sync.order.map(id => byId.get(id)).filter((message): message is ChatMessage => !!message);
    // An open timeline follows the conversation.
    if (snapshot.timelineOpen && (sync.reset || sync.order.length !== snapshot.messages.length)) post({ type: "timeline" });
  }
  emit(next);
});

const subscribe = (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); };
export function useStore<T>(select: (value: Snapshot) => T): T {
  return useSyncExternalStore(subscribe, () => select(snapshot));
}
export const ready = () => post({ type: "ready" });
/** The current snapshot, for event handlers that should not subscribe. */
export const currentMessages = () => snapshot.messages;

/**
 * Text that round-trips through the extension (draft, brief). Local edits show at once;
 * echoes of what was typed are ignored so the cursor never jumps, while changes made
 * elsewhere (sending clears the draft, a resumed chat restores it) still arrive.
 */
export function useSyncedText(server: string, send: (value: string) => void): [string, (value: string) => void] {
  const [text, setText] = useState(server);
  const sent = useRef<string[]>([]);
  useEffect(() => {
    const at = sent.current.indexOf(server);
    if (at >= 0) { sent.current = sent.current.slice(at + 1); return; }
    sent.current = []; setText(server);
  }, [server]);
  return [text, value => { setText(value); sent.current.push(value); send(value); }];
}
