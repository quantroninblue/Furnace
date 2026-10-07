// Messages between the extension (extension.cjs) and its two webview surfaces. The
// extension validates every incoming message at runtime; these types keep the panels honest.

export type Mode = "Discuss" | "Plan" | "Build" | "Research";
export type Permission = "ask" | "auto" | "full";
export type StepStatus = "running" | "waiting" | "done" | "failed" | "denied";
export type ApprovalKind = "edit" | "command" | "network" | "outside";

export type Todo = { content: string; status: "pending" | "in_progress" | "completed" };
export type Step = {
  id: string; tool: string; title: string; status: StepStatus;
  detail?: string; diff?: string; output?: string; approval?: ApprovalKind; todos?: Todo[];
  startedAt?: number; endedAt?: number;
  rule?: { kind: "command" | "edit" | "network"; pattern: string; subject: string }; allowedBy?: string;
};
export type ChangedFile = { path: string; status: "added" | "modified" | "deleted"; added: number; removed: number; restorable: boolean; reverted?: boolean };
export type Proposal = { id: string; kind: "file" | "plan" | "command" | "browse"; path?: string; text: string; reason?: string; status?: string };
export type ChatMessage = {
  id: string; role: "user" | "assistant"; content: string; model?: string;
  kind?: "command" | "workspace" | "summary"; cwd?: string; exitCode?: number | null;
  state?: "streaming" | "running" | "complete" | "stopped" | "failed" | "interrupted";
  error?: string; activity?: string[]; steps?: Step[]; proposals?: Proposal[];
  changes?: { files: ChangedFile[]; error?: string };
  startedAt?: number; endedAt?: number;
  /** Summary notes: how many earlier messages it covers; failed when summarising did not work. */
  condensed?: number; failed?: boolean;
  mentions?: Mention[]; images?: ImageInfo[];
  usage?: { input: number; output: number }; phase?: "condensing"; contextNote?: string;
};
export type Mention = { path: string; kind: "file" | "folder" | "blocked" | "skipped"; lines?: number; entries?: number; truncated?: boolean; error?: string };
export type ImageInfo = { id: string; name: string; mime: string; size: number };
export type Usage = { used: number; window: number; system: number; history: number; shared: number; condensed: number; measured: { input: number; output: number } | null };
export type ContextInfo = { editor: number; selection: { label: string; chars: number } | null; problems: { count: number; errors: number; chars: number }; diff: { chars: number } | null };
export type ProcessInfo = { id: string; command: string; cwd: string; status: "running" | "exited"; exitCode: number | null; startedAt: number; endedAt?: number; sandboxed: boolean };
export type Rule = { id: string; effect: "allow" | "deny"; kind: "command" | "edit" | "network" | "path"; pattern: string; createdAt: string };
export type HistoryItem = { id: string; title: string; updatedAt: string; messageCount: number; snippet?: string };
export type AuditEntry = { time: string; event: string; tool?: string; title: string; status?: string; decision?: string; permission?: string; detail?: string };
export type PathItem = { path: string; kind: "file" | "folder" };
export type Page = "start" | "plan" | "build" | "research" | "rules" | "activity" | "connections";
export type Model = { id: string; name: string };
export type Connection = { provider: string; connected?: boolean; installed?: boolean; account?: string; error?: string };
export type Connections = {
  models: Model[]; connections: Connection[]; secureStorage?: boolean; error?: string;
  chatgpt?: { accounts: { id: string; label: string; signedIn: boolean }[]; activeId: string | null; welcome?: boolean };
};
export type Attachment = { id: string; name: string; shared: boolean; readable: boolean };
export type ChatState = {
  id: string; title: string; model: string; busy: boolean; switching: boolean; connecting: boolean; error: string;
  attachments: Attachment[]; sharePlan: boolean; shareEditor: boolean; connections: Connections;
  permission: Permission; agent: { sandbox: boolean; project: { name: string; trusted: boolean } | null } | null; grants: string[];
  compacting: boolean; shareSelection: boolean; shareDiff: boolean; shareProblems: boolean; contextInfo: ContextInfo | null;
  usage: Usage | null; queue: { id: string; text: string }[]; queuePaused: boolean; images: ImageInfo[]; processes: ProcessInfo[]; rules: Rule[];
};
export type Source = { id: string; url: string; title: string; text: string; kind?: "selection" | "page"; shared: boolean };
export type ResearchState = { sources: Source[]; opened: boolean; busy: boolean; loading: boolean; url: string; title: string; error: string };
export type TourState = { dismissed: boolean; seen: Partial<Record<"permissions" | "task" | "review", boolean>> };
/** Messages are sent incrementally: only the ones that changed since the last update. */
export type MessageSync = { reset: boolean; order: string[]; upsert: ChatMessage[] };
export type State = {
  state: { mode: Mode; draft: string; brief: string };
  scope: string; status: string; tour: TourState;
  review: { pending: boolean; busy: boolean; generation: number };
  research: ResearchState;
  chat: ChatState | null;
  modeModels: Partial<Record<Mode, string>>;
};

