import { memo, useEffect, useState } from "react";
import type { Step } from "../protocol";
import { post } from "../store";

const icons: Record<Step["status"], string> = { running: "◌", waiting: "?", done: "✓", failed: "✕", denied: "⊘" };
const approvalText = {
  edit: ["Apply this change?", "Always allow edits in this chat"],
  command: ["Run this command?", "Always allow commands in this chat"],
  network: ["Fetch this page?", "Always allow web access in this chat"],
  outside: ["Allow access outside the project?", "Always allow outside access in this chat"],
} as const;
// The saved-rule option: "Always allow “npm test” in this project".
const projectRule = (rule: NonNullable<Step["rule"]>) => rule.kind === "edit" ? "Always allow edits in this project"
  : rule.kind === "network" ? `Always allow ${rule.pattern} in this project` : `Always allow “${rule.pattern}” in this project`;
const LOOKUPS = ["find_definition", "find_references", "find_symbols", "file_outline", "get_problems"];
const category = (tool: string) =>
  ["read_file", "list_directory", "glob", "grep", ...LOOKUPS].includes(tool) ? "explore"
    : ["write_file", "edit_file", "apply_patch", "delete_path", "move_path", "create_directory", "rename_symbol"].includes(tool) ? "edit"
      : tool === "web_fetch" ? "web" : tool;

export function duration(ms: number) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}
/** Re-renders every second while `active`, for live elapsed times. */
export function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return active ? now : Date.now();
}

function Diff({ diff }: { diff: string }) {
  return (
    <pre className="diff">{diff.split("\n").map((line, index) => (
      <span key={index} className={/^(\+\+\+|---)/.test(line) ? "diff-file" : line.startsWith("@@") ? "diff-hunk" : line.startsWith("+") ? "diff-add" : line.startsWith("-") ? "diff-del" : undefined}>{line + "\n"}</span>
    ))}</pre>
  );
}

const StepItem = memo(function StepItem({ step }: { step: Step }) {
  const body = step.diff || step.output;
  const [question, always] = step.approval ? approvalText[step.approval] : ["Allow this action?", "Always allow in this chat"];
  return (
    <div className={`step ${step.status}`}>
      <div className="step-head">
        <span className="step-icon">{icons[step.status] || "·"}</span><span className="step-title">{step.title}</span>
        {step.startedAt !== undefined && step.endedAt !== undefined && step.endedAt - step.startedAt >= 2000 ? <span className="step-time">{duration(step.endedAt - step.startedAt)}</span> : null}
      </div>
      {step.detail && <small className="step-detail">{step.detail}</small>}
      {step.allowedBy && step.allowedBy !== "approved by you" && <small className="step-detail step-allowed">{step.allowedBy.replace(/^./, c => c.toUpperCase())}</small>}
      {step.todos && <ul className="todos">{step.todos.map((todo, index) => <li key={index} className={`todo ${todo.status}`}>{todo.content}</li>)}</ul>}
      {body && (
        <details open={step.status === "waiting" || (step.status === "running" && !!step.output)}>
          <summary>{step.diff ? "Changes" : "Output"}</summary>
          {step.diff ? <Diff diff={step.diff} /> : <pre className="command-output">{step.output}</pre>}
          {step.diff && step.output && <pre className="command-output">{step.output}</pre>}
        </details>
      )}
      {step.status === "waiting" && (
        <div className={`approval${step.untrusted ? " untrusted" : ""}`}>
          <strong>{question}</strong>
          {step.untrusted && <p className="untrusted-note" role="note">⚠ This chat contains untrusted content ({step.untrusted}). It could be trying to steer the agent: check exactly what this does before approving. “Always allow” is off until the content leaves the chat.</p>}
          <div className="row">
            <button className="primary" onClick={() => post({ type: "approval", id: step.id, decision: "approve" })}>Approve</button>
            {!step.untrusted && <button className="ghost" onClick={() => post({ type: "approval", id: step.id, decision: "always" })}>{always}</button>}
            {!step.untrusted && step.rule && step.approval !== "outside" && <button className="ghost" title="Saved for this project; manage it on the Workspace view's Rules page" onClick={() => post({ type: "approval", id: step.id, decision: "project" })}>{projectRule(step.rule)}</button>}
            <button className="ghost" onClick={() => post({ type: "approval", id: step.id, decision: "deny" })}>Deny</button>
            {step.diff && <button className="ghost" onClick={() => post({ type: "openDiff", id: step.id })}>Open Diff</button>}
          </div>
        </div>
      )}
    </div>
  );
});

function groupTitle(kind: string, steps: Step[]) {
  const count = (tools: string[]) => steps.filter(step => tools.includes(step.tool)).length;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (kind === "explore") {
    const parts = [count(["read_file"]) && `read ${plural(count(["read_file"]), "file")}`, count(["grep", "glob"]) && `searched ${plural(count(["grep", "glob"]), "time")}`,
      count(["list_directory"]) && `listed ${plural(count(["list_directory"]), "folder")}`, count(LOOKUPS) && `looked up code ${plural(count(LOOKUPS), "time")}`].filter(Boolean).join(", ");
    return parts.charAt(0).toUpperCase() + parts.slice(1);
  }
  if (kind === "edit") {
    let added = 0, removed = 0;
    for (const step of steps) { const match = /\(\+(\d+) −(\d+)\)/.exec(step.title); if (match) { added += +match[1]; removed += +match[2]; } }
    return `Made ${plural(steps.length, "change")}${added || removed ? ` (+${added} −${removed})` : ""}`;
  }
  return kind === "web" ? `Fetched ${plural(steps.length, "page")}` : `${plural(steps.length, "step")}`;
}
type Segment = { kind: string; steps: Step[] };
// Consecutive finished reads, edits and fetches collapse into one line; anything running,
// waiting, failed or denied stays visible. Only the latest checklist is shown.
function segments(steps: Step[]): Segment[] {
  const lastTodo = steps.findLastIndex(step => step.tool === "todo_write");
  const result: Segment[] = [];
  steps.forEach((step, index) => {
    if (step.tool === "todo_write" && index !== lastTodo) return;
    const kind = step.status === "done" && ["explore", "edit", "web"].includes(category(step.tool)) ? category(step.tool) : "single";
    const last = result.at(-1);
    if (kind !== "single" && last?.kind === kind) last.steps.push(step); else result.push({ kind, steps: [step] });
  });
  return result;
}

export const Steps = memo(function Steps({ steps, finished, startedAt, endedAt }: { steps: Step[]; finished: boolean; startedAt?: number; endedAt?: number }) {
  const items = segments(steps).map(segment => segment.steps.length > 1
    ? <details key={segment.steps[0].id} className="step-group"><summary><span className="step-icon">✓</span>{groupTitle(segment.kind, segment.steps)}</summary>
        {segment.steps.map(step => <StepItem key={step.id} step={step} />)}</details>
    : <StepItem key={segment.steps[0].id} step={segment.steps[0]} />);
  if (!finished || steps.length < 4) return <>{items}</>;
  const failed = steps.filter(step => step.status === "failed").length;
  return (
    <details className="work-summary">
      <summary>{startedAt !== undefined && endedAt !== undefined ? `Worked for ${duration(endedAt - startedAt)}` : "Work"} · {steps.length} steps{failed ? ` · ${failed} failed` : ""}</summary>
      {items}
    </details>
  );
});
