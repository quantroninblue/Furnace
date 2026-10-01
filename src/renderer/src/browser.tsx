import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ArrowLeft, ArrowRight, RotateCw, X, Minus, Square, Copy, Globe2, Search, PanelLeft, ExternalLink } from "lucide-react";
import type { BrowserAPI, BrowserState } from "../../shared/browser";
import "./browser.css";

declare global { interface Window { browserControls: BrowserAPI } }
function Browser() {
  const [state, setState] = useState<BrowserState>({ url: "", title: "Research browser", back: false, forward: false, loading: false, error: "", maximized: false, docked: false, opened: false });
  const [address, setAddress] = useState("");
  const [error, setError] = useState("");
  const focused = useRef(false), field = useRef<HTMLInputElement>(null);
  const report = (error: unknown) => setError(String(error instanceof Error ? error.message : error).replace(/^Error invoking remote method '[^']+': Error: /, ""));
  const act = (value: Parameters<BrowserAPI["action"]>[0]) => { setError(""); void window.browserControls.action(value).catch(report); };
  useEffect(() => {
    const update = (next: BrowserState) => { setState(next); if (!focused.current) setAddress(next.url); };
    const unsubscribe = window.browserControls.onState(update);
    const focus = window.browserControls.onFocusAddress(() => { field.current?.focus(); field.current?.select(); });
    void window.browserControls.state().then(update).catch(report);
    return () => { unsubscribe(); focus(); };
  }, []);
  return <main className="browser-shell">
    <header className="browser-titlebar"><Globe2 size={13} /><span>{state.title}</span><div className="browser-window-controls"><button aria-label={state.docked ? "Pop out browser" : "Dock in workspace"} title={state.docked ? "Pop out browser" : "Dock in workspace"} onClick={() => act(state.docked ? "popout" : "dock")}>{state.docked ? <ExternalLink size={14} /> : <PanelLeft size={14} />}</button>{!state.docked && <><button aria-label="Minimize browser" onClick={() => act("minimize")}><Minus size={14} /></button><button aria-label={state.maximized ? "Restore browser" : "Maximize browser"} onClick={() => act("maximize")}>{state.maximized ? <Copy size={12} /> : <Square size={12} />}</button></>}<button aria-label="Close browser" onClick={() => act("close")}><X size={15} /></button></div></header>
    <nav className="browser-navigation" aria-label="Browser navigation">
      <button aria-label="Back" title="Back · Alt+Left" disabled={!state.back} onClick={() => act("back")}><ArrowLeft size={17} /></button>
      <button aria-label="Forward" title="Forward · Alt+Right" disabled={!state.forward} onClick={() => act("forward")}><ArrowRight size={17} /></button>
      <button aria-label={state.loading ? "Stop loading" : "Reload"} onClick={() => act(state.loading ? "stop" : "reload")}>{state.loading ? <X size={17} /> : <RotateCw size={16} />}</button>
      <form onSubmit={event => { event.preventDefault(); setError(""); focused.current = false; field.current?.blur(); void window.browserControls.navigate(address).catch(report); }}><Search size={14} /><input ref={field} aria-label="Address or search" value={address} placeholder="Search or enter a website" spellCheck={false} autoComplete="off" onFocus={() => { focused.current = true; }} onBlur={() => { focused.current = false; }} onChange={event => setAddress(event.target.value)} onKeyDown={event => { if (event.key === "Escape") { setAddress(state.url); field.current?.blur(); } }} /><button type="submit" aria-label="Go">Go</button></form>
    </nav>
    <div className={`browser-status ${error || state.error ? "has-error" : ""}`} role={error || state.error ? "alert" : "status"}>{error || state.error || (state.loading ? "Loading…" : "Highlight text to share context with your workspace. Capture pages from the Research panel.")}</div>
    {state.loading && <div className="browser-progress" />}
  </main>;
}
createRoot(document.getElementById("root")!).render(<Browser />);
