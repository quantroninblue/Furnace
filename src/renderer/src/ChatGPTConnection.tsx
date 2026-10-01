import { useEffect, useState } from "react";
import { ExternalLink, ShieldCheck } from "lucide-react";
import type { AgentStatus, ChatGPTStatus } from "../../shared/types";

export default function ChatGPTConnection({ connection, secureStorage, disabled, onUpdated }: {
  connection?: ChatGPTStatus; secureStorage: boolean; disabled: boolean; onUpdated(status: AgentStatus): void;
}) {
  const [remember, setRemember] = useState(false);
  const [working, setWorking] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => () => { void window.workspace.chatgpt.cancel().catch(() => {}); }, []);
  const active = connection?.accounts.find(account => account.id === connection.activeId);
  const pending = signingIn || connection?.pending;
  const run = async (work: () => Promise<AgentStatus>) => {
    setWorking(true); setError(""); setNotice("");
    try { onUpdated(await work()); }
    catch (error) { setError(String((error as Error).message).replace(/^Error invoking remote method '[^']+': Error: /, "")); }
    finally { setWorking(false); setSigningIn(false); }
  };
  const signIn = (id: string | null) => { setSigningIn(true); void run(() => window.workspace.chatgpt.signIn(id, remember && secureStorage)); };
  return <div className="connection-card remote-connection chatgpt-connection">
    <div className="connection-card-title"><div className="provider-icon"><ShieldCheck size={20} /></div><div><strong>ChatGPT</strong><span>Your account · your plan</span></div><span className={`connection-state ${active?.planEnabled ? "ready" : ""}`}>{active?.signedIn ? active.planEnabled ? "Plan authorized" : "Sign-in only" : "Account sign-in"}</span></div>
    <p className="connection-detail">Use your ChatGPT plan for eligible requests. OpenAI checks your account’s models and limits. This connection never switches to paid API-key billing.</p>
    {!!connection?.accounts.length && <label className="model-select-label">ChatGPT account<select aria-label="ChatGPT account" value={connection.activeId ?? ""} disabled={disabled || working || pending} onChange={event => void run(() => window.workspace.chatgpt.select(event.target.value))}>
      <option value="" disabled>Choose an account</option>
      {connection.accounts.map(account => <option key={account.id} value={account.id}>{account.label}{account.signedIn ? "" : " · signed out"}</option>)}
    </select></label>}
    {active?.signedIn && <div className="credential-status"><span><ShieldCheck size={13} />{active.storage === "encrypted" ? "Credentials encrypted on this device" : "Signed in for this app session"}</span><button className="text-button" disabled={disabled || working || pending} onClick={() => void run(async () => { const result = await window.workspace.chatgpt.signOut(active.id); setNotice(result.warning ?? "Signed out. You can reconnect this saved account later."); return result.status; })}>Sign out</button></div>}
    {connection?.welcome && <div className="chatgpt-welcome" role="status"><strong>You’re using your ChatGPT plan</strong><p>Eligible requests use your plan allowance. Review this app’s limits and any credit use in ChatGPT settings.</p><button className="secondary-button" disabled={working || disabled} onClick={() => void run(() => window.workspace.chatgpt.acknowledge())}>Got it</button></div>}
    {active?.signedIn && !active.planEnabled && <p className="connection-detail">Plan permission is missing. Continue with ChatGPT to review and enable it.</p>}
    <div className="chatgpt-actions">
      <button className="chatgpt-sign-in" disabled={disabled || working || pending} onClick={() => signIn(active?.id ?? null)}>{pending ? "Waiting for browser…" : "Continue with ChatGPT"}</button>
      {pending ? <button className="text-button" onClick={() => void window.workspace.chatgpt.cancel().catch(() => setError("Could not cancel sign-in."))}>Cancel sign-in</button>
        : active && <button className="text-button" disabled={disabled || working} onClick={() => signIn(null)}>Add another account</button>}
    </div>
    <label className="remember-key"><input type="checkbox" checked={remember && secureStorage} disabled={!secureStorage || disabled || working || pending} onChange={event => setRemember(event.target.checked)} />{secureStorage ? "Remember securely on this device" : "Secure storage unavailable · session-only sign-in"}</label>
    <div className="chatgpt-usage"><span>Sign-in opens in your default browser.</span><button className="text-button" onClick={() => void window.workspace.chatgpt.usage().catch(() => setError("Could not open ChatGPT usage settings."))}>Manage usage <ExternalLink size={12} /></button></div>
    {(error || connection?.error) && <p className="review-error" role="alert">{error || connection?.error}</p>}
    {notice && <p className="connection-detail" role="status">{notice}</p>}
  </div>;
}
