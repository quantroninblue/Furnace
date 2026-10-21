import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Icon } from "./icons";

// Themed replacements for native <select> menus and title tooltips. Menus open upwards (they
// sit at the bottom of the conversation panel), close on Escape or a click elsewhere, and are
// driven by the keyboard: arrows move, Enter or Space chooses, Home/End jump.

export type MenuItem =
  | { kind: "heading"; label: string }
  | { kind?: "item"; key: string; label: string; description?: string; badges?: string[]; checked?: boolean; disabled?: boolean; tone?: "warn"; onSelect: () => void };

export function Menu({ id, label, title, trigger, items, disabled, className, align = "start", footer }: {
  id?: string; label: string; title?: string; trigger: ReactNode; items: MenuItem[]; disabled?: boolean; className?: string;
  align?: "start" | "end"; footer?: ReactNode;
}) {
  const [open, setOpen] = useState(false), [active, setActive] = useState(-1);
  const root = useRef<HTMLDivElement>(null), list = useRef<HTMLDivElement>(null), button = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const choosable = items.map((item, index) => item.kind !== "heading" && !item.disabled ? index : -1).filter(index => index >= 0);
  const close = (focus = true) => { setOpen(false); setActive(-1); if (focus) button.current?.focus(); };
  const show = (at?: "first" | "last") => {
    const checked = items.findIndex(item => item.kind !== "heading" && item.checked);
    setActive(at === "last" ? choosable.at(-1) ?? -1 : at === "first" || checked < 0 ? choosable[0] ?? -1 : checked);
    setOpen(true);
  };
  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) close(false); };
    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
  }, [open]);
  useEffect(() => { if (open && active >= 0) list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" }); }, [open, active]);
  const move = (step: number) => {
    const at = choosable.indexOf(active);
    setActive(choosable[(at + step + choosable.length) % choosable.length] ?? -1);
  };
  const choose = (index: number) => { const item = items[index]; if (!item || item.kind === "heading" || item.disabled) return; close(); item.onSelect(); };
  return (
    <div className={`menu${open ? " open" : ""}${className ? ` ${className}` : ""}`} ref={root}
      onKeyDown={event => {
        if (!open) {
          if (["ArrowUp", "ArrowDown"].includes(event.key) && document.activeElement === button.current) { event.preventDefault(); show(event.key === "ArrowUp" ? "last" : "first"); }
          return;
        }
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
        else if (event.key === "ArrowDown") { event.preventDefault(); move(1); }
        else if (event.key === "ArrowUp") { event.preventDefault(); move(-1); }
        else if (event.key === "Home") { event.preventDefault(); setActive(choosable[0] ?? -1); }
        else if (event.key === "End") { event.preventDefault(); setActive(choosable.at(-1) ?? -1); }
        else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); choose(active); }
        else if (event.key === "Tab") close(false);
      }}>
      <button id={id} ref={button} type="button" className="menu-trigger" aria-label={label} title={title} aria-haspopup="listbox" aria-expanded={open}
        aria-controls={open ? listId : undefined} disabled={disabled} onClick={() => open ? close() : show()}>
        {trigger}<Icon name="chevron" size={11} />
      </button>
      {open && (
        <div className={`menu-popover ${align}`} role="presentation">
          <div id={listId} ref={list} className="menu-list" role="listbox" aria-label={label} tabIndex={-1}
            aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}>
            {items.map((item, index) => item.kind === "heading"
              ? <div key={`h-${index}`} className="menu-heading" role="presentation">{item.label}</div>
              : <div key={item.key} id={`${listId}-${index}`} data-index={index} role="option" aria-selected={!!item.checked} aria-disabled={item.disabled || undefined}
                  className={`menu-item${index === active ? " active" : ""}${item.checked ? " checked" : ""}${item.tone ? ` ${item.tone}` : ""}`}
                  onMouseEnter={() => !item.disabled && setActive(index)} onMouseDown={event => event.preventDefault()} onClick={() => choose(index)}>
                  <span className="menu-check" aria-hidden="true">{item.checked ? <Icon name="check" size={12} /> : null}</span>
                  <span className="menu-copy">
                    <span className="menu-label">{item.label}{item.badges?.map(badge => <span key={badge} className="menu-badge">{badge}</span>)}</span>
                    {item.description && <span className="menu-description">{item.description}</span>}
                  </span>
                </div>)}
          </div>
          {footer && <div className="menu-footer">{footer}</div>}
        </div>
      )}
    </div>
  );
}

/** A styled explanation shown while its trigger is hovered or focused (keyboard users get it too). */
export function InfoTip({ tip, children, className, align = "end" }: { tip: ReactNode; children: ReactNode; className?: string; align?: "start" | "end" }) {
  const id = useId();
  return (
    <span className={`info-tip${className ? ` ${className}` : ""}`} aria-describedby={id}>
      {children}
      <span id={id} role="tooltip" className={`info-tip-panel ${align}`}>{tip}</span>
    </span>
  );
}
