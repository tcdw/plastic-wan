import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "plasticwan-test", version: "1.0.0" });
let calls = 0;
server.registerTool(
  "echo",
  {
    description: "Echo text with a server-side call count",
    inputSchema: z.object({ text: z.string().min(1) }),
    annotations: { readOnlyHint: true },
  },
  ({ text }) => {
    calls += 1;
    return { content: [{ type: "text", text: `${calls}:${text}` }] };
  },
);

await server.connect(new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 1_048_576 }));
