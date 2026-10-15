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
  /** Set when untrusted content (web pages, research sources…) is in the conversation: "always" options are not offered. */
  untrusted?: string;
  /** Autocompute: the local model that ran this step for a delegated task. */
  by?: string;
};
/** A task the lead (online) model delegated to a local model, and the lead model's verdict on it. */
export type DelegatedTask = {
  id: string; title: string; kind: string; model: string; instructions: string; files: string[]; check: string | null;
  state: "running" | "checking" | "review" | "revising" | "accepted" | "takeover" | "unreviewed";
  attempts: number; summary: string; usage: { input: number; output: number }; exitCode?: number | null;
  verdict?: "accept" | "revise" | "takeover"; review?: string; outcome?: "first" | "revised" | "takeover"; error?: string;
  /** The lead model's confidence (0–100) in the chosen model, and its score for every eligible model. */
  confidence?: number; scores?: { model: string; confidence: number; reason: string }[]; difficulty?: "easy" | "medium" | "hard";
};
export type ChangedFile = { path: string; status: "added" | "modified" | "deleted"; added: number; removed: number; restorable: boolean; reverted?: boolean };
export type Proposal = { id: string; kind: "file" | "plan" | "command" | "browse" | "verify"; path?: string; text: string; reason?: string; status?: string; key?: string };
export type TokenUsage = { input: number; output: number; billedInput?: number; first?: number };
export type Review = { model: string; state: "running" | "complete" | "failed" | "stopped"; content: string; startedAt: number; endedAt?: number; error?: string; usage?: TokenUsage; cost?: number };
export type Citation = { key: string; title: string; url: string };
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
  usage?: TokenUsage; phase?: "condensing"; contextNote?: string;
  /** The model's reasoning (newest part, bounded), shown live and collapsed afterwards. */
  reasoning?: string;
  /** Build reply that marked tasks completed without changing a file or running a command:
   * retrying while the model is sent back to do the work, unresolved when it still did nothing. */
  unbacked?: "retrying" | "unresolved";
  /** Dollar cost of an API-key reply (provider prices, estimated). */
  cost?: number; review?: Review; citations?: Citation[]; untrusted?: string[]; createdAt?: number;
  /** Autocompute: tasks delegated to local models, and the local models' token use (not in `usage`). */
  autocompute?: { tasks: DelegatedTask[]; usage: { input: number; output: number } };
};
export type Mention = { path: string; kind: "file" | "folder" | "blocked" | "skipped"; lines?: number; entries?: number; truncated?: boolean; error?: string };
export type ImageInfo = { id: string; name: string; mime: string; size: number };
export type Usage = { used: number; estimated?: number; window: number; system: number; history: number; shared: number; condensed: number; measured: { input: number; output: number } | null;
  /** counted: the provider's tokenizer; calibrated: estimate corrected by the last reply; estimated: characters ÷ 4. */
  source?: "counted" | "calibrated" | "estimated" };
export type Evidence = { status: "passed" | "failed"; check: string; kind: "command" | "manual"; exitCode?: number | null; output?: string; at: number; by: "you" | "agent" };
export type PlanStep = { key: string; text: string; done: boolean; check: { kind: "command" | "manual"; text: string } | null; evidence: Evidence | null };
export type SpendTotals = { total: number; byProvider: Record<string, number> };
export type Limits = { tokens?: { limit?: number; remaining?: number; reset?: string }; requests?: { limit?: number; remaining?: number; reset?: string };
  plan?: { window: "primary" | "secondary"; usedPercent: number; windowMinutes?: number; resetSeconds?: number }[]; at?: number };
export type OrgSpend = Partial<Record<"openai" | "anthropic", { amount?: number; since?: string; error?: string; at: number }>>;
export type TimelinePoint = { id: string; text: string; at: number | null; reply: { state: string; files: string[]; steps: number; verified: boolean } | null;
  checkpoint: boolean; comparable: boolean; branches: { id: string; title: string; messageCount: number }[] };
export type Timeline = { id: string; title: string; parent: { id: string; title: string } | null; points: TimelinePoint[]; otherBranches: { id: string; title: string; messageCount: number }[] };
export type BackgroundTask = { id: string; title: string; prompt: string; model: string; state: "running" | "stopping" | "done" | "failed" | "stopped" | "interrupted" | "applied" | "discarded";
  createdAt: number; endedAt?: number; files: { path: string; status: "added" | "modified" | "deleted" }[]; error?: string; summary?: string; activity?: string;
  approvals: { id: string; title: string }[]; conflicted?: string[]; removed?: boolean; cost?: number };
