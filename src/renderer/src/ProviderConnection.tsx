import { useState } from "react";
import { KeyRound, ShieldCheck } from "lucide-react";
import type { AgentStatus, ProviderConnection as Connection, RemoteProvider } from "../../shared/types";

export default function ProviderConnection({ provider, connection, secureStorage, disabled, onUpdated }: {
  provider: RemoteProvider; connection?: Connection; secureStorage: boolean; disabled: boolean; onUpdated(status: AgentStatus): void;
}) {
  const [key, setKey] = useState("");
  const [remember, setRemember] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const name = provider === "openai" ? "OpenAI" : "Anthropic";
  const connect = async (event: React.FormEvent) => {
    event.preventDefault(); setWorking(true); setError("");
    const value = key; setKey("");
    try { onUpdated(await window.workspace.agents.connect(provider, value, remember && secureStorage)); }
    catch (error) { setError(String((error as Error).message).replace(/^Error invoking remote method '[^']+': Error: /, "")); }
    finally { setWorking(false); }
  };
  return <div className="connection-card remote-connection">
    <div className="connection-card-title"><div className="provider-icon"><KeyRound size={19} /></div><div><strong>{name}</strong><span>{provider === "openai" ? "Astra · Sol · Terra · Luna" : "Sonnet · Opus · Fable"}</span></div><span className={`connection-state ${connection?.connected && !connection.error ? "ready" : ""}`}>{connection?.connected ? connection.error ? "Needs attention" : "Key verified" : "API key"}</span></div>
    <p className="connection-detail">Direct to {provider === "openai" ? "api.openai.com" : "api.anthropic.com"}. Uses your API account’s access and billing. Verifying a key checks the model list; chat access is checked when you send.</p>
    {connection?.connected && <div className="credential-status"><span><ShieldCheck size={13} />{connection.storage === "encrypted" ? "Key encrypted on this device" : "Key held for this app session"}</span><button className="text-button" disabled={disabled || working} onClick={async () => {
      setWorking(true); setError("");
      try { onUpdated(await window.workspace.agents.disconnect(provider)); }
      catch { setError("Could not disconnect. Try again."); }
      finally { setWorking(false); }
    }}>Disconnect</button></div>}
    <form onSubmit={event => void connect(event)}>
      <div className="key-input-row"><input aria-label={`${name} API key`} type="password" autoComplete="off" spellCheck={false} placeholder={connection?.connected ? "Replace API key…" : "Paste your API key…"} value={key} onChange={event => setKey(event.target.value)} disabled={disabled || working} /><button className="secondary-button" disabled={!key.trim() || disabled || working}>{working ? "Checking…" : "Connect"}</button></div>
      <label className="remember-key"><input type="checkbox" checked={remember && secureStorage} disabled={!secureStorage || disabled || working} onChange={event => setRemember(event.target.checked)} />{secureStorage ? "Remember securely on this device" : "Secure storage unavailable · session-only key"}</label>
    </form>
    {(error || connection?.error) && <p className="review-error" role="alert">{error || connection?.error}</p>}
  </div>;
}