export type ToWebview =
  | ({ type: "state"; messages?: MessageSync } & State)
  | { type: "connections" | "showHistory" }
  | { type: "page"; page: Page }
  | { type: "mentions"; query: string; items: PathItem[] }
  | { type: "history"; query: string; items: HistoryItem[]; current: string }
  | { type: "audit"; entries: AuditEntry[] };

type Plain<T extends string> = { type: T };
export type ConnectionAction =
  | { action: "discover" | "cancel" | "acknowledge" }
  | { action: "connect"; provider: string; key: string; remember: boolean }
  | { action: "disconnect"; provider: string }
  | { action: "signIn"; accountId: string | null; remember: boolean }
  | { action: "selectAccount" | "signOut"; accountId: string };

export type FromWebview = { sessionId?: string } & (
  | Plain<"ready" | "home" | "openFolder" | "openFile" | "researchClose" | "captureSelection" | "capturePage" | "stop" | "connections"
      | "newChat" | "resumeChat" | "trustFolder" | "tourDismiss" | "tourShow" | "tourExample" | "focusConversation" | "textSmaller"
      | "textLarger" | "textReset" | "chatgptUsage" | "claudeLogin" | "claudeConsole" | "propose" | "attach"
      | "compact" | "buildPlan" | "auditLoad" | "auditOpen" | "auditClear" | "openScm" | "keys" | "diagnostics">
  | { type: "mode"; value: Mode }
  | { type: "draft" | "brief" | "send" | "run" | "model" | "researchOpen" | "enqueue" | "mentionSearch" | "historyList"; value: string }
  | { type: "permission"; value: Permission }
  | { type: "context"; field: "sharePlan" | "shareEditor" | "shareSelection" | "shareDiff" | "shareProblems"; enabled: boolean }
  | { type: "sourceShare" | "attachmentShare"; id: string; enabled: boolean }
  | { type: "sourceRemove" | "attachmentRemove" | "approveProposal" | "discardProposal" | "openDiff" | "dequeue" | "sendQueued" | "removeImage"
      | "historyOpen" | "historyDelete" | "ruleRemove" | "processStop" | "processShow"; id: string }
  | { type: "approval"; id: string; decision: "approve" | "always" | "project" | "deny" }
  | { type: "historyRename"; id: string; title: string }
  | { type: "pasteImage"; name: string; mime: string; data: string }
  | { type: "ruleAdd"; effect: Rule["effect"]; kind: Rule["kind"]; pattern: string }
  | { type: "branch" | "regenerate"; messageId: string }
  | { type: "connection"; value: ConnectionAction }
  | { type: "tour"; action: "ack"; step: "permissions" | "review" }
  | { type: "apply" | "discard"; generation: number }
  | { type: "revertChanges"; messageId: string; path?: string }
  | { type: "openChange"; messageId: string; path?: string }
  | { type: "rewind"; messageId: string }
  | { type: "copy" | "insertSnippet"; text: string }
);
