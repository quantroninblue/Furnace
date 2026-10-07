import type { BrowserBounds, BrowserState } from "./browser";
export type Entry = { name: string; path: string; directory: boolean };
export type Document = { path: string; text: string; revision: string };
export type Project = { root: string; name: string };
export type Attachment = {
  id: string;
  name: string;
  path: string;
  size: number;
  text?: string;
};
export type Selection = { url: string; title: string; text: string };
export type ResearchSource = {
  id: string; url: string; title: string; text: string;
  links: { url: string; label: string }[];
  images: { url: string; label: string }[];
  capturedAt: string; truncated: boolean;
  /** Citation key for this conversation, e.g. "S1". */
  cite?: string;
};
export type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  model?: string;
  kind?: "command" | "workspace" | "summary";
  exitCode?: number | null;
  activity?: string[];
  proposals?: Proposal[];
};
export type AgentMode = "discuss" | "plan" | "build" | "research";
export type FileProposal = {
  kind: "file";
  id: string;
  path: string;
  text: string;
  original: string;
  revision: string | null;
  reason: string;
  status: "pending" | "applied" | "discarded" | "expired";
};
export type Proposal = FileProposal | {
  kind: "command" | "plan" | "browse";
  text: string;
  reason: string;
};
export type RemoteProvider = "openai" | "anthropic";
export type ChatGPTAccount = { id: string; label: string; signedIn: boolean; planEnabled: boolean; storage: "session" | "encrypted" | "none" };
export type ChatGPTStatus = { accounts: ChatGPTAccount[]; activeId: string | null; pending: boolean; welcome: boolean; models: { id: string; name: string }[]; error?: string };
export type ClaudeStatus = { installed: boolean; compatible: boolean; connected: boolean; version?: string; account?: string; authMethod?: string; error?: string; models: { id: string; name: string }[] };
export type ProviderConnection = { provider: RemoteProvider; connected: boolean; storage: "session" | "encrypted" | "none"; models: { id: string; name: string }[]; error?: string };
export type AgentStatus = {
  ollamaPath: string | null;
  models: string[];
  ollamaError?: string;
  providers: ProviderConnection[];
  secureStorage: boolean;
  chatgpt?: ChatGPTStatus;
  claude?: ClaudeStatus;
};
export type SessionSummary = { id: string; title: string; createdAt: string; updatedAt: string; projectRoot: string | null; model: string; messageCount: number; snippet?: string; branchOf?: string; branchAt?: string };
export type Session = Omit<SessionSummary, "messageCount" | "snippet"> & { messages: Message[]; plan: string; sources?: ResearchSource[]; customTitle?: string;
  /** Plan step key → latest acceptance-check result (see plan-link.ts). */
  evidence?: Record<string, unknown>;
  /** Research source id → its citation key ([S1] …) with title and URL, kept after the source is removed. */
  citations?: Record<string, { key: string; title: string; url: string }> };
export type ChatEvent = {
  id: string;
  delta?: string;
  done?: boolean;
  error?: string;
  exitCode?: number | null;
  activity?: string;
  proposal?: Proposal;
  /** Measured by the provider: input = prompt size of the latest model call, output = tokens it generated. */
  usage?: { input?: number; output?: number };
  /** Rate-limit or plan-usage headers from the provider's latest response. */
  limits?: import("../main/remote-models").Limits;
};
export type ImageInput = { mime: string; data: string };
export interface WorkspaceAPI {
  claude: {
    login(consoleAccount: boolean): Promise<void>;
    stopLogin(): Promise<void>;
    write(data: string): Promise<void>;
    resize(cols: number, rows: number): Promise<void>;
    guide(): Promise<void>;
    onLoginData(callback: (data: string) => void): () => void;
    onLoginExit(callback: (code: number) => void): () => void;
  };
  chatgpt: {
    signIn(accountId: string | null, remember: boolean): Promise<AgentStatus>;
    cancel(): Promise<void>;
    select(accountId: string): Promise<AgentStatus>;
    signOut(accountId: string): Promise<{ status: AgentStatus; warning?: string }>;
    acknowledge(): Promise<AgentStatus>;
    usage(): Promise<void>;
  };
  windowControls: {
    minimize(): Promise<void>;
    toggleMaximize(): Promise<void>;
    close(): Promise<void>;
    isMaximized(): Promise<boolean>;
    onMaximized(callback: (maximized: boolean) => void): () => void;
  };
  project: {
    open(): Promise<Project | null>;
    current(): Promise<Project | null>;
    list(path: string): Promise<Entry[]>;
  };
  file: {
    read(path: string): Promise<Document>;
    save(document: Document): Promise<Document>;
    applyProposal(id: string, text: string): Promise<Document>;
    discardProposal(id: string): Promise<void>;
  };
  attachments: {
    choose(): Promise<Attachment[]>;
    import(paths: string[]): Promise<Attachment[]>;
    path(file: File): string;
  };
  session: {
    read(): Promise<Session>;
    start(): Promise<Session>;
    list(): Promise<SessionSummary[]>;
    resume(id: string): Promise<Session>;
    write(session: Session, projectRoot: string | null): Promise<void>;
  };
  agents: {
    discover(): Promise<AgentStatus>;
    connect(provider: RemoteProvider, key: string, remember: boolean): Promise<AgentStatus>;
    disconnect(provider: RemoteProvider): Promise<AgentStatus>;
    send(request: {
      id: string;
      model: string;
      messages: Message[];
      context: string;
      mode?: AgentMode;
      plan?: string;
      allowSelection?: boolean;
      sourceIds?: string[];
    }): Promise<void>;
    stop(): Promise<void>;
    onEvent(callback: (event: ChatEvent) => void): () => void;
  };
  terminal: {
    run(request: { id: string; command: string }): Promise<void>;
    start(): Promise<void>;
    write(data: string): Promise<void>;
    resize(cols: number, rows: number): Promise<void>;
    onData(callback: (data: string) => void): () => void;
  };
  research: {
    open(url: string, placement?: "embedded" | "popup"): Promise<void>;
    bounds(value: BrowserBounds | null): Promise<void>;
    onBrowserState(callback: (state: BrowserState) => void): () => void;
    onDock(callback: () => void): () => void;
    capture(): Promise<ResearchSource>;
    onSelection(callback: (selection: Selection) => void): () => void;
  };
}
