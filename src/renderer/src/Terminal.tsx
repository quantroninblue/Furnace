import { useEffect, useRef } from "react";
import { Terminal as XTerminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

export default function Terminal({
  project,
  onError,
}: {
  project: string;
  onError: (error: unknown) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const terminal = new XTerminal({
      fontFamily: '"DejaVu Sans Mono", monospace',
      fontSize: 12,
      cursorBlink: true,
      allowTransparency: true,
      theme: {
        background: "#00000000",
        foreground: "#c3c3c3",
        cursor: "#b3b3b3",
        selectionBackground: "#6e6e6e55",
      },
      scrollback: 3000,
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container.current!);
    const resize = () => {
      fit.fit();
      void window.workspace.terminal
        .resize(terminal.cols, terminal.rows)
        .catch(onError);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container.current!);
    const unsubscribe = window.workspace.terminal.onData((data) =>
      terminal.write(data),
    );
    const input = terminal.onData((data) => {
      void window.workspace.terminal.write(data).catch(onError);
    });
    terminal.writeln(
      "\x1b[38;5;246mYour shell, your commands. Start shell to begin.\x1b[0m",
    );
    return () => {
      observer.disconnect();
      unsubscribe();
      input.dispose();
      terminal.dispose();
    };
  }, [project, onError]);
  return <div className="terminal-surface" ref={container} />;
}
