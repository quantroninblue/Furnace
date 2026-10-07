import { memo } from "react";
import type { ChatMessage } from "../protocol";
import { Icon } from "../icons";
import { post } from "../store";

const letters = { added: "A", modified: "M", deleted: "D" } as const;

// Everything the agent changed in one reply, with diffs and per-file or whole-turn revert.
export const Changes = memo(function Changes({ message, busy }: { message: ChatMessage; busy: boolean }) {
  const files = message.changes?.files || [];
  if (!files.length) return null;
  const open = files.filter(file => !file.reverted);
  const added = open.reduce((sum, file) => sum + file.added, 0), removed = open.reduce((sum, file) => sum + file.removed, 0);
  const revertible = open.filter(file => file.restorable);
  const ran = message.steps?.some(step => step.tool === "run_command");
  return (
    <section className="changes" aria-label="Files changed in this reply">
      <div className="changes-head">
        <strong>{open.length ? `Changed ${open.length} file${open.length === 1 ? "" : "s"}` : "All changes reverted"}</strong>
        {open.length > 0 && <span className="changes-stats"><b className="plus">+{added}</b> <b className="minus">−{removed}</b></span>}
        <span className="fill" />
        {open.length > 0 && <button className="ghost small" disabled={busy} onClick={() => post({ type: "openChange", messageId: message.id })}><Icon name="diff" size={12} />Review</button>}
        {revertible.length > 0 && <button className="ghost small" disabled={busy} title="Put every file back as it was before this reply" onClick={() => post({ type: "revertChanges", messageId: message.id })}><Icon name="undo" size={12} />Revert All</button>}
        <button className="ghost small" title="See these and every other change in the folder in Source Control (AI Agent and Git)" onClick={() => post({ type: "openScm" })}><Icon name="git" size={12} />Source Control</button>
      </div>
      <ul className="changes-list">
        {files.map(file => (
          <li key={file.path} className={file.reverted ? "reverted" : undefined}>
            <span className={`change-kind ${file.status}`} title={file.status}>{letters[file.status]}</span>
            <button className="change-path" disabled={busy || file.reverted || !file.restorable} title={`Show the diff for ${file.path}`} onClick={() => post({ type: "openChange", messageId: message.id, path: file.path })}>{file.path}</button>
            {file.restorable && !file.reverted && <span className="change-stats"><b className="plus">+{file.added}</b> <b className="minus">−{file.removed}</b></span>}
            {file.reverted ? <small>Reverted</small> : !file.restorable ? <small title="Binary, too large or too many files to keep a copy">Can’t restore</small>
              : <button className="change-revert" aria-label={`Revert ${file.path}`} title={`Revert ${file.path}`} disabled={busy} onClick={() => post({ type: "revertChanges", messageId: message.id, path: file.path })}><Icon name="undo" size={12} /></button>}
          </li>
        ))}
      </ul>
      {message.changes?.error && <p className="error">{message.changes.error}</p>}
      {ran && <small className="changes-note">Commands this reply ran may have changed other files; only the agent’s file edits are tracked here. Source Control shows every change in the folder.</small>}
    </section>
  );
});
