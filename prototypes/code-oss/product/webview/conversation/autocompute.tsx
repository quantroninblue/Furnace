import type { ChatMessage, DelegatedTask } from "../protocol";

const short = (model: string) => model.slice(model.indexOf("/") + 1);
const tokens = (value: number) => value >= 10000 ? `${Math.round(value / 1000)}k` : value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
const icon: Record<DelegatedTask["state"], string> = { running: "◌", checking: "◌", review: "?", revising: "↺", accepted: "✓", takeover: "↻", unreviewed: "·" };
function label(task: DelegatedTask) {
  if (task.state === "accepted") return task.outcome === "revised" ? "accepted after revision" : "accepted";
  return { running: "working…", checking: "checking…", review: "waiting for review", revising: "sent back", takeover: "taken over", unreviewed: "not reviewed" }[task.state];
}

// Autocompute: what the lead model gave to local models, how each check went and its verdict.
export function Delegated({ message }: { message: ChatMessage }) {
  const auto = message.autocompute!, accepted = auto.tasks.filter(task => task.state === "accepted").length;
  const local = auto.usage.input + auto.usage.output;
  return (
    <div className="changes autocompute" aria-label="Tasks delegated to local models">
      <div className="changes-head"><strong>Delegated to local models</strong>
        <small className="muted" title={`Local tokens: ${auto.usage.input} input, ${auto.usage.output} output. They run on this machine and use none of your online usage.`}>
          {accepted} of {auto.tasks.length} accepted{local ? ` · ${tokens(local)} local tokens` : ""}</small>
      </div>
      {auto.tasks.map(task => (
        <details key={task.id} className={`auto-task ${task.state}`}>
          <summary><span className="step-icon">{icon[task.state]}</span><span className="auto-title">{task.title}</span>
            <span className="step-by" title={task.confidence === undefined ? undefined : `The online model was ${task.confidence}% confident this model could finish the task`}>{short(task.model)}{task.confidence === undefined ? "" : ` · ${task.confidence}%`}</span><span className="auto-state">{label(task)}</span></summary>
          <div className="auto-body">
            <small className="muted">{[task.kind, task.difficulty ?? "", task.attempts > 1 ? `${task.attempts} attempts` : "", task.check ? `check ${task.exitCode === 0 ? "passed" : task.exitCode === undefined ? "pending" : task.exitCode === null ? "did not run" : `failed (exit ${task.exitCode})`}: ${task.check}` : "no check",
              task.usage.input + task.usage.output ? `${tokens(task.usage.input + task.usage.output)} tokens` : ""].filter(Boolean).join(" · ")}</small>
            {task.scores && task.scores.length > 1 && <p><b>Confidence:</b> {task.scores.map(score => `${short(score.model)} ${score.confidence}%${score.reason ? ` (${score.reason})` : ""}`).join(" · ")}</p>}
            {task.review && <p><b>Review:</b> {task.review}</p>}
            {task.summary.trim() && <p><b>{short(task.model)}:</b> {task.summary.trim()}</p>}
            {task.error && <p className="error">{task.error}</p>}
            <details><summary>Instructions</summary><pre>{task.instructions}</pre></details>
          </div>
        </details>
      ))}
    </div>
  );
}
