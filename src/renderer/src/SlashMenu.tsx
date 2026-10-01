import { useEffect, useRef } from "react";
import {
  ArrowUpRight,
  BookOpen,
  Code2,
  Command,
  FolderOpen,
  Globe2,
  Layers3,
  MessageSquare,
  Paperclip,
  Sparkles,
  Square,
  TerminalSquare,
} from "lucide-react";
import type { workspaceCommands } from "./workspace-commands";

const icons = {
  ask: Sparkles,
  discuss: MessageSquare,
  run: TerminalSquare,
  plan: BookOpen,
  build: Code2,
  research: Globe2,
  open: FolderOpen,
  attach: Paperclip,
  agents: Layers3,
  terminal: TerminalSquare,
  stop: Square,
  help: Command,
};

export default function SlashMenu({
  commands,
  active,
  onSelect,
  onHighlight,
}: {
  commands: typeof workspaceCommands;
  active: number;
  onSelect: (name: string) => void;
  onHighlight: (index: number) => void;
}) {
  const selected = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    selected.current?.scrollIntoView({ block: "nearest" });
  }, [active]);
  return (
    <div className="slash-palette">
      <div className="slash-heading">
        <span>
          <Command size={13} />
          Workspace
        </span>
        <small>{commands.length} commands</small>
      </div>
      <div
        className="slash-options"
        id="workspace-command-list"
        role="listbox"
        aria-label="Workspace commands"
      >
        {commands.map((command, index) => {
          const Icon = icons[command.name as keyof typeof icons] ?? Command;
          return (
            <button
              key={command.name}
              ref={index === active ? selected : undefined}
              id={`workspace-command-${command.name}`}
              role="option"
              aria-selected={index === active}
              className={index === active ? "highlighted" : ""}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => onHighlight(index)}
              onClick={() => onSelect(command.name)}
            >
              <span className="slash-icon">
                <Icon size={16} strokeWidth={1.5} />
              </span>
              <span className="slash-command-copy">
                <span className="slash-command-name">
                  <strong>/{command.name}</strong>
                  {command.argument && <small>{command.argument}</small>}
                </span>
                <span className="slash-description">{command.description}</span>
              </span>
              <ArrowUpRight className="slash-command-arrow" size={14} />
            </button>
          );
        })}
      </div>
      <div className="slash-footer">
        <span>
          <kbd>↑</kbd>
          <kbd>↓</kbd> navigate
        </span>
        <span>
          <kbd>↵</kbd> select
        </span>
        <span>
          <kbd>esc</kbd> close
        </span>
      </div>
    </div>
  );
}
