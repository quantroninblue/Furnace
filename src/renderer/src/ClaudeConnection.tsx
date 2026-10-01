import { useEffect, useRef, useState } from "react";
import { Terminal as XTerminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { TerminalSquare, ExternalLink } from "lucide-react";
import type { AgentStatus, ClaudeStatus } from "../../shared/types";

function LoginTerminal({ consoleAccount, onExit, onError }: { consoleAccount: boolean; onExit(code: number): void; onError(error: unknown): void }) {
  const container = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onExit, onError }); callbacks.current = { onExit, onError };
  useEffect(() => {
    const terminal = new XTerminal({ fontSize: 11, fontFamily: '"DejaVu Sans Mono", monospace', cursorBlink: true, scrollback: 500, theme: { background: "#171717", foreground: "#d0cbc4", cursor: "#d0cbc4" } });
    const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(container.current!);
    const resize = () => { fit.fit(); void window.workspace.claude.resize(terminal.cols, terminal.rows).catch(() => {}); };
    const observer = new ResizeObserver(resize); observer.observe(container.current!);
    const unsubscribe = window.workspace.claude.onLoginData(data => terminal.write(data));
    const exited = window.workspace.claude.onLoginExit(code => callbacks.current.onExit(code));
    const input = terminal.onData(data => { void window.workspace.claude.write(data).catch(error => callbacks.current.onError(error)); });
    let disposed = false, started = false;
    const start = setTimeout(() => {
      started = true;
      void window.workspace.claude.login(consoleAccount).then(() => { if (!disposed) { resize(); terminal.focus(); } }).catch(error => { if (!disposed) callbacks.current.onError(error); });
    }, 0);
    return () => { disposed = true; clearTimeout(start); observer.disconnect(); unsubscribe(); exited(); input.dispose(); terminal.dispose(); if (started) void window.workspace.claude.stopLogin().catch(() => {}); };
  }, [consoleAccount]);
  return <div className="claude-login-terminal" ref={container} aria-label="Claude Code sign-in terminal" />;
}

export default function ClaudeConnection({ connection, disabled, onUpdated }: { connection?: ClaudeStatus; disabled: boolean; onUpdated(status: AgentStatus): void }) {
  const [login, setLogin] = useState<"claude" | "console" | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const report = (error: unknown) => { setLogin(null); setError(String(error instanceof Error ? error.message : error).replace(/^Error invoking remote method '[^']+': Error: /, "")); };
  const refresh = async () => { setWorking(true); setError(""); try { onUpdated(await window.workspace.agents.discover()); } catch (error) { report(error); } finally { setWorking(false); } };
  return <div className="connection-card remote-connection">
    <div className="connection-card-title"><div className="provider-icon"><TerminalSquare size={20} /></div><div><strong>Claude</strong><span>Runs your installed Claude Code{connection?.version ? ` · ${connection.version}` : ""}</span></div><span className={`connection-state ${connection?.connected ? "ready" : ""}`}>{connection?.connected ? "Signed in" : connection?.installed ? "Installed" : "Not installed"}</span></div>
    <p className="connection-detail">Use Claude in this chat through your own Claude Code installation. It handles authentication and billing; your subscription or API setup there applies. This app never copies its credentials.</p>
    {connection?.account && <div className="credential-status"><span>{connection.account}{connection.authMethod ? ` · ${connection.authMethod}` : ""}</span></div>}
    <p className="connection-detail">Discuss, Plan, Build, and Research use this workspace’s tools. Changes and commands still require your review. Model choices are Claude Code aliases; availability depends on your account.</p>
    {!connection?.installed || !connection.compatible ? <button className="secondary-button" onClick={() => void window.workspace.claude.guide().catch(report)}>Installation guide <ExternalLink size={13} /></button> : <div className="chatgpt-actions">
      <button className="secondary-button" disabled={disabled || working || login !== null} onClick={() => { setError(""); setLogin("claude"); }}>{connection.connected ? "Switch account in Claude Code" : "Sign in through Claude Code"}</button>
      <button className="text-button" disabled={disabled || working || login !== null} onClick={() => { setError(""); setLogin("console"); }}>Use Console account</button>
    </div>}
    {login && <><p className="connection-detail">Complete Claude Code’s sign-in below and in your browser. This changes the account used by your existing Claude Code installation too.</p><LoginTerminal consoleAccount={login === "console"} onError={report} onExit={code => { setLogin(null); if (code === 0) void refresh(); else setError("Claude Code sign-in ended. Retry when ready."); }} /><button className="text-button" onClick={() => setLogin(null)}>Cancel sign-in</button></>}
    <div className="chatgpt-usage"><span>Claude Code 2.1.248+ required.</span><button className="text-button" disabled={working || disabled || login !== null} onClick={() => void refresh()}>{working ? "Checking…" : "Refresh Claude connection"}</button></div>
    {(error || connection?.error) && <p className="review-error" role="alert">{error || connection?.error}</p>}
  </div>;
}
