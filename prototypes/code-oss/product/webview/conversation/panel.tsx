import { useMemo } from "react";
import type { Mode } from "../protocol";
import { Icon, type IconName } from "../icons";
import { post, setHistoryOpen, useStore } from "../store";
import { tourSteps } from "../tour";
import { Composer, modeNotes } from "./composer";
import { MessageList } from "./messages";
import { HistoryPane } from "./history";

const modes: Mode[] = ["Discuss", "Plan", "Build", "Research"];
const suggestions = ["Help me shape the project brief.", "Talk through the tradeoffs with me.", "Review the file I’m working on."];

function Tool({ type, label, icon, title }: { type: "newChat" | "connections" | "home"; label: string; icon: IconName; title: string }) {
  return <button className="icon-button" aria-label={label} title={title} onClick={() => post({ type })}><Icon name={icon} /></button>;
}

export function ConversationPanel() {
  const data = useStore(value => value.data), messages = useStore(value => value.messages), note = useStore(value => value.note), historyOpen = useStore(value => value.historyOpen);
  const chat = data?.chat;
  // Model lists arrive with every update; keep one reference so message rows stay memoized.
  const modelsKey = JSON.stringify(chat?.connections.models || []);
  const models = useMemo(() => JSON.parse(modelsKey), [modelsKey]);
  if (!data || !chat) return <div className="conversation" />;
  const mode = data.state.mode;
  const steps = tourSteps(data), done = steps.filter(step => step.done).length;
  return (
    <div className="conversation" onKeyDown={event => {
      if (event.key === "Escape" && chat.busy && !event.defaultPrevented && !historyOpen) post({ type: "stop" });
      // Alt+1…4 switch modes.
      if (event.altKey && !event.ctrlKey && !event.metaKey && /^Digit[1-4]$/.test(event.code)) { event.preventDefault(); post({ type: "mode", value: modes[Number(event.code.slice(5)) - 1] }); }
    }}>
      <header className="conversation-head">
        <div className="conversation-title"><strong id="chat-title">{chat.title || "New conversation"}</strong><span id="scope">{data.scope}</span></div>
        <div className="tools">
          <Tool type="newChat" label="New Chat" icon="plus" title="New chat (/new, Ctrl+Alt+N)" />
          <button className="icon-button" aria-label="Chat History" aria-pressed={historyOpen} title="Chat history (/history, Ctrl+Alt+H)" onClick={() => setHistoryOpen(!historyOpen)}><Icon name="history" /></button>
          <Tool type="connections" label="Connections" icon="plug" title="Connections (/connections)" />
          <Tool type="home" label="Open Workspace" icon="layout" title="Workspace view: plan, research, rules and activity (Ctrl+Alt+W)" />
        </div>
      </header>
      <nav className="modes" aria-label="Workspace modes">
        {modes.map((item, index) => <button key={item} aria-pressed={item === mode} title={`${modeNotes[item]} (Alt+${index + 1})`} onClick={() => post({ type: "mode", value: item })}>{item}</button>)}
      </nav>
      <p id="mode-note" className="mode-note">{modeNotes[mode]}</p>
      {data.review.pending && (
        <div className="review-bar">
          <span><Icon name="shield" size={13} /> Reviewed edit ready</span>
          <div className="row">
            <button className="primary" disabled={data.review.busy || chat.busy} onClick={() => post({ type: "apply", generation: data.review.generation })}>Apply Reviewed Changes</button>
            <button className="ghost" disabled={data.review.busy || chat.busy} onClick={() => post({ type: "discard", generation: data.review.generation })}>Discard Proposal</button>
          </div>
        </div>
      )}
      {historyOpen ? <HistoryPane /> : (
        <MessageList messages={messages} models={models} busy={chat.busy || chat.switching}>
          {!messages.length && (
            <div id="empty-chat" className="chat-empty">
              <div className="assistant-avatar"><Icon name="sparkle" size={20} /></div>
              <h3>What are we thinking about?</h3>
              <p>Bring a half-formed idea, a tricky function, or the question you haven’t asked yet.</p>
              <div className="prompt-suggestions">
                {suggestions.map((text, index) => (
                  <button key={text} onClick={() => { if (index === 2) post({ type: "context", field: "shareEditor", enabled: true }); post({ type: "draft", value: text }); }}>{text.slice(0, -1)}<Icon name="arrow" size={12} /></button>
                ))}
              </div>
              {!data.tour.dismissed && done < steps.length && <button id="tour-hint" className="connect-hint" onClick={() => post({ type: "tourShow" })}>Getting started · {done} of {steps.length} done →</button>}
              {!models.length && <button id="connect-hint" className="connect-hint" onClick={() => post({ type: "connections" })}><Icon name="plug" size={13} /> Connect a model to start</button>}
              <p className="empty-chat-note"><Icon name="shield" size={12} /> You choose the mode. You review the actions.</p>
            </div>
          )}
        </MessageList>
      )}
      <div className="composer-area">
        <div id="status" role="status" className="status-line">{chat.compacting ? "Condensing earlier messages into a summary…" : chat.error || data.status || note}</div>
        <Composer chat={chat} research={data.research} mode={mode} draft={data.state.draft} />
      </div>
    </div>
  );
}
