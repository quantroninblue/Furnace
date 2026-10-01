import { BrowserWindow, WebContentsView, ipcMain, session, type IpcMainInvokeEvent } from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { BrowserBounds, BrowserState } from "../shared/browser";
import { browserURL } from "./browser-url";

export class ResearchBrowser {
  private window: BrowserWindow | null = null;
  private view: WebContentsView | null = null;
  private dockToolbar: WebContentsView | null = null;
  private docked = false;
  private bounds: BrowserBounds | null = null;
  private error = "";
  private requestedURL = "";
  private opening: Promise<void> | null = null;
  private readonly toolbarURL = process.env.ELECTRON_RENDERER_URL
    ? new URL("browser.html", process.env.ELECTRON_RENDERER_URL).href
    : pathToFileURL(path.join(__dirname, "../renderer/browser.html")).href;
  constructor(private owner: BrowserWindow, private onNavigation: () => void) {
    const handle = (name: string, callback: (...args: any[]) => unknown) => ipcMain.handle(name, (event: IpcMainInvokeEvent, ...args) => {
      if (!this.window || (event.sender !== this.window.webContents && event.sender !== this.dockToolbar?.webContents) || event.senderFrame !== event.sender.mainFrame || event.senderFrame.url !== this.toolbarURL) throw new Error("Untrusted browser controls.");
      return callback(...args);
    });
    handle("browser:state", () => this.state());
    handle("browser:navigate", (value: unknown) => this.navigate(browserURL(value)));
    handle("browser:action", (action: unknown) => {
      const page = this.contents;
      if (!page || !this.window) return;
      switch (action) {
        case "dock": this.owner.webContents.send("research:browser-dock"); return this.present(true);
        case "popout": return this.present(false);
        case "back": if (page.navigationHistory.canGoBack()) page.navigationHistory.goBack(); break;
        case "forward": if (page.navigationHistory.canGoForward()) page.navigationHistory.goForward(); break;
        case "reload": this.error = ""; page.reload(); this.publish(); break;
        case "stop": page.stop(); break;
        case "minimize": this.window.minimize(); break;
        case "maximize": this.window.isMaximized() ? this.window.unmaximize() : this.window.maximize(); break;
        case "close": this.window.close(); break;
        default: throw new Error("Unknown browser action.");
      }
    });
  }
  get contents() { return this.view && !this.view.webContents.isDestroyed() ? this.view.webContents : null; }
  close() { this.window?.close(); }
  state(): BrowserState {
    const page = this.contents;
    return { url: this.requestedURL, title: page?.getTitle() || "Research browser", loading: page?.isLoading() ?? false, back: page?.navigationHistory.canGoBack() ?? false, forward: page?.navigationHistory.canGoForward() ?? false, error: this.error, maximized: this.window?.isMaximized() ?? false, docked: this.docked, opened: !!this.window };
  }
  private publish() {
    const state = this.state();
    if (this.window && !this.window.isDestroyed()) this.window.webContents.send("browser:state", state);
    if (this.dockToolbar && !this.dockToolbar.webContents.isDestroyed()) this.dockToolbar.webContents.send("browser:state", state);
    if (!this.owner.isDestroyed()) this.owner.webContents.send("research:browser-state", state);
  }
  setBounds(value: unknown) {
    if (value === null) this.bounds = null;
    else {
      const rect = value as BrowserBounds;
      if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(n => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 20000)) throw new Error("Invalid browser bounds.");
      const zoom = this.owner.webContents.getZoomFactor();
      const [width, height] = this.owner.getContentSize();
      const x = Math.min(width, Math.round(rect.x * zoom)), y = Math.min(height, Math.round(rect.y * zoom));
      this.bounds = { x, y, width: Math.min(width - x, Math.round(rect.width * zoom)), height: Math.min(height - y, Math.round(rect.height * zoom)) };
    }
    this.layoutDock();
  }
  private layoutDock() {
    if (!this.docked || !this.view || !this.dockToolbar) return;
    const visible = !!this.bounds && this.bounds.height > 140 && this.bounds.width > 200;
    this.view.setVisible(visible); this.dockToolbar.setVisible(visible);
    if (!visible || !this.bounds) return;
    const { x, y, width, height } = this.bounds;
    this.dockToolbar.setBounds({ x, y, width, height: 112 });
    this.view.setBounds({ x, y: y + 112, width, height: height - 112 });
  }
  private async present(docked: boolean) {
    if (!this.window || !this.view) return;
    if (docked && !this.dockToolbar) {
      const toolbar = new WebContentsView({ webPreferences: { preload: path.join(__dirname, "../preload/browser.js"), sandbox: true, contextIsolation: true, nodeIntegration: false } });
      this.dockToolbar = toolbar;
      toolbar.webContents.on("before-input-event", this.keyboard);
      toolbar.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      toolbar.webContents.on("will-navigate", event => event.preventDefault());
      await toolbar.webContents.loadURL(this.toolbarURL);
      if (!this.window || !this.view) return;
    }
    this.docked = docked;
    if (docked) {
      this.window.contentView.removeChildView(this.view);
      this.owner.contentView.addChildView(this.view);
      this.owner.contentView.addChildView(this.dockToolbar!);
      this.window.hide(); this.layoutDock(); this.owner.show(); this.owner.focus();
    } else {
      this.owner.contentView.removeChildView(this.view);
      if (this.dockToolbar) this.owner.contentView.removeChildView(this.dockToolbar);
      this.window.contentView.addChildView(this.view); this.view.setVisible(true);
      const [width, height] = this.window.getContentSize();
      this.view.setBounds({ x: 0, y: 112, width, height: Math.max(0, height - 112) });
      this.window.show(); this.window.focus();
    }
    this.publish();
  }
  private keyboard = (event: Electron.Event, input: Electron.Input) => {
      const page = this.contents, window = this.window;
      if (!page || !window) return;
      if (input.type !== "keyDown") return;
      if ((input.control || input.meta) && input.key.toLowerCase() === "l") { event.preventDefault(); const controls = this.docked ? this.dockToolbar?.webContents : window.webContents; controls?.focus(); controls?.send("browser:focus-address"); }
      if (input.key === "F5" || ((input.control || input.meta) && input.key.toLowerCase() === "r")) { event.preventDefault(); page.reload(); }
      if (input.alt && input.key === "ArrowLeft" && page.navigationHistory.canGoBack()) { event.preventDefault(); page.navigationHistory.goBack(); }
      if (input.alt && input.key === "ArrowRight" && page.navigationHistory.canGoForward()) { event.preventDefault(); page.navigationHistory.goForward(); }
    };

  private async create() {
    const researchSession = session.fromPartition("research");
    researchSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    researchSession.setPermissionCheckHandler(() => false);
    researchSession.removeAllListeners("will-download");
    researchSession.on("will-download", event => { event.preventDefault(); this.error = "Downloads are not enabled in this research browser."; this.publish(); });
    researchSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: details.resourceType === "mainFrame" ? !/^https?:/i.test(details.url) : !/^(https?:|wss?:|data:|blob:)/i.test(details.url) }));
    const window = new BrowserWindow({ title: "Research · AI GUI", width: 1120, height: 820, minWidth: 640, minHeight: 400, frame: false, backgroundColor: "#202020", show: false, webPreferences: { preload: path.join(__dirname, "../preload/browser.js"), nodeIntegration: false, contextIsolation: true, sandbox: true } });
    this.window = window;
    const view = new WebContentsView({ webPreferences: { preload: path.join(__dirname, "../preload/research.js"), partition: "research", nodeIntegration: false, contextIsolation: true, sandbox: true, webviewTag: false } });
    this.view = view;
    view.setBackgroundColor("#ffffff");
    window.contentView.addChildView(view);
    const resize = () => { if (this.docked) return; const [width, height] = window.getContentSize(); view.setBounds({ x: 0, y: 112, width, height: Math.max(0, height - 112) }); };
    resize(); window.on("resize", resize); window.on("maximize", () => this.publish()); window.on("unmaximize", () => this.publish());
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", event => event.preventDefault());
    const page = view.webContents;
    const allowed = (value: string) => { try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password; } catch { return false; } };
    page.setWindowOpenHandler(({ url }) => { if (allowed(url)) void this.navigate(url); else { this.error = "That link uses an unsupported protocol."; this.publish(); } return { action: "deny" }; });
    const guardNavigation = (event: Electron.Event, url: string) => { if (!allowed(url)) { event.preventDefault(); this.error = "That link uses an unsupported protocol."; this.publish(); } };
    page.on("will-navigate", guardNavigation);
    page.on("will-redirect", guardNavigation);
    page.on("did-start-navigation", (_event, url, inPlace, isMainFrame) => { if (isMainFrame) { this.requestedURL = url; this.error = ""; if (!inPlace) this.onNavigation(); this.publish(); } });
    page.on("did-start-loading", () => this.publish());
    page.on("did-stop-loading", () => this.publish());
    page.on("did-navigate", () => this.publish());
    page.on("did-navigate-in-page", () => this.publish());
    page.on("page-title-updated", () => this.publish());
    page.on("did-fail-load", (_event, code, description, _url, isMainFrame) => { if (isMainFrame && code !== -3) { this.error = `Could not load this page (${description}). Check the address or connection, then reload.`; this.publish(); } });
    page.on("render-process-gone", () => { this.error = "The page stopped responding. Reload to reopen it."; this.publish(); });
    page.on("before-input-event", this.keyboard); window.webContents.on("before-input-event", this.keyboard);
    window.on("closed", () => {
      if (!this.owner.isDestroyed()) { this.owner.contentView.removeChildView(view); if (this.dockToolbar) this.owner.contentView.removeChildView(this.dockToolbar); }
      if (!page.isDestroyed()) page.close({ waitForBeforeUnload: false });
      this.dockToolbar?.webContents.close({ waitForBeforeUnload: false }); this.dockToolbar = null;
      if (this.window === window) { this.window = null; this.view = null; this.docked = false; this.requestedURL = ""; this.error = ""; this.onNavigation(); this.publish(); }
    });
    await window.loadURL(this.toolbarURL);
    this.publish();
  }
  async open(value: unknown, placement: unknown = "popup") {
    const url = browserURL(value);
    if (placement !== "embedded" && placement !== "popup") throw new Error("Invalid browser placement.");
    if (!this.window) { this.opening ??= this.create().finally(() => { this.opening = null; }); }
    if (this.opening) await this.opening;
    await this.present(placement === "embedded");
    await this.navigate(url);
  }
  private async navigate(url: string) {
    const page = this.contents;
    if (!page) return;
    this.requestedURL = url; this.error = ""; this.publish();
    try { await page.loadURL(url); }
    catch { /* did-fail-load reports a useful error in the browser chrome. */ }
    this.publish();
  }
}
