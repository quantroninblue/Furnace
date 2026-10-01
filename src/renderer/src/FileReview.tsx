import { useEffect, useRef, useState } from "react";
import type { editor } from "monaco-editor";
import { DiffEditor } from "@monaco-editor/react";
import { Check, FileCode2, X } from "lucide-react";
import type { Document, FileProposal } from "../../shared/types";

export default function FileReview({ proposal, onClose, onApplied, onDiscarded }: {
  proposal: FileProposal;
  onClose(): void;
  onApplied(document: Document): void;
  onDiscarded(): void;
}) {
  const models = useRef<editor.IDiffEditorModel | null>(null);
  useEffect(() => () => {
    const current = models.current;
    // Monaco 0.57 requires the widget to release its models before disposal.
    // The React wrapper disposes its widget during the same unmount commit.
    queueMicrotask(() => { current?.original.dispose(); current?.modified.dispose(); });
  }, []);
  const [text, setText] = useState(proposal.text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const apply = async () => {
    setBusy(true);
    try { onApplied(await window.workspace.file.applyProposal(proposal.id, text)); }
    catch (error) { setError(String(error instanceof Error ? error.message : error).replace(/^Error invoking remote method '[^']+': Error: /, "")); }
    finally { setBusy(false); }
  };
  return <div className="modal-backdrop">
    <section className="file-review" role="dialog" aria-modal="true" aria-label="Review file changes">
      <header><div><span className="eyebrow">YOUR REVIEW</span><h2><FileCode2 size={19} />{proposal.path}</h2></div><button className="icon-button" aria-label="Close file review" disabled={busy} onClick={onClose}><X size={18} /></button></header>
      <p>{proposal.reason}</p>
      <div className="diff-labels"><span>{proposal.revision === null ? "New file" : "Original on disk"}</span><span>Proposed · you can edit this side</span></div>
      <div className="diff-surface"><DiffEditor
        keepCurrentOriginalModel keepCurrentModifiedModel
        theme="workspace" original={proposal.original} modified={proposal.text}
        originalModelPath={`review-original/${proposal.id}/${proposal.path}`}
        modifiedModelPath={`review-proposed/${proposal.id}/${proposal.path}`}
        onMount={editor => { models.current = editor.getModel(); editor.getModifiedEditor().onDidChangeModelContent(() => setText(editor.getModifiedEditor().getValue())); }}
        options={{ editContext: false, automaticLayout: true, fontSize: 13, minimap: { enabled: false }, scrollBeyondLastLine: false, renderSideBySide: true, originalEditable: false, readOnly: busy }}
      /></div>
      {error && <div className="review-error" role="alert">{error}</div>}
      <footer><small>Nothing is written until you apply. Changes on disk are checked again.</small><button className="text-button" disabled={busy} onClick={async () => { await window.workspace.file.discardProposal(proposal.id); onDiscarded(); }}>Discard proposal</button><button className="primary-button" disabled={busy} onClick={() => void apply()}><Check size={15} />{busy ? "Applying…" : "Apply reviewed changes"}</button></footer>
    </section>
  </div>;
}