export type ContextInfo = { editor: number; selection: { label: string; chars: number } | null; problems: { count: number; errors: number; chars: number }; diff: { chars: number } | null };
export type ProcessInfo = { id: string; command: string; cwd: string; status: "running" | "exited"; exitCode: number | null; startedAt: number; endedAt?: number; sandboxed: boolean };
export type Rule = { id: string; effect: "allow" | "deny"; kind: "command" | "edit" | "network" | "path"; pattern: string; createdAt: string };
export type HistoryItem = { id: string; title: string; updatedAt: string; messageCount: number; snippet?: string };
export type AuditEntry = { time: string; event: string; tool?: string; title: string; status?: string; decision?: string; permission?: string; detail?: string };
export type PathItem = { path: string; kind: "file" | "folder" };
export type Page = "start" | "plan" | "build" | "research" | "rules" | "activity" | "connections";
/** vision/tools: what the model accepts, when known (local models); size and family from Ollama. */
export type Model = { id: string; name: string; vision?: boolean; tools?: boolean; size?: string; family?: string };
export type Connection = { provider: string; connected?: boolean; installed?: boolean; account?: string; error?: string };
export type Connections = {
  models: Model[]; connections: Connection[]; secureStorage?: boolean; error?: string;
  chatgpt?: { accounts: { id: string; label: string; signedIn: boolean }[]; activeId: string | null; welcome?: boolean };
  /** Which providers have an admin key for organization spend. */
  admin?: { openai: boolean; anthropic: boolean };
};
export type Attachment = { id: string; name: string; shared: boolean; readable: boolean };
export type ChatState = {
  id: string; title: string; model: string; busy: boolean; switching: boolean; connecting: boolean; error: string;
  attachments: Attachment[]; sharePlan: boolean; shareEditor: boolean; connections: Connections;
  permission: Permission; agent: { sandbox: boolean; project: { name: string; trusted: boolean } | null } | null; grants: string[];
  compacting: boolean; shareSelection: boolean; shareDiff: boolean; shareProblems: boolean; contextInfo: ContextInfo | null;
  usage: Usage | null; queue: { id: string; text: string }[]; queuePaused: boolean; images: ImageInfo[]; processes: ProcessInfo[]; rules: Rule[];
  planSteps: PlanStep[]; checking: string | null; untrusted: string[];
  cost: { total: number; unpriced: number } | null; spend: { today: SpendTotals; month: SpendTotals } | null; budget: number; limits: Record<string, Limits>;
  /** Autocompute checkbox; ready is false (with the reason) when a Build turn could not delegate. */
  autocompute?: { enabled: boolean; ready: boolean; reason: string; locals: string[] };
};
export type Source = { id: string; url: string; title: string; text: string; kind?: "selection" | "page"; shared: boolean };
export type ResearchState = { sources: Source[]; opened: boolean; busy: boolean; loading: boolean; url: string; title: string; error: string };
/**
 * One tutorial step drawn inside a panel (the extension drives the tutorial; steps outside the
 * panels are drawn by the window). target: the element the bubble points at; press: a button the
 * tutorial presses first; demo: show the sample reply; page: the Workspace page to show.
 */
export type TutorialStep = { id: string; index: number; total: number; title: string; body: string; target: string; last: boolean;
  press?: string; demo?: boolean; panes?: "none" | "keep"; page?: Page };
export type HelpDoc = { id: string; title: string; markdown: string };
/** A Furnace theme (product/theme-model.cjs validates it): six parts that can be mixed and matched. */
export type ThemePicture = { source: "bundled" | "user"; name: string; fit: "cover" | "tile" | "center" };
export type Theme = {
  version: 1; id: string; name: string;
  background: { kind: "solid" | "gradient" | "picture"; color: string; gradient: { stops: string[]; angle: number } | null; picture: ThemePicture | null;
    dim: "auto" | number; glass: boolean; ember: "off" | "sparks" | "glow"; emberIntensity: number };
  font: { family: string }; text: { main: string; muted: string }; code: string; editor: { background: string }; accent: string;
};
export type ThemePart = "background" | "font" | "text" | "code" | "editor" | "accent";
export type ThemeCheck = { id: string; label: string; ratio: number; need: number; ok: boolean };
export type ThemeEditorState = {
  theme: Theme; checks: ThemeCheck[]; opacity: number | null; windowPart: boolean;
  sources: { id: string; name: string; preset: boolean }[]; codes: { id: string; name: string }[];
  fonts: { bundled: string[]; installed: string[] };
  pictures: { source: "bundled" | "user"; name: string; label: string; url: string }[];
};
export type Glow = "off" | "idle" | "working" | "waiting" | "error";
/** Messages are sent incrementally: only the ones that changed since the last update. */
export type MessageSync = { reset: boolean; order: string[]; upsert: ChatMessage[] };
export type State = {
  state: { mode: Mode; draft: string; brief: string };
  scope: string; status: string;
  review: { pending: boolean; busy: boolean; generation: number };
  research: ResearchState;
  chat: ChatState | null;
  modeModels: Partial<Record<Mode, string>>;
  background: BackgroundTask[];
  /** Agent glow around the chat panel (Themes → Agent Glow). */
  glow?: Glow;
};

