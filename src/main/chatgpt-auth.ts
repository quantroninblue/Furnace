import { promises as fs } from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";
import type { KeyCipher } from "./provider-keys";
import type { ChatGPTStatus } from "../shared/types";

const issuer = "https://auth.openai.com";
const resource = "https://api.openai.com/v1";
const scopes = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const planScope = "chatgpt.tokens.use.direct";
type Tokens = { access: string; refresh?: string; identity: string; expires: number; scopes: string[] };
type Account = { id: string; clientId: string; subject: string; email?: string; welcomed: boolean; remember: boolean; tokens?: Tokens; sealed?: string };
type State = { version: 1; hostId: string; activeId: string | null; accounts: Account[] };
class AuthError extends Error { constructor(message: string, readonly code?: string) { super(message); } }
const secret = () => randomBytes(32).toString("base64url");
const validString = (value: unknown, max = 32768): value is string => typeof value === "string" && value.length > 0 && value.length <= max;
const equal = (a: string, b: string) => Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const terminalRefresh = new Set(["invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired", "refresh_token_invalidated", "refresh_token_reused"]);

// Tokens never cross IPC. A single-instance Electron main process owns this store
// and serializes refresh, selection, persistence, and revocation.
export class ChatGPTAuth {
  private state: State = { version: 1, hostId: `urn:uuid:${randomUUID()}`, activeId: null, accounts: [] };
  private queue: Promise<unknown> = Promise.resolve();
  private pending: AbortController | null = null;
  private metadata?: { jwks_uri: string; revocation_endpoint?: string };
  private jwks?: ReturnType<typeof createRemoteJWKSet>;
  constructor(private directory: string, private cipher: KeyCipher, private openBrowser: (url: string) => Promise<void>, private fetcher: typeof fetch = fetch, private loginTimeout = 300000) {}
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work); this.queue = next.catch(() => {}); return next;
  }
  async load() {
    const file = path.join(this.directory, "accounts.json");
    try {
      if ((await fs.stat(file)).size > 1048576) throw new Error("Oversized account store.");
      const saved = JSON.parse(await fs.readFile(file, "utf8")) as State;
      if (saved.version !== 1 || !/^urn:uuid:[a-f0-9-]{36}$/.test(saved.hostId) || !Array.isArray(saved.accounts) || saved.accounts.length > 100) throw new Error("Invalid account store.");
      for (const account of saved.accounts) {
        if (!validString(account.id, 100) || !validString(account.clientId, 512) || account.clientId === "dynamic_agent_client" || !validString(account.subject, 512)) throw new Error("Invalid account store.");
        delete account.tokens;
        if (account.sealed && this.cipher.available()) {
          try {
            const tokens = JSON.parse(this.cipher.decrypt(Buffer.from(account.sealed, "base64"))) as Tokens;
            if (validString(tokens.access) && validString(tokens.identity) && Number.isFinite(tokens.expires) && Array.isArray(tokens.scopes)) account.tokens = tokens;
          } catch { /* Locked credentials stay sealed until the user reconnects. */ }
        }
      }
      this.state = saved;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("ChatGPT account storage could not be read. Existing credentials were left untouched.");
      await this.save();
    }
  }
  private async save() {
    const saved: State = { ...this.state, accounts: this.state.accounts.map(account => {
      const { tokens, ...metadata } = account;
      if (tokens && account.remember) {
        if (!this.cipher.available()) throw new AuthError("Secure storage is locked. Unlock your keychain and retry.");
        metadata.sealed = this.cipher.encrypt(JSON.stringify(tokens)).toString("base64");
      } else if (!account.remember) delete metadata.sealed;
      return metadata;
    }) };
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = path.join(this.directory, "accounts.json"), temp = `${file}.${randomUUID()}.tmp`;
    try { await fs.writeFile(temp, JSON.stringify(saved), { mode: 0o600 }); await fs.rename(temp, file); }
    finally { await fs.rm(temp, { force: true }); }
  }
  status(): ChatGPTStatus {
    const active = this.state.accounts.find(account => account.id === this.state.activeId);
    return {
      accounts: this.state.accounts.map(account => ({ id: account.id, label: `${account.email || "ChatGPT account"} · ${account.id.slice(0, 6)}`, signedIn: Boolean(account.tokens), planEnabled: Boolean(account.tokens?.scopes.includes(planScope)), storage: account.tokens ? account.remember ? "encrypted" : "session" : "none" })),
      activeId: this.state.activeId, pending: Boolean(this.pending), welcome: Boolean(active?.tokens?.scopes.includes(planScope) && !active.welcomed), models: [],
    };
  }
  private account(id: string | null) {
    const account = this.state.accounts.find(item => item.id === id);
    if (!account) throw new AuthError("Choose a saved ChatGPT account.");
    return account;
  }
  private async discovery() {
    if (this.metadata) return this.metadata;
    const response = await this.fetcher(`${issuer}/.well-known/openid-configuration`, { redirect: "error", signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new AuthError("ChatGPT sign-in configuration is unavailable. Try again later.");
    const data = await response.json();
    const trusted = (value: unknown) => {
      if (!validString(value, 2048)) return false;
      const url = new URL(value); return url.origin === issuer && !url.username && !url.password && !url.hash;
    };
    if (data.issuer !== issuer || data.authorization_endpoint !== `${issuer}/api/accounts/authorize` || data.token_endpoint !== `${issuer}/api/accounts/oauth/token` || !trusted(data.jwks_uri) || (data.revocation_endpoint && !trusted(data.revocation_endpoint))) throw new AuthError("ChatGPT sign-in configuration could not be verified.");
    this.metadata = { jwks_uri: data.jwks_uri, revocation_endpoint: data.revocation_endpoint };
    return this.metadata;
  }
  private async verify(token: string, clientId: string, nonce?: string, subject?: string) {
    const metadata = await this.discovery();
    this.jwks ??= createRemoteJWKSet(new URL(metadata.jwks_uri), { timeoutDuration: 15000, [customFetch]: (url, options) => this.fetcher(url, { ...options, redirect: "error" }) });
    try {
      const { payload } = await jwtVerify(token, this.jwks, { issuer, audience: clientId, requiredClaims: ["sub", "exp", "iat"], clockTolerance: 5, algorithms: ["RS256", "ES256"] });
      if (!validString(payload.sub, 512) || (nonce !== undefined && payload.nonce !== nonce) || (subject !== undefined && payload.sub !== subject) || (payload.azp !== undefined && payload.azp !== clientId) || (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== clientId)) throw new Error("Identity mismatch");
      return { subject: payload.sub, email: typeof payload.email === "string" ? payload.email.slice(0, 254) : undefined };
    } catch { throw new AuthError("ChatGPT identity could not be verified. Sign in again."); }
  }
  private async exchange(body: URLSearchParams, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const response = await this.fetcher(`${issuer}/api/accounts/oauth/token`, { method: "POST", redirect: "error", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const code = typeof data.error === "string" ? data.error : "";
      throw new AuthError(code === "invalid_client" ? "ChatGPT rejected this app registration. Reconnect the account." : terminalRefresh.has(code) ? "ChatGPT authorization expired or was revoked. Sign in again." : `ChatGPT sign-in service failed (HTTP ${response.status}). Try again later.`, code);
    }
    return data;
  }
  private tokens(data: Record<string, unknown>, previous?: Tokens): Tokens {
    if (!validString(data.access_token) || data.token_type?.toString().toLowerCase() !== "bearer" || typeof data.expires_in !== "number" || !Number.isFinite(data.expires_in) || data.expires_in <= 0 || (!previous && !validString(data.id_token))) throw new AuthError("ChatGPT returned an incomplete token response. Sign in again.");
    if (data.scope !== undefined && typeof data.scope !== "string") throw new AuthError("ChatGPT returned invalid permissions.");
    return { access: data.access_token, identity: validString(data.id_token) ? data.id_token : previous!.identity, refresh: validString(data.refresh_token) ? data.refresh_token : previous?.refresh, expires: Date.now() + data.expires_in * 1000, scopes: typeof data.scope === "string" ? data.scope.split(/\s+/) : previous?.scopes ?? [] };
  }
  cancel() { this.pending?.abort(); }
  async signIn(accountId: string | null, remember: boolean) {
    if (this.pending) throw new Error("A ChatGPT sign-in is already in progress.");
    if (remember && !this.cipher.available()) throw new Error("Secure storage is unavailable. Use session-only sign-in.");
    const controller = new AbortController(); this.pending = controller;
    const timeout = setTimeout(() => controller.abort(), this.loginTimeout);
    let server: ReturnType<typeof createServer> | undefined;
    try {
      const selected = accountId ? this.account(accountId) : undefined;
      const state = secret(), nonce = secret(), verifier = secret();
      let redirect = "";
      const callback = new Promise<{ code: string; clientId: string }>((resolve, reject) => {
        let consumed = false;
        server = createServer((req, res) => {
          res.setHeader("Content-Type", "text/plain; charset=utf-8"); res.setHeader("Cache-Control", "no-store"); res.setHeader("Content-Security-Policy", "default-src 'none'"); res.setHeader("Referrer-Policy", "no-referrer");
          let url: URL;
          try { url = new URL(req.url || "/", redirect || "http://127.0.0.1"); }
          catch { res.writeHead(400); res.end("Invalid callback"); return; }
          if (req.method !== "GET" || url.pathname !== "/auth/callback" || req.headers.host !== new URL(redirect).host) { res.writeHead(404); res.end("Not found"); return; }
          const returned = url.searchParams.get("state") || "";
          if (consumed || !equal(state, returned) || url.searchParams.getAll("state").length !== 1) { res.writeHead(400); res.end("Sign-in could not be verified. Return to the app."); return; }
          consumed = true;
          const code = url.searchParams.get("code"), clientId = url.searchParams.get("client_id") || selected?.clientId;
          if (url.searchParams.has("error") || url.searchParams.getAll("code").length !== 1 || url.searchParams.getAll("client_id").length > 1 || !validString(code, 8192) || !validString(clientId, 512) || clientId === "dynamic_agent_client" || (selected && clientId !== selected.clientId)) {
            res.writeHead(400); res.end("Sign-in was declined or incomplete. Return to the app."); reject(new AuthError("ChatGPT sign-in was declined or incomplete. Try again when ready.")); return;
          }
          res.end("Authorization received. Return to AI GUI to finish connecting."); resolve({ code, clientId });
        });
        server.maxHeadersCount = 32; server.requestTimeout = 10000; server.headersTimeout = 10000;
        controller.signal.addEventListener("abort", () => reject(new AuthError("ChatGPT sign-in cancelled or timed out.")), { once: true });
        server.on("error", () => reject(new AuthError("Could not open the local sign-in callback. Try again.")));
      });
      // Attach rejection handling before any asynchronous work can cancel the flow.
      void callback.catch(() => {});
      await new Promise<void>((resolve, reject) => { server!.once("error", reject); server!.listen(0, "127.0.0.1", resolve); });
      redirect = `http://127.0.0.1:${(server!.address() as { port: number }).port}/auth/callback`;
      controller.signal.throwIfAborted();
      const authorization = new URL(`${issuer}/api/accounts/authorize`);
      authorization.search = new URLSearchParams({ client_id: selected?.clientId ?? "dynamic_agent_client", ext_agent_host_id: this.state.hostId, ...(selected ? { ...(selected.tokens?.identity ? { id_token_hint: selected.tokens.identity } : {}), ...(selected.email ? { login_hint: selected.email } : {}), ...(!selected.tokens?.scopes.includes(planScope) ? { prompt: "consent" } : {}) } : { agent_name_hint: "AI GUI" }), response_type: "code", redirect_uri: redirect, scope: scopes, resource, state, nonce, code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url") }).toString();
      await this.openBrowser(authorization.href);
      const result = await callback;
      server!.close();
      const data = await this.exchange(new URLSearchParams({ grant_type: "authorization_code", client_id: result.clientId, code: result.code, code_verifier: verifier, redirect_uri: redirect, resource }), controller.signal);
      const tokens = this.tokens(data);
      const identity = await this.verify(tokens.identity, result.clientId, nonce, selected?.subject);
      controller.signal.throwIfAborted();
      await this.serial(async () => {
        controller.signal.throwIfAborted();
        const existing = this.state.accounts.find(account => account.clientId === result.clientId);
        if (existing && existing.subject !== identity.subject) throw new AuthError("ChatGPT account identity changed. Existing credentials were preserved.");
        const account: Account = { id: existing?.id ?? randomUUID(), clientId: result.clientId, ...identity, welcomed: existing?.welcomed ?? false, remember, tokens };
        const previous = structuredClone(this.state);
        this.state.accounts = [...this.state.accounts.filter(item => item.id !== account.id), account]; this.state.activeId = account.id;
        try { await this.save(); } catch { this.state = previous; throw new AuthError("Could not save the ChatGPT connection. Existing accounts were preserved."); }
      });
    } catch (error) { throw error instanceof AuthError ? error : new Error(controller.signal.aborted ? "ChatGPT sign-in cancelled or timed out." : "ChatGPT sign-in could not complete. Check your connection and try again."); }
    finally { clearTimeout(timeout); server?.close(); server?.closeAllConnections(); if (this.pending === controller) this.pending = null; }
  }
  async select(id: string) {
    return this.serial(async () => { this.account(id); const previous = this.state.activeId; this.state.activeId = id; try { await this.save(); } catch { this.state.activeId = previous; throw new Error("Could not save the selected ChatGPT account."); } });
  }
  async acknowledge() {
    return this.serial(async () => { const account = this.account(this.state.activeId); account.welcomed = true; await this.save(); });
  }
  async accessToken() {
    return this.serial(async () => {
      const account = this.account(this.state.activeId);
      if (!account.tokens) throw new AuthError("Sign in to this ChatGPT account in Connections.");
      if (account.tokens.expires < Date.now() + 60000) {
        if (!account.tokens.refresh) throw new AuthError("ChatGPT sign-in expired. Sign in again in Connections.");
        try {
          const data = await this.exchange(new URLSearchParams({ grant_type: "refresh_token", client_id: account.clientId, refresh_token: account.tokens.refresh, resource }));
          const tokens = this.tokens(data, account.tokens);
          if (data.id_token) await this.verify(tokens.identity, account.clientId, undefined, account.subject);
          account.tokens = tokens; delete account.sealed;
          await this.save();
        } catch (error) {
          if (error instanceof AuthError && terminalRefresh.has(error.code ?? "")) { delete account.tokens; delete account.sealed; await this.save(); }
          throw error instanceof AuthError ? error : new AuthError("ChatGPT token renewal could not complete. Unlock secure storage, check your connection, and retry.");
        }
      }
      if (!account.tokens.scopes.includes(planScope) || !account.tokens.scopes.includes("resource.invoke")) throw new AuthError("ChatGPT plan usage is not enabled. Enable it by signing in again from Connections.");
      return account.tokens.access;
    });
  }
  async signOut(id: string): Promise<string | undefined> {
    this.cancel();
    return this.serial(async () => {
      const account = this.account(id);
      let confirmed = !account.tokens?.refresh && !account.sealed;
      if (account.tokens?.refresh) {
        try {
          const metadata = await this.discovery();
          if (metadata.revocation_endpoint) {
            for (let attempt = 0; attempt < 2; attempt++) {
              try {
                const response = await this.fetcher(metadata.revocation_endpoint, { method: "POST", redirect: "error", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: account.tokens.refresh, token_type_hint: "refresh_token", client_id: account.clientId }), signal: AbortSignal.timeout(10000) });
                if (response.status === 200) { confirmed = true; break; }
                if (response.status < 500) break;
              } catch { /* One bounded retry before clearing local credentials. */ }
              if (!attempt) await new Promise(resolve => setTimeout(resolve, 500));
            }
          }
        } catch { /* Report unconfirmed revocation after local sign-out. */ }
      }
      delete account.tokens; delete account.sealed;
      await this.save();
      return confirmed ? undefined : "Signed out locally. Remote revocation was not confirmed; disconnect this app in ChatGPT Settings → Usage.";
    });
  }
}
