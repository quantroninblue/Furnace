// Parser and applier for the Codex "apply_patch" format:
//   *** Begin Patch / *** Add File: p / *** Update File: p [*** Move to: q] / *** Delete File: p / *** End Patch
// Update hunks start with "@@" (optionally followed by an anchor line) and use
// " ", "-" and "+" line prefixes. Matching tolerates trailing/leading whitespace.
export type PatchOperation =
  | { type: "add"; path: string; text: string }
  | { type: "delete"; path: string }
  | { type: "update"; path: string; moveTo?: string; chunks: { anchor?: string; old: string[]; next: string[]; endOfFile: boolean }[] };

export function parsePatch(patch: string): PatchOperation[] {
  const lines = patch.replace(/\r\n/g, "\n").trim().split("\n");
  if (lines[0]?.trim() !== "*** Begin Patch" || lines.at(-1)?.trim() !== "*** End Patch")
    throw new Error("A patch must start with '*** Begin Patch' and end with '*** End Patch'.");
  const operations: PatchOperation[] = [];
  let index = 1;
  const header = (line: string, prefix: string) => (line.startsWith(prefix) ? line.slice(prefix.length).trim() : undefined);
  while (index < lines.length - 1) {
    const line = lines[index];
    let file: string | undefined;
    if ((file = header(line, "*** Add File: ")) !== undefined) {
      const text: string[] = [];
      for (index++; index < lines.length - 1 && !lines[index].startsWith("*** "); index++) {
        if (!lines[index].startsWith("+")) throw new Error(`Added file lines must start with '+' (${file}).`);
        text.push(lines[index].slice(1));
      }
      operations.push({ type: "add", path: file, text: text.join("\n") + (text.length ? "\n" : "") });
    } else if ((file = header(line, "*** Delete File: ")) !== undefined) {
      operations.push({ type: "delete", path: file }); index++;
    } else if ((file = header(line, "*** Update File: ")) !== undefined) {
      const operation: Extract<PatchOperation, { type: "update" }> = { type: "update", path: file, chunks: [] };
      index++;
      const move = header(lines[index] ?? "", "*** Move to: ");
      if (move !== undefined) { operation.moveTo = move; index++; }
      let chunk: (typeof operation.chunks)[number] | undefined;
      for (; index < lines.length - 1 && (!lines[index].startsWith("*** ") || lines[index] === "*** End of File"); index++) {
        const current = lines[index];
        if (current === "*** End of File") { if (chunk) chunk.endOfFile = true; continue; }
        if (current.startsWith("@@")) { chunk = { anchor: current.slice(2).trim() || undefined, old: [], next: [], endOfFile: false }; operation.chunks.push(chunk); continue; }
        if (!chunk) { chunk = { old: [], next: [], endOfFile: false }; operation.chunks.push(chunk); }
        const marker = current[0] ?? " ", text = current.slice(1);
        if (marker === " " || current === "") { chunk.old.push(text); chunk.next.push(text); }
        else if (marker === "-") chunk.old.push(text);
        else if (marker === "+") chunk.next.push(text);
        else throw new Error(`Unexpected patch line in ${file}: ${current.slice(0, 80)}`);
      }
      if (!operation.chunks.length && !operation.moveTo) throw new Error(`Update for ${file} has no changes.`);
      operations.push(operation);
    } else if (!line.trim()) index++;
    else throw new Error(`Unexpected patch line: ${line.slice(0, 80)}`);
  }
  if (!operations.length) throw new Error("The patch contains no file operations.");
  return operations;
}

function find(lines: string[], target: string[], from: number, endOfFile: boolean) {
  const normalisers = [(s: string) => s, (s: string) => s.trimEnd(), (s: string) => s.trim()];
  for (const normal of normalisers) {
    const wanted = target.map(normal);
    const start = endOfFile ? Math.max(from, lines.length - target.length) : from;
    for (let i = start; i + target.length <= lines.length; i++)
      if (wanted.every((value, k) => normal(lines[i + k]) === value)) return i;
  }
  return -1;
}

export function applyUpdate(original: string, chunks: Extract<PatchOperation, { type: "update" }>["chunks"], file: string) {
  const trailing = original.endsWith("\n");
  const lines = original ? original.replace(/\n$/, "").split("\n") : [];
  let cursor = 0;
  for (const chunk of chunks) {
    if (chunk.anchor) {
      const at = find(lines, [chunk.anchor], cursor, false);
      if (at < 0) throw new Error(`Could not find '${chunk.anchor.slice(0, 80)}' in ${file}. Read the file and retry.`);
      cursor = at + 1;
    }
    if (!chunk.old.length) { const at = chunk.endOfFile || !chunk.anchor ? lines.length : cursor; lines.splice(at, 0, ...chunk.next); cursor = at + chunk.next.length; continue; }
    const at = find(lines, chunk.old, cursor, chunk.endOfFile);
    if (at < 0) throw new Error(`Patch context did not match ${file} near: ${chunk.old.find(Boolean)?.slice(0, 80) ?? "(blank lines)"}. Read the file and retry.`);
    lines.splice(at, chunk.old.length, ...chunk.next);
    cursor = at + chunk.next.length;
  }
  return lines.join("\n") + (trailing || !original ? "\n" : "");
}
