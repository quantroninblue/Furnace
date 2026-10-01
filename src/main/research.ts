import { randomUUID } from "node:crypto";
import { ipcMain, type WebContents } from "electron";
import type { ResearchSource } from "../shared/types";

export function httpURL(value: unknown): string {
  if (typeof value !== "string" || value.length > 8192) throw new Error("Invalid research URL.");
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new Error("Only HTTP(S) URLs without credentials are allowed.");
  return url.href;
}

export function normalizeSource(data: any, url: string, id: string = randomUUID()): ResearchSource {
  if (!data || typeof data.text !== "string" || typeof data.title !== "string")
    throw new Error("Invalid page capture.");
  const references = (items: any, max: number) => (Array.isArray(items) ? items : []).slice(0, max).flatMap((item: any) => {
    try { return [{ url: httpURL(item?.url), label: typeof item.label === "string" ? item.label.slice(0, 200) : "" }]; }
    catch { return []; }
  });
  return {
    id, url: httpURL(url), title: data.title.slice(0, 300), text: data.text.slice(0, 8000),
    links: references(data.links, 20), images: references(data.images, 12),
    capturedAt: typeof data.capturedAt === "string" && Number.isFinite(Date.parse(data.capturedAt)) ? new Date(data.capturedAt).toISOString() : new Date().toISOString(), truncated: Boolean(data.truncated) || data.text.length > 8000,
  };
}

export function capturePage(contents: WebContents): Promise<ResearchSource> {
  const id: string = randomUUID();
  const url = httpURL(contents.getURL());
  const frame = contents.mainFrame;
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      ipcMain.removeListener("research:captured", received);
      contents.removeListener("destroyed", closed);
    };
    const closed = () => { cleanup(); reject(new Error("Research window closed during capture.")); };
    const received = (event: Electron.IpcMainEvent, payload: any) => {
      if (event.sender !== contents || event.senderFrame !== frame || payload?.id !== id) return;
      cleanup();
      try {
        if (contents.getURL() !== url) throw new Error("Page changed during capture. Try again.");
        resolve(normalizeSource(payload, url, id));
      } catch (error) { reject(error); }
    };
    const timer = setTimeout(() => { cleanup(); reject(new Error("Page capture timed out. Wait for the page to load and retry.")); }, 5000);
    contents.once("destroyed", closed);
    ipcMain.on("research:captured", received);
    contents.send("research:capture", id);
  });
}
