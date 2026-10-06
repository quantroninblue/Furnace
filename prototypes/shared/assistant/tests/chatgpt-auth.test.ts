import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { ChatGPTAuth } from "../main/chatgpt-auth";

const origin = "https://auth.openai.com";
const permission = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
async function fixture(t: TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt-auth-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const { privateKey, publicKey } = await generateKeyPair("ES256");
  const key = { ...await exportJWK(publicKey), kid: "test", alg: "ES256" };
  let authorization: URL;
  let grant = permission, ttl = 3600, subject = "account-one", clientId = "oaiapp_fixture";
  let claims: Record<string, unknown> = {}, failRefresh = "", revocation = 200;
  const forms: URLSearchParams[] = [];
  const requests: string[] = [];
  let onOpen: ((url: URL) => Promise<void>) | undefined;
  const fetcher: typeof fetch = async (url, init) => {
    const address = String(url); requests.push(address);
    assert.equal(init?.redirect, "error");
    if (address.endsWith("openid-configuration")) return Response.json({ issuer: origin, authorization_endpoint: `${origin}/api/accounts/authorize`, token_endpoint: `${origin}/api/accounts/oauth/token`, jwks_uri: `${origin}/.well-known/jwks.json`, revocation_endpoint: `${origin}/oauth/revoke` });
    if (address.endsWith("jwks.json")) return Response.json({ keys: [key] });
    const form = new URLSearchParams(String(init?.body)); forms.push(form);
    if (address.endsWith("/revoke")) return new Response(null, { status: revocation });
    assert.equal(address, `${origin}/api/accounts/oauth/token`);
    assert.equal(form.get("client_id"), clientId);
    assert.equal(form.get("resource"), "https://api.openai.com/v1");
    const refresh = form.get("grant_type") === "refresh_token";
    if (refresh && failRefresh) return Response.json({ error: failRefresh }, { status: failRefresh === "temporary" ? 503 : 400 });
    if (!refresh) {
      assert.equal(form.get("redirect_uri"), authorization.searchParams.get("redirect_uri"));
      assert.equal(createHash("sha256").update(form.get("code_verifier")!).digest("base64url"), authorization.searchParams.get("code_challenge"));
    }
    const identity = await new SignJWT({ sub: subject, nonce: authorization.searchParams.get("nonce"), email: "person@example.com", ...claims }).setProtectedHeader({ alg: "ES256", kid: "test" }).setIssuer(String(claims.iss ?? origin)).setAudience(String(claims.aud ?? clientId)).setIssuedAt().setExpirationTime(claims.exp as number ?? Math.floor(Date.now() / 1000) + 3600).sign(privateKey);
    return Response.json({ access_token: refresh ? "renewed-access-secret" : "initial-access-secret", refresh_token: refresh ? "rotated-refresh-secret" : "initial-refresh-secret", token_type: "Bearer", expires_in: refresh ? 3600 : ttl, id_token: identity, scope: grant });
  };
  // Test-only reversible cipher; production uses Electron safeStorage.
  const cipher = { available: () => true, encrypt: (value: string) => Buffer.from(Buffer.from(value).map(byte => byte ^ 0xa5)), decrypt: (value: Buffer) => Buffer.from(value.map(byte => byte ^ 0xa5)).toString() };
  const open = async (value: string) => {
    authorization = new URL(value);
    assert.equal(authorization.origin, origin);
    if (onOpen) return onOpen(authorization);
    await callback(authorization);
  };
  async function callback(url: URL, overrides: Record<string, string> = {}) {
    const target = new URL(url.searchParams.get("redirect_uri")!);
    target.search = new URLSearchParams({ state: url.searchParams.get("state")!, code: "test-code", client_id: clientId, ...overrides }).toString();
    return fetch(target);
  }
  const auth = new ChatGPTAuth(directory, cipher, open, fetcher, 3000);
  await auth.load(); t.after(() => auth.cancel());
  return { auth, directory, cipher, fetcher, open, forms, requests, callback, get url() { return authorization; }, settings: (settings: { grant?: string; ttl?: number; subject?: string; clientId?: string; claims?: Record<string, unknown>; failRefresh?: string; revocation?: number; onOpen?: typeof onOpen }) => {
    grant = settings.grant ?? grant; ttl = settings.ttl ?? ttl; subject = settings.subject ?? subject; clientId = settings.clientId ?? clientId; claims = settings.claims ?? claims; failRefresh = settings.failRefresh ?? failRefresh; revocation = settings.revocation ?? revocation; onOpen = settings.onOpen;
  } };
}

