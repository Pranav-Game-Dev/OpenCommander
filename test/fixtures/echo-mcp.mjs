import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
const s = new McpServer({ name: "echo", version: "1.0.0" });
s.registerTool("echo", { description: "Echo text", inputSchema: { text: z.string() } }, async ({ text }) => ({ content: [{ type: "text", text: `echo:${text}` }] }));
s.registerTool("boom", { description: "Always fails", inputSchema: {} }, async () => ({ isError: true, content: [{ type: "text", text: "kaboom" }] }));
await s.connect(new StdioServerTransport());
