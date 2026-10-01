import { ipcRenderer } from "electron";

// This isolated preload exposes NO API to remote pages. Only selection context leaves it.
window.addEventListener("DOMContentLoaded", () => {
  let timer: ReturnType<typeof setTimeout>;
  document.addEventListener("selectionchange", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const active = document.activeElement;
      if (
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        (active instanceof HTMLElement && active.isContentEditable)
      )
        return;
      ipcRenderer.send("research:selection", {
        title: document.title,
        text: window.getSelection()?.toString().slice(0, 16000) ?? "",
      });
    }, 120);
  });
});

// Only a main-process request can trigger extraction. The page receives no bridge.
ipcRenderer.on("research:capture", (_event, id: string) => {
  const excluded = "script,style,noscript,template,input,textarea,select,option,button,form,[contenteditable],[hidden],[aria-hidden='true']";
  const visible = (element: Element) => {
    if (element.closest(excluded)) return false;
    const style = getComputedStyle(element);
    return style.visibility !== "hidden" && style.display !== "none" && element.getClientRects().length > 0;
  };
  const root = document.body;
  const parts: string[] = [];
  let size = 0, visited = 0;
  if (root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode()) && size < 8000 && visited++ < 30000) {
      const parent = node.parentElement;
      if (!parent || !visible(parent)) continue;
      const text = node.textContent?.replace(/\s+/g, " ").trim();
      if (text) { parts.push(text); size += text.length + 1; }
    }
  }
  const references = (selector: string, image: boolean, max: number) => {
    const values: { url: string; label: string }[] = [];
    const seen = new Set<string>();
    for (const element of Array.from(document.querySelectorAll(selector)).slice(0, 3000)) {
      if (!visible(element)) continue;
      const url = image ? (element as HTMLImageElement).currentSrc || (element as HTMLImageElement).src : (element as HTMLAnchorElement).href;
      if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
      seen.add(url);
      values.push({ url, label: (image ? (element as HTMLImageElement).alt : element.textContent ?? "").trim().slice(0, 200) });
      if (values.length >= max) break;
    }
    return values;
  };
  ipcRenderer.send("research:captured", {
    id, title: document.title, text: parts.join("\n").slice(0, 8000),
    truncated: size >= 8000 || visited >= 30000,
    links: references("a[href]", false, 20), images: references("img", true, 12),
  });
});