test("ChatGPT browser OAuth uses PKCE, verifies identity, encrypts credentials, and retains registration after sign-out", async t => {
  const f = await fixture(t);
  await f.auth.signIn(null, true);
  const firstURL = f.url, status = f.auth.status(), id = status.activeId!;
  assert.equal(firstURL.searchParams.get("client_id"), "dynamic_agent_client");
  assert.equal(firstURL.searchParams.get("agent_name_hint"), "AI GUI");
  assert.equal(firstURL.searchParams.get("scope"), permission);
  assert.equal(status.accounts[0].planEnabled, true);
  assert.equal(status.welcome, true);
  assert.equal(await f.auth.accessToken(), "initial-access-secret");
  const file = path.join(f.directory, "accounts.json"), saved = await fs.readFile(file, "utf8");
  assert.ok(!saved.includes("initial-access-secret") && !saved.includes("initial-refresh-secret"));
  assert.ok(!JSON.stringify(status).includes("secret") && !JSON.stringify(status).includes("id_token"));
  if (process.platform !== "win32") assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  await f.auth.acknowledge();
  const reopened = new ChatGPTAuth(f.directory, f.cipher, f.open, f.fetcher);
  await reopened.load(); assert.equal(await reopened.accessToken(), "initial-access-secret"); assert.equal(reopened.status().welcome, false);
  await f.auth.signIn(id, true);
  assert.equal(f.url.searchParams.get("client_id"), "oaiapp_fixture");
  assert.equal(f.url.searchParams.get("agent_name_hint"), null);
  assert.equal(f.url.searchParams.get("ext_agent_host_id"), firstURL.searchParams.get("ext_agent_host_id"));
  assert.notEqual(f.url.searchParams.get("state"), firstURL.searchParams.get("state"));
  assert.ok(f.url.searchParams.has("id_token_hint"));
  await f.auth.signOut(id);
  assert.equal(f.auth.status().accounts[0].signedIn, false);
  assert.equal(f.forms.at(-1)?.get("token_type_hint"), "refresh_token");
  assert.ok(!(await fs.readFile(file, "utf8")).includes("sealed"));
  await f.auth.signIn(id, false);
  assert.equal(f.url.searchParams.get("id_token_hint"), null);
  assert.equal(f.url.searchParams.get("client_id"), "oaiapp_fixture");
  assert.ok(!(await fs.readFile(file, "utf8")).includes("sealed"));
});

test("ChatGPT rejects unbound callbacks, cancellation and wrong reauthorization clients without exchanging a code", async t => {
  const f = await fixture(t);
  f.settings({ onOpen: async url => {
    const response = await f.callback(url, { state: "wrong-state" }); assert.equal(response.status, 400);
    assert.equal(f.forms.length, 0); f.auth.cancel();
  } });
  await assert.rejects(f.auth.signIn(null, false), /cancelled/);
  assert.equal(f.auth.status().pending, false); assert.equal(f.forms.length, 0);
  f.settings({}); await f.auth.signIn(null, false);
  const count = f.forms.length;
  f.settings({ onOpen: async url => { await f.callback(url, { client_id: "different-client" }); } });
  await assert.rejects(f.auth.signIn(f.auth.status().activeId, false), /incomplete/);
  assert.equal(f.forms.length, count); assert.equal(await f.auth.accessToken(), "initial-access-secret");
});

