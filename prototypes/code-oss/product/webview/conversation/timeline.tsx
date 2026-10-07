import type { Timeline } from "../protocol";
import { Icon } from "../icons";
import { post, setTimelineOpen, useStore } from "../store";

const when = (at: number | null) => at ? new Date(at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
// Jump closes the timeline and scrolls the conversation to that message.
function jump(id: string) {
  setTimelineOpen(false);
  requestAnimationFrame(() => {
    const node = document.getElementById(`message-${id}`);
    node?.scrollIntoView({ block: "start" }); node?.classList.add("flash"); setTimeout(() => node?.classList.remove("flash"), 1200);
  });
}

// Each request in the conversation, what the agent changed and verified, where it branched,
// and actions to jump to it, compare the files with now, or rewind to it.
export function TimelinePane({ busy }: { busy: boolean }) {
  const timeline: Timeline | null = useStore(value => value.timeline);
  return (
    <section id="timeline" className="timeline-pane" aria-label="Conversation timeline">
      <div className="history-head">
        <strong>Timeline</strong>
        <button className="icon-button" aria-label="Close Timeline" onClick={() => setTimelineOpen(false)}><Icon name="close" size={13} /></button>
      </div>
      {timeline?.parent && <button className="ghost small timeline-parent" onClick={() => post({ type: "historyOpen", id: timeline.parent!.id })}><Icon name="branch" size={12} />Branched from “{timeline.parent.title}”</button>}
      {!timeline ? <p className="empty-note">Loading…</p> : !timeline.points.length ? <p className="empty-note">No messages yet.</p> : (
        <ol className="timeline-list">
          {timeline.points.map((point, index) => (
            <li key={point.id} className={`timeline-point${point.checkpoint ? " checkpoint" : ""}`}>
              <span className="timeline-marker" aria-hidden="true">{point.checkpoint ? <Icon name="file" size={11} /> : index + 1}</span>
              <div className="timeline-body">
                <button className="timeline-text" title="Jump to this message" onClick={() => jump(point.id)}>{point.text}</button>
                <small className="muted">{[when(point.at), point.reply?.files.length ? `${point.reply.files.length} file${point.reply.files.length === 1 ? "" : "s"} changed` : "",
                  point.reply?.steps ? `${point.reply.steps} step${point.reply.steps === 1 ? "" : "s"}` : "", point.reply && point.reply.state !== "complete" ? point.reply.state : ""].filter(Boolean).join(" · ")}
                  {point.reply?.verified && <span className="badge passed"><Icon name="check" size={10} />verified</span>}</small>
                {point.reply?.files.length ? <small className="timeline-files" title={point.reply.files.join("\n")}>{point.reply.files.slice(0, 4).join(", ")}{point.reply.files.length > 4 ? ` +${point.reply.files.length - 4}` : ""}</small> : null}
                <div className="row">
                  {point.comparable && <button className="ghost small" disabled={busy} title="Show every file the agent changed from here on, against the file now" onClick={() => post({ type: "compareFrom", messageId: point.id })}><Icon name="diff" size={11} />Compare with Now</button>}
                  <button className="ghost small" disabled={busy} title="Rewind: remove this message and everything after it, restoring files the agent changed since" onClick={() => post({ type: "rewind", messageId: point.id })}><Icon name="undo" size={11} />Restore</button>
                </div>
                {point.branches.map(branch => <button key={branch.id} className="link timeline-branch" onClick={() => post({ type: "historyOpen", id: branch.id })}><Icon name="branch" size={11} />{branch.title} · {branch.messageCount} messages</button>)}
              </div>
            </li>
          ))}
        </ol>
      )}
      {timeline?.otherBranches.length ? <div className="timeline-others"><div className="context-label">OTHER BRANCHES</div>
        {timeline.otherBranches.map(branch => <button key={branch.id} className="link timeline-branch" onClick={() => post({ type: "historyOpen", id: branch.id })}><Icon name="branch" size={11} />{branch.title}</button>)}</div> : null}
    </section>
  );
}
