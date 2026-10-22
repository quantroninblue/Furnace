import type { Todo } from './agent-tools';

// Plan → Build → Verify. The brief's Markdown checklist ("- [ ] step") is the task list Build
// works through. A step can carry an acceptance check at the end of its line:
//   - [ ] Add the login form (check: `npm test -- login`)        a command that must exit 0
//   - [ ] Show an error for a bad password (check: manual: try a wrong password)
// A step with a check is ticked only when the check passes (verify_step, or the user runs or
// confirms it on the Plan page); the output is kept as evidence. Steps without a check tick
// when the agent's todo list marks them completed. Items match by text (case, spacing and
// trailing punctuation ignored).
const ITEM = /^(\s*[-*+]\s+\[)([ xX])(\]\s+)(.+?)\s*$/;
const CHECK = /\s*\(check:\s*(.+)\)\s*$/i;
const normal = (text: string) =>
    text
        .toLowerCase()
        .replace(/[`*_]/g, '')
        .replace(/\s+/g, ' ')
        .replace(/[.:;!]+$/, '')
        .trim();

export type Check = { kind: 'command'; command: string } | { kind: 'manual'; text: string };
export type Evidence = {
    status: 'passed' | 'failed';
    check: string;
    kind: 'command' | 'manual';
    exitCode?: number | null;
    output?: string;
    at: number;
    /** Who ran or confirmed it: the agent (and in which reply) or the user. */
    by: 'agent' | 'you';
    replyId?: string;
};
export type PlanStep = { key: string; text: string; done: boolean; check: Check | null };

export function parseCheck(value: string): Check | null {
    const text = value.trim();
    if (!text) return null;
    const manual = /^manual\s*[:\-–—]?\s*(.*)$/i.exec(text);
    if (manual) return { kind: 'manual', text: manual[1].trim() || 'Confirm it works' };
    const command = /^`([^`]+)`$/.exec(text)?.[1] ?? text;
    return { kind: 'command', command: command.trim() };
}
export const stepKey = (text: string) => normal(text.replace(CHECK, ''));
export const checkText = (check: Check) => (check.kind === 'command' ? check.command : `manual: ${check.text}`);

export function briefSteps(brief: string): PlanStep[] {
    return brief
        .split('\n')
        .map(line => ITEM.exec(line))
        .filter((match): match is RegExpExecArray => !!match)
        .map(match => {
            const check = CHECK.exec(match[4]);
            const text = match[4].replace(CHECK, '').trim();
            return { key: normal(text), text, done: match[2] !== ' ', check: check ? parseCheck(check[1]) : null };
        });
}
/** The step whose text matches (exactly, or as the start of the step when unambiguous). */
export function findStep(brief: string, text: string) {
    const steps = briefSteps(brief),
        key = stepKey(text);
    const exact = steps.find(step => step.key === key);
    if (exact) return exact;
    const partial = key.length >= 12 ? steps.filter(step => step.key.startsWith(key) || key.startsWith(step.key)) : [];
    return partial.length === 1 ? partial[0] : null;
}
/** The brief with the step ticked (or unticked), or null when nothing changed. */
export function markStep(brief: string, key: string, done: boolean) {
    let changed = false;
    const lines = brief.split('\n').map(line => {
        const match = ITEM.exec(line);
        if (!match || stepKey(match[4]) !== key || (match[2] !== ' ') === done) return line;
        changed = true;
        return line.replace(ITEM, (_all, open, _mark, close, text) => `${open}${done ? 'x' : ' '}${close}${text}`);
    });
    return changed ? lines.join('\n') : null;
}

/** The brief with completed todos ticked, or null when nothing changed. Steps with a check need verification instead. */
export function tickBrief(brief: string, todos: Todo[]) {
    const completed = new Set(todos.filter(todo => todo.status === 'completed').map(todo => normal(todo.content)));
    if (!completed.size) return null;
    let changed = false;
    const lines = brief.split('\n').map(line => {
        const match = ITEM.exec(line);
        if (!match || match[2] !== ' ' || CHECK.test(match[4]) || !completed.has(normal(match[4]))) return line;
        changed = true;
        return line.replace(ITEM, (_all, open, _mark, close, text) => `${open}x${close}${text}`);
    });
    return changed ? lines.join('\n') : null;
}

export function buildFromPlanPrompt(brief: string) {
    const open = briefSteps(brief).filter(step => !step.done);
    if (!open.length)
        return 'Implement the shared planning brief. It has no unchecked checklist items, so first break the work into concrete steps with todo_write. Then do each step with your tools: create or edit the files (write_file, edit_file) and run a command that checks them (run_command). Mark a step completed only after its files exist and its check ran; updating the checklist does not do the work.';
    const checked = open.filter(step => step.check);
    return `Implement the shared planning brief step by step. Start by calling todo_write with these ${open.length} unchecked steps from the brief, using their exact wording:\n${open.map(step => `- ${step.text}${step.check ? ` (check: ${checkText(step.check)})` : ''}`).join('\n')}\nWork through them in order and keep exactly one in_progress.${
        checked.length
            ? ` A step is done only when it is proven: after implementing a step that has a check, call verify_step with its text. verify_step runs the check and ticks the step in the brief only if it passes; if it fails, fix the cause and verify again. For a manual check it asks the user to confirm.`
            : ''
    } For a step without a check, call verify_step with a command that proves it (a test, build or script) when one exists; otherwise mark it completed with todo_write once it is done and verified. Updating the checklist does not do the work: make every change with the file tools and commands.`;
}