export type ToWebview =
  | ({ type: "state"; messages?: MessageSync } & State)
  | { type: "connections" | "showHistory" | "showTimeline" }
  | { type: "timeline"; timeline: Timeline }
  | { type: "spend"; spend: OrgSpend }
  | { type: "page"; page: Page }
  | { type: "mentions"; query: string; items: PathItem[] }
  | { type: "history"; query: string; items: HistoryItem[]; current: string }
  | { type: "audit"; entries: AuditEntry[] }
  | { type: "tutorial"; step: TutorialStep | null }
  | { type: "help"; docs: HelpDoc[]; section?: string }
  | { type: "theme"; tokens: Record<string, string> | null; backdrop: boolean; glow: boolean }
  | ({ type: "themeEditor" } & ThemeEditorState);

type Plain<T extends string> = { type: T };
export type ConnectionAction =
  | { action: "discover" | "cancel" | "acknowledge" }
  | { action: "connect"; provider: string; key: string; remember: boolean }
  | { action: "disconnect" | "adminDisconnect"; provider: string }
  | { action: "adminConnect"; provider: string; key: string; remember: boolean }
  | { action: "signIn"; accountId: string | null; remember: boolean }
  | { action: "selectAccount" | "signOut"; accountId: string };

export type FromWebview = { sessionId?: string } & (
  | Plain<"ready" | "home" | "openFolder" | "openFile" | "researchClose" | "captureSelection" | "capturePage" | "stop" | "connections"
      | "newChat" | "resumeChat" | "trustFolder" | "tutorial" | "help" | "focusConversation" | "textSmaller"
      | "textLarger" | "textReset" | "chatgptUsage" | "claudeLogin" | "claudeConsole" | "propose" | "attach"
      | "compact" | "buildPlan" | "auditLoad" | "auditOpen" | "auditClear" | "openScm" | "keys" | "diagnostics"
      | "feedback" | "checkUpdates" | "timeline" | "spendRefresh" | "inlineEdit">
  | { type: "mode"; value: Mode }
  | { type: "draft" | "brief" | "send" | "run" | "model" | "researchOpen" | "enqueue" | "mentionSearch" | "historyList" | "backgroundStart" | "themeCommand"; value: string }
  | { type: "permission"; value: Permission }
  | { type: "autocompute"; enabled: boolean }
  | Plain<"autocomputeReset">
  | { type: "context"; field: "sharePlan" | "shareEditor" | "shareSelection" | "shareDiff" | "shareProblems"; enabled: boolean }
  | { type: "sourceShare" | "attachmentShare"; id: string; enabled: boolean }
  | { type: "sourceRemove" | "attachmentRemove" | "approveProposal" | "discardProposal" | "openDiff" | "dequeue" | "sendQueued" | "removeImage"
      | "historyOpen" | "historyDelete" | "ruleRemove" | "processStop" | "processShow"
      | "backgroundStop" | "backgroundReview" | "backgroundApply" | "backgroundDiscard"; id: string }
  | { type: "backgroundDecide"; stepId: string; decision: "approve" | "deny" }
  | { type: "backgroundFollowUp"; id: string; value: string }
  | { type: "checkStep"; key: string }
  | { type: "confirmStep"; key: string; passed: boolean }
  | { type: "approval"; id: string; decision: "approve" | "always" | "project" | "deny" }
  | { type: "historyRename"; id: string; title: string }
  | { type: "pasteImage"; name: string; mime: string; data: string }
  | { type: "ruleAdd"; effect: Rule["effect"]; kind: Rule["kind"]; pattern: string }
  | { type: "branch" | "regenerate"; messageId: string }
  | { type: "connection"; value: ConnectionAction }
  | { type: "tutorialAction"; id: string; action: "next" | "back" | "end" }
  | { type: "openLink"; url: string }
  | { type: "apply" | "discard"; generation: number }
  | { type: "revertChanges"; messageId: string; path?: string }
  | { type: "openChange"; messageId: string; path?: string }
  | { type: "rewind" | "reviewChanges" | "addressReview" | "compareFrom"; messageId: string }
  | { type: "copy" | "insertSnippet"; text: string }
  | Plain<"themeReady" | "themePicture" | "themeCancel">
  | { type: "themeDraft"; theme: Theme }
  | { type: "themeSave"; theme: Theme; asNew: boolean }
  | { type: "themeTake"; part: ThemePart; from: string }
  | { type: "themeFix" | "themeDelete"; id: string }
);
