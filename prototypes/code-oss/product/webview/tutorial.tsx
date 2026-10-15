import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ChatMessage, TutorialStep } from "./protocol";
import { post, useStore } from "./store";

// The tutorial bubble inside a panel. The extension sends one step at a time (product/tutorial.cjs);
// steps outside the panels are drawn by the window (patches/furnace-tutorial.patch).

/** Text with paragraphs (blank lines) and **bold**. */
export function TutorialText({ text }: { text: string }) {
  return <>{text.split(/\n{2,}/).map((paragraph, index) => (
    <p key={index}>{paragraph.split(/(\*\*[^*]+\*\*)/).map((part, at) => part.startsWith("**") && part.endsWith("**") && part.length > 4
      ? <b key={at}>{part.slice(2, -2)}</b> : <Fragment key={at}>{part}</Fragment>)}</p>
  ))}</>;
}

type Box = { left: number; top: number; width: number; height: number };
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

export function TutorialLayer() {
  const step = useStore(value => value.tutorial);
  return step ? <Bubble key={step.id} step={step} /> : null;
}

function Bubble({ step }: { step: TutorialStep }) {
  const [box, setBox] = useState<Box | null>(null);
  const bubble = useRef<HTMLDivElement>(null), next = useRef<HTMLButtonElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number; side: "above" | "below" | "center"; arrow: number }>({ left: 8, top: 8, side: "center", arrow: 0 });
  const act = (action: "next" | "back" | "end") => post({ type: "tutorialAction", id: step.id, action });
  // Press the step's button once (as the user would), then follow the target while the step lasts.
  useEffect(() => {
    let pressed = !step.press, scrolled = false;
    const tick = () => {
      if (!pressed) {
        const button = document.querySelector<HTMLElement>(step.press!);
        if (button) {
          pressed = true;
          if (button.getAttribute("aria-pressed") !== "true" && button.getAttribute("aria-selected") !== "true") button.click();
          button.classList.add("tutorial-pressed"); setTimeout(() => button.classList.remove("tutorial-pressed"), 900);
        }
      }
      const element = step.target ? document.querySelector<HTMLElement>(step.target) : null;
      const rect = element?.getBoundingClientRect();
      if (element && rect && rect.width && rect.height) {
        if (!scrolled) { scrolled = true; element.scrollIntoView({ block: "nearest", inline: "nearest" }); }
        setBox(old => old && old.left === rect.left && old.top === rect.top && old.width === rect.width && old.height === rect.height ? old : { left: rect.left, top: rect.top, width: rect.width, height: rect.height });
      } else setBox(old => old === null ? old : null);
    };
    tick();
    const timer = setInterval(tick, 200);
    return () => clearInterval(timer);
  }, [step]);
  useLayoutEffect(() => {
    const node = bubble.current;
    if (!node) return;
    const width = window.innerWidth, height = window.innerHeight, bw = node.offsetWidth, bh = node.offsetHeight, gap = 12, margin = 8;
    if (!box) { setPlace({ left: (width - bw) / 2, top: Math.max(margin, (height - bh) / 2), side: "center", arrow: 0 }); return; }
    const cx = box.left + box.width / 2, left = clamp(cx - bw / 2, margin, width - bw - margin);
    // Panels are narrow, so the bubble goes below the target when it fits, otherwise above.
    const below = box.top + box.height + gap + bh + margin <= height || box.top - gap - bh < margin;
    const top = below ? clamp(box.top + box.height + gap, margin, height - bh - margin) : box.top - gap - bh;
    setPlace({ left, top, side: below ? "below" : "above", arrow: clamp(cx - left - 6, 14, bw - 26) });
  }, [box, step]);
  useEffect(() => {
    next.current?.focus({ preventScroll: true });
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); act("end"); } };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [step.id]);
  const pad = 3;
  return (
    <div className="tutorial-layer" data-step={step.id}>
      {box ? <div className="tutorial-ring" style={{ left: box.left - pad, top: box.top - pad, width: box.width + pad * 2, height: box.height + pad * 2 }} /> : <div className="tutorial-dim" />}
      <div ref={bubble} className={`tutorial-bubble ${place.side}`} role="dialog" aria-label={step.title} data-target={box ? "found" : "none"} style={{ left: place.left, top: place.top }}
        onKeyDown={event => { if (event.key === "ArrowRight") { event.preventDefault(); act(step.last ? "end" : "next"); } if (event.key === "ArrowLeft" && step.index > 0) { event.preventDefault(); act("back"); } }}>
        {place.side !== "center" && <span className="tutorial-arrow" style={{ left: place.arrow }} />}
        <div className="tutorial-count">{step.index + 1} of {step.total}</div>
        <h3>{step.title}</h3>
        <TutorialText text={step.body} />
        <div className="tutorial-actions">
          <button className="link" onClick={() => act("end")}>End Tutorial</button>
          <span className="spacer" />
          {step.index > 0 && <button className="ghost small" onClick={() => act("back")}>Back</button>}
          <button ref={next} className="primary small" onClick={() => act(step.last ? "end" : "next")}>{step.last ? "Finish" : "Next"}</button>
        </div>
      </div>
    </div>
  );
}

// A sample exchange shown during the tutorial so it can point at a finished Build reply.
// It is display only (inert): its buttons do nothing.
const at = Date.UTC(2026, 9, 15, 10, 0, 0);
export const demoMessages: ChatMessage[] = [
  { id: "tutorial-user", role: "user", content: "Add slugify(text) in src/slug.js with unit tests, then run npm test.", createdAt: at },
  { id: "tutorial-reply", role: "assistant", model: "claude-code/sonnet", state: "complete", startedAt: at, endedAt: at + 48000,
    content: "Added `slugify` in `src/slug.js` and 7 unit tests in `test/slug.test.js`. `npm test` passes (8 tests).",
    steps: [
      { id: "s1", tool: "read_file", title: "Read package.json", status: "done" },
      { id: "s2", tool: "write_file", title: "Created src/slug.js (+14)", status: "done" },
      { id: "s3", tool: "write_file", title: "Created test/slug.test.js (+38)", status: "done", by: "ollama/qwen3:8b" },
      { id: "s4", tool: "run_command", title: "Ran npm test (exit 0)", status: "done" },
    ],
    autocompute: { usage: { input: 5321, output: 1581 }, tasks: [{ id: "t1", title: "Unit tests for slugify", kind: "test", difficulty: "easy", model: "ollama/qwen3:8b", confidence: 72,
      scores: [{ model: "ollama/qwen3:8b", confidence: 72, reason: "assessed 70, 1 of 1 accepted" }, { model: "ollama/qwen3:14b", confidence: 80, reason: "assessed 80, untested" }],
      instructions: "Write tests for slugify(text) in test/slug.test.js.", files: ["test/slug.test.js"], check: "npm test", state: "accepted", outcome: "first", attempts: 1,
      summary: "Added 7 tests.", usage: { input: 5321, output: 1581 }, exitCode: 0, verdict: "accept", review: "All 7 requested cases present and passing." }] },
    changes: { files: [
      { path: "src/slug.js", status: "added", added: 14, removed: 0, restorable: true },
      { path: "test/slug.test.js", status: "added", added: 38, removed: 0, restorable: true },
    ] } },
] as ChatMessage[];
