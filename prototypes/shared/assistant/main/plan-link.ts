import type { Todo } from "./agent-tools";

// Plan → Build: the brief's Markdown checklist ("- [ ] step") is the task list Build works
// through. When the agent's checklist marks an item completed, the matching brief line is
// ticked. Items match by text (case, spacing and trailing punctuation ignored).
const ITEM = /^(\s*[-*+]\s+\[)([ xX])(\]\s+)(.+?)\s*$/;
const normal = (text: string) => text.toLowerCase().replace(/[`*_]/g, "").replace(/\s+/g, " ").replace(/[.:;!]+$/, "").trim();

export function briefSteps(brief: string) {
  return brief.split("\n").map(line => ITEM.exec(line)).filter((match): match is RegExpExecArray => !!match).map(match => ({ text: match[4], done: match[2] !== " " }));
}

/** The brief with completed todos ticked, or null when nothing changed. */
export function tickBrief(brief: string, todos: Todo[]) {
  const completed = new Set(todos.filter(todo => todo.status === "completed").map(todo => normal(todo.content)));
  if (!completed.size) return null;
  let changed = false;
  const lines = brief.split("\n").map(line => {
    const match = ITEM.exec(line);
    if (!match || match[2] !== " " || !completed.has(normal(match[4]))) return line;
    changed = true;
    return line.replace(ITEM, (_all, open, _mark, close, text) => `${open}x${close}${text}`);
  });
  return changed ? lines.join("\n") : null;
}

export function buildFromPlanPrompt(brief: string) {
  const open = briefSteps(brief).filter(step => !step.done);
  return open.length
    ? `Implement the shared planning brief step by step. Start by calling todo_write with these ${open.length} unchecked steps from the brief, using their exact wording:\n${open.map(step => `- ${step.text}`).join("\n")}\nWork through them in order, keep exactly one in_progress, and mark each completed with todo_write as soon as it is done and verified, so the brief's checklist ticks off as you go.`
    : "Implement the shared planning brief. It has no unchecked checklist items, so first break the work into steps with todo_write, then work through them, marking each completed as you finish it.";
}
