import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

// Saved per-project permission rules. They live in the app's own storage, never in the
// project, so a cloned repository cannot grant itself permissions.
//   allow command  "npm test"   runs `npm test …` without asking (never with ; && | > etc.)
//   allow edit     "*"          project edits without asking in Ask first mode
//   allow network  "docs.rs"    web_fetch to that host (or "*.example.com")
//   deny  path     "infra/"     the agent may not read or change matching project paths
//   deny  command  "git push"   refused in every mode, including Full access
export type RuleKind = "command" | "edit" | "network" | "path";
export type Rule = { id: string; effect: "allow" | "deny"; kind: RuleKind; pattern: string; createdAt: string };
export type RuleRequest = { kind: "command"; command: string } | { kind: "edit" } | { kind: "network"; host: string };
type Store = { version: 1; projects: Record<string, Rule[]> };

const MAX_RULES = 200;
// Anything that chains, redirects or substitutes commands is never covered by an allow rule.
const CONTROL = /[;&|`<>\n\r]|\$\(/;

export function commandTokens(command: string) {
  const tokens: string[] = [];
  for (const match of command.trim().matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g)) tokens.push(match[1] ?? match[2] ?? match[3]);
  return tokens;
}
const startsWith = (tokens: string[], prefix: string[]) => prefix.length > 0 && prefix.every((token, index) => tokens[index] === token);

/** The rule offered when the user chooses "always allow" for a command: program plus subcommand. */
export function suggestCommandRule(command: string) {
  const tokens = commandTokens(command);
  if (!tokens.length || CONTROL.test(command)) return null;
  const words = tokens.length > 1 && !tokens[1].startsWith("-") && /^[\w:.@/-]+$/.test(tokens[1]) ? tokens.slice(0, 2) : tokens.slice(0, 1);
  // "npx foo" or "npm run build" deserve one more word.
  if (["npx", "run", "exec"].includes(words.at(-1)!) && tokens[words.length] && !tokens[words.length].startsWith("-")) words.push(tokens[words.length]);
  return words.join(" ");
}

export function globPattern(pattern: string) {
  let value = pattern.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  value = value.replace(/\/+$/, "");
  let source = "";
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (char === "*" && value[index + 1] === "*") { source += value[index + 2] === "/" ? "(?:.*/)?" : ".*"; index += value[index + 2] === "/" ? 2 : 1; }
    else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  // A bare folder name also covers everything inside it.
  return new RegExp(`^${source}(?:/.*)?$`);
}

export function validRule(rule: Partial<Rule>): rule is Omit<Rule, "id" | "createdAt"> {
  if (!rule || !["allow", "deny"].includes(rule.effect!) || typeof rule.pattern !== "string") return false;
  const pattern = rule.pattern.trim();
  if (!pattern || pattern.length > 500 || /[\0\n\r]/.test(pattern)) return false;
  if (rule.effect === "allow") return (rule.kind === "command" && !CONTROL.test(pattern)) || (rule.kind === "edit" && pattern === "*") || (rule.kind === "network" && /^(\*\.)?[a-z0-9.-]+(:\d+)?$/i.test(pattern));
  return (rule.kind === "path" && !path.isAbsolute(pattern) && !pattern.split(/[\\/]/).includes("..")) || (rule.kind === "command" && commandTokens(pattern).length > 0);
}

export class PermissionRules {
  private store: Store = { version: 1, projects: {} };
  private loaded?: Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private file: string) {}
  load() {
    return this.loaded ??= (async () => {
      try {
        const saved = JSON.parse(await fs.readFile(this.file, "utf8")) as Store;
        if (saved?.version === 1 && saved.projects && typeof saved.projects === "object")
          for (const [root, rules] of Object.entries(saved.projects)) if (Array.isArray(rules)) this.store.projects[root] = rules.filter(validRule).slice(0, MAX_RULES) as Rule[];
      } catch { /* Missing or damaged: start without rules rather than guessing. */ }
    })();
  }
  private key(root: string | null) { return root ?? "(no project)"; }
  list(root: string | null): Rule[] { return [...(this.store.projects[this.key(root)] ?? [])]; }
  async add(root: string | null, rule: Omit<Rule, "id" | "createdAt">) {
    await this.load();
    const candidate = { effect: rule.effect, kind: rule.kind, pattern: rule.pattern.trim() };
    if (!validRule(candidate)) throw new Error("That rule is not valid. Allow rules cannot include ; && | > or other shell operators.");
    const rules = this.store.projects[this.key(root)] ??= [];
    const existing = rules.find(item => item.effect === candidate.effect && item.kind === candidate.kind && item.pattern === candidate.pattern);
    if (existing) return existing;
    if (rules.length >= MAX_RULES) throw new Error(`Keep at most ${MAX_RULES} rules per project.`);
    const saved: Rule = { id: randomUUID(), ...candidate, createdAt: new Date().toISOString() };
    rules.push(saved); await this.save(); return saved;
  }
  async remove(root: string | null, id: string) {
    await this.load();
    const rules = this.store.projects[this.key(root)] ?? [];
    const index = rules.findIndex(rule => rule.id === id);
    if (index < 0) throw new Error("That rule no longer exists.");
    rules.splice(index, 1); await this.save();
  }
  /** The allow rule that covers this request, if any. */
  allows(root: string | null, request: RuleRequest): Rule | null {
    for (const rule of this.list(root)) {
      if (rule.effect !== "allow" || rule.kind !== request.kind) continue;
      if (request.kind === "edit") return rule;
      if (request.kind === "network") {
        const host = request.host.toLowerCase(), pattern = rule.pattern.toLowerCase();
        if (host === pattern || (pattern.startsWith("*.") && (host.endsWith(pattern.slice(1)) || host === pattern.slice(2)))) return rule;
      }
      if (request.kind === "command" && !CONTROL.test(request.command) && startsWith(commandTokens(request.command), commandTokens(rule.pattern))) return rule;
    }
    return null;
  }
  /** The deny rule that blocks a project-relative path, if any. */
  deniesPath(root: string | null, relative: string): Rule | null {
    const value = relative.replace(/\\/g, "/");
    return this.list(root).find(rule => rule.effect === "deny" && rule.kind === "path" && globPattern(rule.pattern).test(value)) ?? null;
  }
  /** The deny rule matching any simple command inside a (possibly chained) command line. */
  deniesCommand(root: string | null, command: string): Rule | null {
    const parts = command.split(/;|&&|\|\||\||\n|\$\(|`|\(|\)/).map(commandTokens).filter(tokens => tokens.length);
    // Skip leading assignments and wrappers so "FOO=1 sudo git push" still matches "git push".
    const core = (tokens: string[]) => { let index = 0; while (index < tokens.length && (/^\w+=/.test(tokens[index]) || ["sudo", "env", "command", "exec", "nohup", "time"].includes(tokens[index]))) index++; return tokens.slice(index); };
    return this.list(root).find(rule => rule.effect === "deny" && rule.kind === "command" && parts.some(tokens => startsWith(core(tokens), commandTokens(rule.pattern)) || startsWith(tokens, commandTokens(rule.pattern)))) ?? null;
  }
  private save() {
    const next = this.queue.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const temp = `${this.file}.${randomUUID()}.tmp`;
      try { await fs.writeFile(temp, JSON.stringify(this.store), { mode: 0o600 }); await fs.rename(temp, this.file); }
      finally { await fs.rm(temp, { force: true }); }
    });
    this.queue = next.catch(() => {});
    return next;
  }
}