test("ChatGPT rejects invalid ID-token nonce, issuer, audience, expiry, and returning identity", async t => {
  const f = await fixture(t);
  for (const claims of [{ nonce: "wrong" }, { iss: "https://untrusted.example" }, { aud: "wrong-client" }, { exp: 1 }]) {
    f.settings({ claims }); await assert.rejects(f.auth.signIn(null, false), /identity could not be verified/);
    assert.equal(f.auth.status().accounts.length, 0);
  }
  f.settings({ claims: {} }); await f.auth.signIn(null, false);
  f.settings({ subject: "different-account" });
  await assert.rejects(f.auth.signIn(f.auth.status().activeId, false), /identity could not be verified/);
  assert.equal(f.auth.status().accounts.length, 1);
});

test("ChatGPT serializes token rotation, preserves temporary failures, and clears revoked credentials", async t => {
  const f = await fixture(t); f.settings({ ttl: 1 }); await f.auth.signIn(null, true);
  f.settings({ failRefresh: "temporary" }); await assert.rejects(f.auth.accessToken(), /service failed/);
  assert.equal(f.auth.status().accounts[0].signedIn, true);
  f.settings({ failRefresh: "" });
  assert.deepEqual(await Promise.all([f.auth.accessToken(), f.auth.accessToken(), f.auth.accessToken()]), Array(3).fill("renewed-access-secret"));
  assert.equal(f.forms.filter(form => form.get("grant_type") === "refresh_token").length, 2);
  await f.auth.signIn(f.auth.status().activeId, true);
  f.settings({ failRefresh: "invalid_grant" }); await assert.rejects(f.auth.accessToken(), /revoked/);
  assert.equal(f.auth.status().accounts[0].signedIn, false);
  assert.ok(!(await fs.readFile(path.join(f.directory, "accounts.json"), "utf8")).includes("sealed"));
});

test("ChatGPT keeps accounts separate, disables inference without consent, and warns on unconfirmed revocation", async t => {
  const f = await fixture(t); await f.auth.signIn(null, false);
  const first = f.auth.status().activeId!;
  f.settings({ clientId: "oaiapp_second", subject: "account-two", grant: "openid profile email" });
  await f.auth.signIn(null, false);
  assert.equal(f.auth.status().accounts.length, 2);
  assert.equal(f.auth.status().accounts[1].planEnabled, false);
  await assert.rejects(f.auth.accessToken(), /not enabled/);
  await f.auth.select(first); assert.equal(await f.auth.accessToken(), "initial-access-secret");
  f.settings({ revocation: 503 }); assert.match((await f.auth.signOut(first))!, /revocation was not confirmed/);
  assert.equal(f.auth.status().accounts[1].signedIn, true);
  const reopened = new ChatGPTAuth(f.directory, f.cipher, f.open, f.fetcher); await reopened.load();
  assert.ok(reopened.status().accounts.every(account => !account.signedIn));
});

test("ChatGPT rejects tampered ID signatures and never saves their credentials", async t => {
  const f = await fixture(t);
  const fetcher: typeof fetch = async (url, init) => {
    const response = await f.fetcher(url, init);
    if (!String(url).endsWith("/oauth/token")) return response;
    const data = await response.json();
    const parts = data.id_token.split(".");
    parts[2] = (parts[2][0] === "A" ? "B" : "A") + parts[2].slice(1);
    return Response.json({ ...data, id_token: parts.join(".") });
  };
  const auth = new ChatGPTAuth(f.directory, f.cipher, f.open, fetcher);
  await auth.load();
  await assert.rejects(auth.signIn(null, true), /identity could not be verified/);
  assert.equal(auth.status().accounts.length, 0);
  assert.ok(!(await fs.readFile(path.join(f.directory, "accounts.json"), "utf8")).includes("sealed"));
});
