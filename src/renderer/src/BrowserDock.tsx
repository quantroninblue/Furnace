import { useEffect, useRef } from "react";

// Native web content is positioned over this reserved area. Hide it whenever
// the app opens a modal, switches views, or unmounts the slot.
export function BrowserDock({ hidden }: { hidden: boolean }) {
  const slot = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = slot.current;
    if (!element) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = element.getBoundingClientRect();
        const visible = !hidden && rect.x >= 0 && rect.y >= 0;
        void window.workspace.research.bounds(visible ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null).catch(() => {});
      });
    };
    const observer = new ResizeObserver(update); observer.observe(element);
    window.addEventListener("resize", update); window.addEventListener("scroll", update, true);
    update();
    return () => { cancelAnimationFrame(frame); observer.disconnect(); window.removeEventListener("resize", update); window.removeEventListener("scroll", update, true); void window.workspace.research.bounds(null).catch(() => {}); };
  }, [hidden]);
  return <div className="browser-dock" ref={slot} aria-label="Embedded research browser" />;
}
