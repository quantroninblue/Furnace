import { test, expect, _electron as electron } from "@playwright/test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";

test("desktop: installed Claude Code signs in and streams into our chat without a project", async () => {
  test.skip(process.platform === "win32", "Fixture uses a Unix executable; Windows needs a native binary test.");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ai-gui-claude-desktop-"));
  const cli = path.join(directory, "claude");
  await fs.writeFile(cli, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2), marker = __filename + '.signed-in';
if (args[0] === '--version') { console.log('2.1.285 (Claude Code)'); process.exit(0); }
if (args[0] === 'auth' && args[1] === 'status') { const loggedIn = fs.existsSync(marker); console.log(JSON.stringify({ loggedIn, email: loggedIn ? 'fixture@example.com' : undefined, authMethod: 'claude.ai' })); process.exit(loggedIn ? 0 : 1); }
if (args[0] === 'auth' && args[1] === 'login') { console.log('Fixture sign-in: press Enter to continue.'); process.stdin.once('data', () => { fs.writeFileSync(marker, 'yes'); console.log('Login successful'); process.exit(0); }); }
else { let text = ''; process.stdin.on('data', value => text += value); process.stdin.on('end', () => {
 const emit = event => console.log(JSON.stringify(event));
 emit({type:'system',subtype:'init',tools:[]});
 emit({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'Claude Code desktop stream verified.'}}});
 emit({type:'result',subtype:'success',is_error:false,result:'Claude Code desktop stream verified.'});
}); }
`, { mode: 0o700 });
  const application = await electron.launch({ chromiumSandbox: true, args: [path.resolve("out/main/index.js")], env: { ...process.env, ELECTRON_RUN_AS_NODE: "", PATH: `${directory}${path.delimiter}${process.env.PATH}`, AI_GUI_USER_DATA: path.join(directory, "user-data") } });
  try {
    const page = await application.firstWindow();
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.getByRole("button", { name: "Connections", exact: true }).click();
    await page.getByRole("tab", { name: "Claude", exact: true }).click();
    await expect(page.locator(".connection-card")).toContainText("Installed");
    await page.getByRole("button", { name: "Sign in through Claude Code", exact: true }).click();
    await expect(page.getByLabel("Claude Code sign-in terminal")).toBeVisible();
    await expect(page.locator(".claude-login-terminal")).toContainText("Fixture sign-in: press Enter to continue.");
    await page.locator(".claude-login-terminal .xterm-helper-textarea").focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(".connection-card")).toContainText("fixture@example.com");
    await expect(page.getByRole("combobox", { name: "Active model", exact: true })).toHaveValue("claude-code/default");
    await page.screenshot({ path: "test-results/workspace-claude.png" });
    await page.getByRole("button", { name: "Close connections" }).click();
    const input = page.getByRole("textbox", { name: "Workspace input" });
    await input.fill("Hello Claude"); await input.press("Enter");
    await expect(page.locator(".messages")).toContainText("Claude Code desktop stream verified.");
    await expect(page.locator(".message.assistant").last().locator(".message-byline > span")).toHaveText("CLAUDE CODE");
    await expect(page.locator(".statusbar")).toContainText("Claude Code ready");
    expect(errors).toEqual([]);
  } finally { await application.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test("desktop: ChatGPT opens system OAuth and cancels without exposing credentials", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ai-gui-chatgpt-"));
  const application = await electron.launch({ chromiumSandbox: true, args: [path.resolve("out/main/index.js")], env: { ...process.env, ELECTRON_RUN_AS_NODE: "", AI_GUI_USER_DATA: path.join(directory, "user-data") } });
  try {
    const page = await application.firstWindow();
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await application.evaluate(({ shell }) => {
      shell.openExternal = async value => {
        const url = new URL(value);
        (globalThis as any).oauthCheck = { origin: url.origin, path: url.pathname, dynamic: url.searchParams.get("client_id") === "dynamic_agent_client", pkce: url.searchParams.get("code_challenge_method"), callback: new URL(url.searchParams.get("redirect_uri")!).hostname, scopes: url.searchParams.get("scope") };
      };
    });
    await page.getByRole("button", { name: "Connections", exact: true }).click();
    await expect(page.getByRole("tab", { name: "ChatGPT", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("textbox", { name: /API key/ })).toHaveCount(0);
    await page.getByRole("button", { name: "Continue with ChatGPT", exact: true }).click();
    await expect(page.getByRole("button", { name: "Cancel sign-in" })).toBeVisible();
    await expect.poll(() => application.evaluate(() => (globalThis as any).oauthCheck)).toEqual({ origin: "https://auth.openai.com", path: "/api/accounts/authorize", dynamic: true, pkce: "S256", callback: "127.0.0.1", scopes: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct" });
    await page.getByRole("button", { name: "Cancel sign-in" }).click();
    await expect(page.getByRole("alert")).toContainText("cancelled");
    await expect(page.getByRole("button", { name: "Continue with ChatGPT", exact: true })).toBeEnabled();
    await page.screenshot({ path: "test-results/workspace-chatgpt.png" });
    expect(errors).toEqual([]);
  } finally { await application.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test("desktop: editing, attachments, terminal and isolated browser selection", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ai-gui-smoke-"));
  const project = path.join(directory, "sample-project");
  await fs.mkdir(project);
  await fs.writeFile(
    path.join(project, "hello.ts"),
    'export const greeting = "Hello, collaborator"\n',
  );
  const source = path.join(directory, "reference.md");
  await fs.writeFile(
    source,
    "# A useful reference\nLocal copies keep research close.\n",
  );
  const server = createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(
      '<html><head><title>Research fixture</title></head><body><h1>Reference page</h1><p id="passage">A browser selection becomes shared context.</p><a href="https://example.com/reference">Useful reference</a><form>Private form content<input value="PRIVATE_INPUT"></form><p hidden>HIDDEN_SECRET</p><img src="/reference.svg" alt="Reference illustration" width="40" height="40"></body></html>',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const application = await electron.launch({
    chromiumSandbox: true,
    args: [path.resolve("out/main/index.js")],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "",
      AI_GUI_USER_DATA: path.join(directory, "user-data"),
      ...(process.env.AI_GUI_TEST_RENDERER_URL
        ? { ELECTRON_RENDERER_URL: process.env.AI_GUI_TEST_RENDERER_URL }
        : {}),
    },
  });
  try {
    const page = await application.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await expect(
      page.getByRole("heading", { name: "Your ideas." }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Minimize window", exact: true })).toBeVisible();
    expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMenuBarVisible())).toBe(false);
    await page.getByRole("button", { name: "Maximize window", exact: true }).click();
    await expect(page.getByRole("button", { name: "Restore window", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Restore window", exact: true }).click();
    await expect(page.getByRole("button", { name: "Maximize window", exact: true })).toBeVisible();
    await page.screenshot({ path: "test-results/workspace-welcome.png" });
    await application.evaluate(({ dialog }, root) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [root],
      });
    }, project);
    await page
      .getByRole("button", { name: "Open a project", exact: true })
      .click();
    await page.getByRole("button", { name: "hello.ts", exact: true }).click();
    await expect(page.locator(".monaco-editor")).toBeVisible();
    await page.locator(".monaco-editor .view-lines").click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type("// edited in the workspace");
    await page.screenshot({ path: "test-results/workspace-editor.png" });
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect
      .poll(() => fs.readFile(path.join(project, "hello.ts"), "utf8"))
      .toContain("// edited in the workspace");
    await application.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [file],
      });
    }, source);
    await page
      .getByRole("button", { name: "Attach files", exact: true })
      .click();
    await expect(
      page.locator(".context-chip").filter({ hasText: "reference.md" }),
    ).toBeVisible();
    const importedFolders = await fs.readdir(path.join(project, "attachments"));
    expect(importedFolders).toHaveLength(1);
    expect(
      await fs.readFile(
        path.join(project, "attachments", importedFolders[0], "reference.md"),
        "utf8",
      ),
    ).toContain("useful reference");
    await page
      .getByRole("button", { name: "Toggle terminal", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Start shell", exact: true })
      .click();
    await page.evaluate(() =>
      window.workspace.terminal.write(
        "printf 'terminal verified' > terminal-proof.txt\r",
      ),
    );
    await expect
      .poll(async () => {
        try {
          return await fs.readFile(
            path.join(project, "terminal-proof.txt"),
            "utf8",
          );
        } catch {
          return "";
        }
      })
      .toBe("terminal verified");
    await page
      .getByRole("button", { name: "Research", exact: true })
      .first()
      .click();
    await page
      .getByRole("textbox", { name: "Research URL" })
      .fill(`http://127.0.0.1:${port}`);
    await page.getByRole("combobox", { name: "Browser placement" }).selectOption("popup");
    const browserOpened = application.waitForEvent("window");
    await page
      .getByRole("button", { name: "Open browser", exact: true })
      .click();
    const toolbar = await browserOpened;
    await expect(toolbar.getByRole("textbox", { name: "Address or search" })).toHaveValue(`http://127.0.0.1:${port}/`);
    await expect.poll(() => application.context().pages().some(candidate => candidate.url() === `http://127.0.0.1:${port}/`)).toBe(true);
    const browser = application.context().pages().find(candidate => candidate.url() === `http://127.0.0.1:${port}/`)!;
    await browser.waitForLoadState("domcontentloaded");
    toolbar.on("pageerror", error => errors.push(error.message));
    expect(
      await browser.evaluate(() => ({
        workspace: typeof (window as any).workspace,
        controls: typeof (window as any).browserControls,
        require: typeof (window as any).require,
        process: typeof (window as any).process,
      })),
    ).toEqual({
      workspace: "undefined",
      controls: "undefined",
      require: "undefined",
      process: "undefined",
    });
    await browser.evaluate(() => {
      const range = document.createRange();
      range.selectNodeContents(document.getElementById("passage")!);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
    });
    await expect(page.locator("blockquote")).toHaveText(
      "A browser selection becomes shared context.",
    );
    await page.getByRole("button", { name: "Capture current page", exact: true }).click();
    await expect(page.locator(".source-card")).toHaveCount(1);
    await page.locator(".source-card summary").filter({ hasText: "Read captured text" }).click();
    await expect(page.locator(".source-card pre")).toContainText("A browser selection");
    await expect(page.locator(".source-card pre")).not.toContainText("Private form content");
    await expect(page.locator(".source-card pre")).not.toContainText("HIDDEN_SECRET");
    await expect(page.locator(".source-card")).toContainText("1 page links");
    await expect(page.locator(".source-card")).toContainText("1 image references");
    await page.getByRole("checkbox", { name: "Share in chat" }).check();
    await expect(page.locator(".context-chip").filter({ hasText: "Research fixture" })).toBeVisible();
    await page.screenshot({ path: "test-results/workspace-research.png" });
    const address = toolbar.getByRole("textbox", { name: "Address or search" });
    await address.fill(`127.0.0.1:${port}/next`); await address.press("Enter");
    await expect.poll(() => browser.url()).toBe(`http://127.0.0.1:${port}/next`);
    await expect(toolbar.getByRole("button", { name: "Back", exact: true })).toBeEnabled();
    await toolbar.getByRole("button", { name: "Back", exact: true }).click();
    await expect(address).toHaveValue(`http://127.0.0.1:${port}/`);
    await toolbar.getByRole("button", { name: "Forward", exact: true }).click();
    await expect(address).toHaveValue(`http://127.0.0.1:${port}/next`);
    await expect(toolbar.getByRole("button", { name: "Reload", exact: true })).toBeVisible();
    await toolbar.getByRole("button", { name: "Reload", exact: true }).click();
    await expect(browser.locator("#passage")).toBeVisible();
    await browser.evaluate(() => { const link = document.createElement("a"); link.href = "/popup"; link.target = "_blank"; document.body.append(link); link.click(); });
    await expect(address).toHaveValue(`http://127.0.0.1:${port}/popup`);
    await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(2);
    await browser.locator("#passage").click();
    await application.evaluate(({ webContents }) => { const page = webContents.getAllWebContents().find(contents => contents.getURL().endsWith("/popup"))!; page.sendInputEvent({ type: "keyDown", keyCode: "L", modifiers: ["control"] }); page.sendInputEvent({ type: "keyUp", keyCode: "L", modifiers: ["control"] }); });
    await expect(address).toBeFocused();
    await address.fill("file:///etc/passwd"); await address.press("Enter");
    await expect(toolbar.getByRole("alert")).toContainText("Only HTTP and HTTPS");
    await address.fill("http://127.0.0.1:1/"); await address.press("Enter");
    await expect(toolbar.getByRole("alert")).toContainText("Could not load this page");
    await address.fill(`http://127.0.0.1:${port}/`); await address.press("Enter");
    await expect(browser.locator("#passage")).toBeVisible();
    await expect(toolbar.getByRole("alert")).toHaveCount(0);
    await fs.writeFile("test-results/research-browser.png", Buffer.from(await application.evaluate(async ({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(window => window.getTitle() === "Research · AI GUI")!;
      return (await window.capturePage()).toPNG().toString("base64");
    }), "base64"));
    await toolbar.getByRole("button", { name: "Dock in workspace" }).click();
    await expect(page.getByLabel("Embedded research browser")).toBeVisible();
    await expect.poll(() => application.context().pages().filter(candidate => candidate.url().endsWith("browser.html")).length).toBe(2);
    const dockToolbar = application.context().pages().find(candidate => candidate !== toolbar && candidate.url().endsWith("browser.html"))!;
    await expect(dockToolbar.getByRole("textbox", { name: "Address or search" })).toHaveValue(`http://127.0.0.1:${port}/`);
    await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter(window => window.isVisible()).length)).toBe(1);
    await expect.poll(() => application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(window => window.getTitle() !== "Research · AI GUI")!;
      return window.contentView.children.filter(view => "webContents" in view && (view as any).webContents.getURL().includes("127.0.0.1")).map(view => ({ visible: view.getVisible(), width: view.getBounds().width, height: view.getBounds().height }));
    })).toEqual([{ visible: true, width: expect.any(Number), height: expect.any(Number) }]);
    await fs.writeFile("test-results/research-docked.png", Buffer.from(await application.evaluate(async ({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(window => window.getTitle() !== "Research · AI GUI")!;
      return (await window.capturePage()).toPNG().toString("base64");
    }), "base64"));
    await page.getByRole("button", { name: "Connections", exact: true }).click();
    await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.getTitle() !== "Research · AI GUI")!.contentView.children.filter(view => "webContents" in view && (view as any).webContents.getType() !== "window").every(view => !view.getVisible()))).toBe(true);
    await page.getByRole("button", { name: "Close connections" }).click();
    await dockToolbar.getByRole("button", { name: "Pop out browser" }).click();
    await expect(page.getByLabel("Embedded research browser")).toHaveCount(0);
    await expect(toolbar.getByRole("textbox", { name: "Address or search" })).toHaveValue(`http://127.0.0.1:${port}/`);


    await page.getByRole("button", { name: "Plan", exact: true }).click();
    await page
      .getByRole("textbox", { name: "Project brief" })
      .fill("# A collaborative plan\n\nBuild this together.");
    await expect(
      page.getByText("Saved locally", { exact: true }),
    ).toBeVisible();
    await expect
      .poll(async () => {
        const files = await fs.readdir(
          path.join(directory, "user-data", "sessions"),
        );
        return fs.readFile(
          path.join(
            directory,
            "user-data",
            "sessions",
            files.find((f) => f.endsWith(".json") && f != "quick-chat.json")!,
          ),
          "utf8",
        );
      })
      .toContain("Build this together.");
    await page
      .getByRole("button", { name: "Connections", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.screenshot({ path: "test-results/workspace-connections.png" });
    await page.getByRole("button", { name: "Close connections", exact: true }).click();
    await page.getByRole("button", { name: "Minimize window", exact: true }).click();
    await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.getTitle().includes("Workspace"))!.isMinimized())).toBe(true);
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.getTitle().includes("Workspace"))!.restore());
    expect(errors).toEqual([]);
  } finally {
    await application.close();
    server.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("desktop: fresh sessions, resume, slash commands, reviewed edits and cloud connections", async () => {
  test.setTimeout(90000);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ai-gui-flows-"));
  const project = path.join(directory, "project"); await fs.mkdir(project);
  await fs.writeFile(path.join(project, "hello.ts"), "export const value = 1;\n");
  const launch = () => electron.launch({ chromiumSandbox: true, args: [path.resolve("out/main/index.js")], env: { ...process.env, ELECTRON_RUN_AS_NODE: "", AI_GUI_USER_DATA: path.join(directory, "user-data") } });
  let application = await launch();
  try {
    const page = await application.firstWindow();
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    // Replace transport at the main-process boundary. No credentials or paid API calls.
    await application.evaluate(() => {
      globalThis.fetch = async (url, init) => {
        const address = String(url), headers = new Headers(init?.headers);
        if (address.includes("/api/tags")) return Response.json({ models: [{ name: "gpt-oss:20b" }] });
        if (address.includes("/v1/models")) {
          if (headers.get("authorization")?.includes("invalid")) return Response.json({ error: { message: "bad key" } }, { status: 401 });
          return Response.json({ data: address.includes("anthropic") ? [{ id: "claude-sonnet-5-5", display_name: "Claude Sonnet 5.5" } , { id: "claude-fable-5-1", display_name: "Claude Fable 5.1" }] : [{ id: "gpt-6-astra" }, { id: "gpt-5.6-terra" }], has_more: false });
        }
        const stream = (events: any[]) => new Response(events.map((event, index) => `event: ${event.type}\ndata: ${JSON.stringify({ sequence_number: index, ...event })}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
        if (address.endsWith("/v1/messages")) return stream([
          { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "claude-fable-5-1", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Anthropic desktop stream verified." } },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } },
          { type: "message_stop" },
        ]);
        if (address.endsWith("/v1/responses")) {
          const item = { id: "m", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "OpenAI desktop stream verified.", annotations: [] }] };
          const response = { id: "r", object: "response", status: "in_progress", created_at: 1, model: "gpt-6-astra", output: [] };
          return stream([
            { type: "response.created", response },
            { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
            { type: "response.content_part.added", output_index: 0, content_index: 0, item_id: "m", part: { type: "output_text", text: "", annotations: [] } },
            { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: "m", delta: "OpenAI desktop stream verified." },
            { type: "response.output_item.done", output_index: 0, item },
            { type: "response.completed", response: { ...response, status: "completed", output: [item] } },
          ]);
        }
        if (!address.includes("/api/chat")) throw new Error("Unexpected request in desktop test");
        const body = JSON.parse(String(init?.body));
        const mode = body.messages[0].content;
        const toolMessages = body.messages.filter((message: any) => message.role === "tool");
        let message: any = { content: "A fresh collaborative reply." };
        const call = (name: string, args: any) => ({ content: "", tool_calls: [{ function: { name, arguments: args } }] });
        if (mode.includes("Current mode: build")) {
          if (!toolMessages.length) message = call("project_read", { path: "hello.ts" });
          else if (toolMessages.length === 1) message = call("file_propose", { path: "hello.ts", text: "export const value = 2;\n", reason: "Update the example value." });
          else message = { content: "The change is ready for your review." };
        } else if (mode.includes("Current mode: plan") && !toolMessages.length) {
          message = call("plan_propose", { text: "# Reviewed brief\nBuild together.", reason: "A focused plan." });
        }
        return new Response(JSON.stringify({ message, done: true }) + "\n", { headers: { "Content-Type": "application/x-ndjson" } });
      };
    });
    await page.getByRole("button", { name: "Connections", exact: true }).click();
    await page.getByRole("button", { name: "Refresh discovery" }).click();
    await expect(page.getByRole("button", { name: "Refresh discovery" })).toBeEnabled();
    await page.getByRole("button", { name: "Close connections" }).click();
    const input = page.getByRole("textbox", { name: "Workspace input" });
    await input.fill("Design a hands-on workspace"); await input.press("Enter");
    await expect(page.locator(".messages")).toContainText("A fresh collaborative reply.");
    await page.getByRole("button", { name: "New chat", exact: true }).click();
    await expect(page.locator(".messages")).not.toContainText("Design a hands-on workspace");
    await page.getByRole("button", { name: "Resume chat", exact: true }).click();
    await page.getByRole("textbox", { name: "Search sessions" }).fill("hands-on");
    await page.getByRole("button", { name: /Design a hands-on workspace/ }).click();
    await expect(page.locator(".messages")).toContainText("A fresh collaborative reply.");
    await input.fill("/");
    await expect(page.getByRole("listbox", { name: "Workspace commands" })).toBeVisible();
    await page.screenshot({ path: "test-results/workspace-slash.png" });
    await input.press("Escape");
    await expect(page.getByRole("listbox", { name: "Workspace commands" })).toBeHidden();
    await input.fill("/new"); await input.press("Enter");
    await expect(page.locator(".messages")).not.toContainText("A fresh collaborative reply.");
    await input.fill("/resume last"); await input.press("Enter");
    await expect(page.locator(".messages")).toContainText("A fresh collaborative reply.");
    await application.evaluate(({ dialog }, root) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] }); }, project);
    await page.getByRole("button", { name: "Open a project", exact: true }).click();
    await expect(page.locator(".messages")).not.toContainText("Design a hands-on workspace");
    await input.fill("/run printf 'composer verified' > composer-proof.txt"); await input.press("Enter");
    await expect.poll(async () => { try { return await fs.readFile(path.join(project, "composer-proof.txt"), "utf8"); } catch { return ""; } }).toBe("composer verified");
    await expect(page.getByRole("button", { name: "Stop task", exact: true })).toHaveCount(0);
    await page.getByRole("combobox", { name: "Agent mode" }).selectOption("build");
    await input.fill("/ask Update the example"); await input.press("Enter");
    const review = page.getByRole("button", { name: "Review changes", exact: true });
    await expect(review).toBeEnabled();
    expect(await fs.readFile(path.join(project, "hello.ts"), "utf8")).toContain("= 1");
    await review.click();
    await expect(page.getByRole("dialog", { name: "Review file changes" })).toBeVisible();
    await expect(page.locator(".monaco-diff-editor")).toBeVisible();
    await page.screenshot({ path: "test-results/workspace-diff.png" });
    await page.locator(".monaco-diff-editor .modified .view-lines").click();
    await page.keyboard.press("Control+A"); await page.keyboard.type("export const value = 3;\n");
    await page.getByRole("button", { name: "Apply reviewed changes" }).click();
    await expect.poll(() => fs.readFile(path.join(project, "hello.ts"), "utf8")).toBe("export const value = 3;\n");
    await expect(page.getByRole("button", { name: "Applied", exact: true })).toBeDisabled();
    await page.getByRole("combobox", { name: "Agent mode" }).selectOption("plan");
    await input.fill("Propose a brief"); await input.press("Enter");
    await expect(page.getByRole("button", { name: "Apply to brief" })).toBeEnabled();
    await page.getByRole("button", { name: "Apply to brief" }).click();
    await expect(page.getByRole("textbox", { name: "Project brief" })).toHaveValue("# Reviewed brief\nBuild together.");
    await page.getByRole("button", { name: "Connections", exact: true }).click();
    await page.getByRole("tab", { name: "OpenAI API", exact: true }).click();
    const openai = page.locator(".remote-connection").filter({ has: page.getByRole("textbox", { name: "OpenAI API key" }) });
    await page.getByRole("textbox", { name: "OpenAI API key" }).fill("invalid-test-key");
    await openai.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(openai).toContainText("rejected the API key");
    await page.getByRole("textbox", { name: "OpenAI API key" }).fill("test-only-openai-key");
    await openai.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(openai).toContainText("Key held for this app session");
    await expect(page.getByRole("textbox", { name: "OpenAI API key" })).toHaveValue("");
    await page.getByRole("combobox", { name: "Active model", exact: true }).selectOption("openai/gpt-6-astra");
    await page.getByRole("tab", { name: "Anthropic API", exact: true }).click();
    const anthropic = page.locator(".remote-connection").filter({ has: page.getByRole("textbox", { name: "Anthropic API key" }) });
    await page.getByRole("textbox", { name: "Anthropic API key" }).fill("test-only-anthropic-key");
    await anthropic.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(anthropic).toContainText("Key held for this app session");
    await page.getByRole("combobox", { name: "Active model", exact: true }).selectOption("anthropic/claude-fable-5-1");
    await page.screenshot({ path: "test-results/workspace-cloud.png" });
    await page.getByRole("button", { name: "Close connections" }).click();
    await expect(page.locator(".remote-context-note")).toContainText("Anthropic API");
    await input.fill("Check Anthropic transport"); await input.press("Enter");
    await expect(page.locator(".message.assistant").last()).toContainText("Anthropic desktop stream verified.");
    await expect(page.locator(".message.assistant").last().locator(".message-byline > span")).toHaveText("API");
    await page.getByRole("button", { name: "Connections", exact: true }).click();
    await page.getByRole("combobox", { name: "Active model", exact: true }).selectOption("openai/gpt-6-astra");
    await page.getByRole("button", { name: "Close connections" }).click();
    await input.fill("Check OpenAI transport"); await input.press("Enter");
    await expect(page.locator(".message.assistant").last()).toContainText("OpenAI desktop stream verified.");
    await expect(page.locator(".statusbar")).toContainText("Online API ready");
    await page.getByRole("button", { name: "Resume chat", exact: true }).click();
    await page.screenshot({ path: "test-results/workspace-sessions.png" });
    await page.getByRole("button", { name: "Close sessions" }).click();
    expect(errors).toEqual([]);
    // A real process restart must not silently restore the previous conversation.
    await application.close(); application = await launch();
    const fresh = await application.firstWindow();
    await expect(fresh.locator(".messages")).not.toContainText("Design a hands-on workspace");
    await fresh.getByRole("button", { name: "Resume chat", exact: true }).click();
    await fresh.getByRole("button", { name: /Design a hands-on workspace/ }).click();
    await expect(fresh.locator(".messages")).toContainText("A fresh collaborative reply.");
  } finally { await application.close(); await fs.rm(directory, { recursive: true, force: true }); }
});
