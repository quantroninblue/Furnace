import type { State } from "./protocol";
import { post } from "./store";

export type TourStep = { title: string; text: string; done: boolean; actions: [label: string, run: () => void, style: "primary" | "ghost"][] };

// First-run tutorial: each step is derived from live state, so it completes itself.
export function tourSteps(data: State): TourStep[] {
  const chat = data.chat, models = chat?.connections.models || [], project = chat?.agent?.project, seen = data.tour.seen || {};
  const permission = (value: "ask" | "auto" | "full") => () => { post({ type: "permission", value }); post({ type: "tour", action: "ack", step: "permissions" }); };
  const style = (value: string) => (chat?.permission === value ? "primary" : "ghost");
  return [
    { title: "Connect a model", text: "Use your ChatGPT plan, Claude Code, an OpenAI or Anthropic API key, or a local Ollama model.", done: models.length > 0, actions: [["Open Connections", () => post({ type: "connections" }), "primary"]] },
    { title: "Choose a model", text: "Pick it in the model menu inside the message box, at the bottom of the conversation panel. The status bar always shows the active model.", done: models.some(model => model.id === chat?.model), actions: [["Show Conversation", () => post({ type: "focusConversation" }), "primary"]] },
    { title: "Open a project folder", text: "The agent works on the files in the folder you open. You can also just chat without one.", done: !!project, actions: [["Open Folder", () => post({ type: "openFolder" }), "primary"]] },
    { title: "Trust the folder", text: "Trusting lets the agent read and change files and run commands there. Only trust projects you know.", done: !!project?.trusted, actions: project ? [["Trust Folder", () => post({ type: "trustFolder" }), "primary"]] : [] },
    { title: "Choose how much the agent may do", text: "Ask first: you approve every change and command. Auto: project edits apply directly and commands run in a sandbox without network. Full access: no approvals and no sandbox. You can change this any time above the message box.", done: !!seen.permissions,
      actions: [["Ask first", permission("ask"), style("ask")], ["Auto", permission("auto"), style("auto")], ["Full access", permission("full"), style("full")]] },
    { title: "Give it a first task", text: "Switch to Build mode and describe a small change. Each action the agent takes shows up as a step you can open.", done: !!seen.task, actions: [["Try an Example", () => post({ type: "tourExample" }), "primary"]] },
    { title: "Review, undo and stop", text: "Each reply lists the files it changed: open a diff, revert one file or the whole reply, or rewind the chat from one of your messages. Undo (Ctrl+Z) also works in the editor, and the square button (or Escape) stops the agent. Text too small? Use Text size at the top of this page, or Ctrl+= and Ctrl+−.", done: !!seen.review, actions: [["Got It", () => post({ type: "tour", action: "ack", step: "review" }), "primary"]] },
  ];
}
