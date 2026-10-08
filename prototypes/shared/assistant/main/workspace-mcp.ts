import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { AgentTools } from "./agent-tools";

// Claude Code reserves "workspace" and silently drops a server with that name.
export const mcpServerName = "furnace";

// One authenticated loopback endpoint per turn, sharing the same scoped tool
// executor as the direct model adapters. It never exposes shell/file writes.
export async function workspaceMcp(tools: AgentTools, signal: AbortSignal, activity: (name: string) => void) {
  const token = randomBytes(32).toString("base64url");
  const authorization = Buffer.from(`Bearer ${token}`);
  const names = new Set(tools.definitions.map(tool => tool.function.name));
  let count = 0, closed = false, queue: Promise<unknown> = Promise.resolve();
  const active = new Set<Server>();
  let host = "";
  const server = createServer({ maxHeaderSize: 8192 }, (req, res) => {
    void (async () => {
      const supplied = Buffer.from(req.headers.authorization ?? "");
      if (closed || signal.aborted) { res.writeHead(410).end(); return; }
      if (req.headers.host !== host || req.headers.origin || supplied.length !== authorization.length || !timingSafeEqual(supplied, authorization)) { res.writeHead(403).end(); return; }
      if (req.url !== "/mcp" || req.method !== "POST") { res.writeHead(405).end(); return; }
      if (!req.headers["content-type"]?.startsWith("application/json")) { res.writeHead(415).end(); return; }
      let body = "";
      req.setEncoding("utf8");
      for await (const chunk of req) { body += chunk.toString(); if (Buffer.byteLength(body) > 65536) { res.writeHead(413).end(); return; } }
      let parsed: unknown;
      try { parsed = JSON.parse(body); } catch { res.writeHead(400).end(); return; }
      const mcp = new Server({ name: "Furnace workspace", version: "0.1.0" }, { capabilities: { tools: {} } });
      active.add(mcp);
      mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.definitions.map(({ function: tool }) => ({ name: tool.name, description: tool.description, inputSchema: tool.parameters })) }));
      mcp.setRequestHandler(CallToolRequestSchema, request => {
        const run = async () => {
          if (closed || signal.aborted) return { isError: true, content: [{ type: "text" as const, text: "This turn has ended." }] };
          if (!names.has(request.params.name) || ++count > 250) return { isError: true, content: [{ type: "text" as const, text: "Tool unavailable in this mode or turn limit reached." }] };
          activity(request.params.name);
          try { return { content: [{ type: "text" as const, text: (await tools.execute(request.params.name, request.params.arguments ?? {})).slice(0, 64000) }] }; }
          catch (error) { return { isError: true, content: [{ type: "text" as const, text: String((error as Error)?.message ?? error).slice(0, 2000) || "The workspace rejected this tool request." }] }; }
        };
        const result = queue.then(run, run); queue = result.catch(() => {}); return result;
      });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => { active.delete(mcp); void mcp.close(); });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, parsed);
    })().catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); });
  });
  server.requestTimeout = 10000; server.headersTimeout = 10000; server.maxConnections = 16;
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  host = `127.0.0.1:${(server.address() as { port: number }).port}`;
  const close = () => { closed = true; server.close(); server.closeAllConnections(); for (const mcp of active) void mcp.close(); active.clear(); signal.removeEventListener("abort", close); return queue.then(() => {}, () => {}); };
  signal.addEventListener("abort", close, { once: true });
  if (signal.aborted) close();
  return { config: { mcpServers: { [mcpServerName]: { type: "http", url: `http://${host}/mcp`, headers: { Authorization: `Bearer ${token}` } } } }, close };
}
