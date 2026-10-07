type Op = { type: " " | "-" | "+"; text: string; a: number; b: number };
// Line edit script (LCS over the changed middle); null when the change is too large to compare.
function lineOps(a: string[], b: string[]): Op[] | null {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const midA = a.slice(start, endA), midB = b.slice(start, endB);
  if (midA.length * midB.length > 4_000_000) return null;
  // LCS over the changed middle only.
  const rows = midA.length + 1, cols = midB.length + 1;
  const table = new Uint32Array(rows * cols);
  for (let i = midA.length - 1; i >= 0; i--)
    for (let j = midB.length - 1; j >= 0; j--)
      table[i * cols + j] = midA[i] === midB[j] ? table[(i + 1) * cols + j + 1] + 1 : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1]);
  const ops: Op[] = [];
  for (let k = 0; k < start; k++) ops.push({ type: " ", text: a[k], a: k, b: k });
  let i = 0, j = 0;
  while (i < midA.length || j < midB.length) {
    if (i < midA.length && j < midB.length && midA[i] === midB[j]) { ops.push({ type: " ", text: midA[i], a: start + i, b: start + j }); i++; j++; }
    else if (j < midB.length && (i === midA.length || table[i * cols + j + 1] > table[(i + 1) * cols + j])) { ops.push({ type: "+", text: midB[j], a: start + i, b: start + j }); j++; }
    else { ops.push({ type: "-", text: midA[i], a: start + i, b: start + j }); i++; }
  }
  for (let k = endA; k < a.length; k++) ops.push({ type: " ", text: a[k], a: k, b: k - endA + endB });
  return ops;
}

// Minimal line-based unified diff for approval previews. It is a display aid, not a
// patch format: very large inputs fall back to a size summary.
export function unifiedDiff(file: string, before: string, after: string, context = 3): string {
  if (before === after) return `${file}: no changes`;
  const a = before ? before.replace(/\n$/, "").split("\n") : [];
  const b = after ? after.replace(/\n$/, "").split("\n") : [];
  const ops = lineOps(a, b);
  if (!ops) return `--- ${file}\n+++ ${file}\n@@ large change: ${a.length} → ${b.length} lines @@`;
  const lines = [`--- ${before ? file : "/dev/null"}`, `+++ ${after ? file : "/dev/null"}`];
  // Group changes separated by at most 2×context unchanged lines into one hunk.
  const changed = ops.flatMap((op, index) => (op.type === " " ? [] : [index]));
  const groups: [number, number][] = [];
  for (const index of changed) {
    const last = groups.at(-1);
    if (last && index - last[1] <= context * 2 + 1) last[1] = index; else groups.push([index, index]);
  }
  for (const [firstChange, lastChange] of groups) {
    const hunk = ops.slice(Math.max(0, firstChange - context), Math.min(ops.length, lastChange + context + 1));
    const first = hunk[0];
    const countA = hunk.filter(op => op.type !== "+").length, countB = hunk.filter(op => op.type !== "-").length;
    lines.push(`@@ -${first.a + (countA ? 1 : 0)},${countA} +${first.b + (countB ? 1 : 0)},${countB} @@`);
    for (const op of hunk) lines.push(op.type + op.text);
  }
  return lines.join("\n");
}

// A final newline ends the last line; it does not start another one.
const lines = (text: string) => (text ? text.replace(/\n$/, "").split("\n") : []);
export function diffStats(before: string, after: string) {
  const a = new Map<string, number>();
  for (const line of lines(before)) a.set(line, (a.get(line) ?? 0) + 1);
  let added = 0;
  for (const line of lines(after)) { const n = a.get(line) ?? 0; if (n) a.set(line, n - 1); else added++; }
  let removed = 0; for (const n of a.values()) removed += n;
  return { added, removed };
}

export type Hunk = { beforeStart: number; before: string[]; afterStart: number; after: string[] };
/** Changed line ranges without context (0-based line numbers), for per-hunk keep/revert in editors. */
export function lineHunks(before: string, after: string): Hunk[] | null {
  const a = before.split("\n"), b = after.split("\n");
  const ops = lineOps(a, b); if (!ops) return null;
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  for (const op of ops) {
    if (op.type === " ") { current = null; continue; }
    if (!current) { current = { beforeStart: op.a, before: [], afterStart: op.b, after: [] }; hunks.push(current); }
    if (op.type === "-") current.before.push(op.text); else current.after.push(op.text);
  }
  return hunks;
}
