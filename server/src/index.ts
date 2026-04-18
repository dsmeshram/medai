import 'dotenv/config';
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { URL } from "url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolRequest,
  type ListToolsRequest,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const FDA_BASE = 'https://api.fda.gov';
const FDA_API_KEY = process.env.OPENFDA_API_KEY || '';

async function callOpenFda(endpoint: string, params: Record<string, string | number>): Promise<any> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  }
  if (FDA_API_KEY) qs.set('api_key', FDA_API_KEY);
  const url = `${FDA_BASE}${endpoint}?${qs.toString()}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`openFDA ${endpoint} returned ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

const toolInputSchema = {
  type: "object" as const,
  properties: {
    endpoint: {
      type: "string" as const,
      description: "The FDA API endpoint, e.g., '/drug/event.json' or '/drug/label.json'"
    },
    params: {
      type: "object" as const,
      description: "Query parameters for the API call",
      additionalProperties: true
    }
  },
  required: ["endpoint", "params"] as string[],
  additionalProperties: false as const,
};

const toolInputParser = z.object({
  endpoint: z.string(),
  params: z.record(z.string(), z.union([z.string(), z.number()]))
});

const tools: Tool[] = [
  {
    name: "call_openfda",
    description: "Call the OpenFDA API to search for drug events, labels, recalls, and more",
    inputSchema: toolInputSchema,
    title: "Call OpenFDA API",
    annotations: {
      destructiveHint: false,
      openWorldHint: false,
      readOnlyHint: true,
    }
  }
];

function createFdaServer(): Server {
  const server = new Server(
    {
      name: "fda-mcp-server",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(
    ListToolsRequestSchema,
    async (_request: ListToolsRequest) => ({
      tools,
    })
  );

  server.setRequestHandler(
    CallToolRequestSchema,
    async (request: CallToolRequest) => {
      const toolName = request.params.name;
      console.log(`\n[Tool Call] Requested tool: ${toolName}`);
      console.log(`[Tool Call] Arguments:`, JSON.stringify(request.params.arguments, null, 2));

      const tool = tools.find(t => t.name === toolName);

      if (!tool) {
        console.error(`[Tool Call] ERROR: Unknown tool: ${toolName}`);
        throw new Error(`Unknown tool: ${toolName}`);
      }

      try {
        const args = toolInputParser.parse(request.params.arguments ?? {});
        console.log(`[Tool Call] Parsed arguments - Endpoint: ${args.endpoint}, Params:`, args.params);
        
        console.log(`[FDA API] Calling OpenFDA API...`);
        console.log(`[FDA API] Endpoint: ${args.endpoint}`);
        console.log(`[FDA API] Parameters:`, args.params);
        
        const startTime = Date.now();
        const result = await callOpenFda(args.endpoint, args.params as Record<string, string | number>);
        const duration = Date.now() - startTime;
        
        console.log(`[FDA API] Response received in ${duration}ms`);
        console.log(`[FDA API] Response size: ${JSON.stringify(result).length} bytes`);
        
        if (result.results) {
          console.log(`[FDA API] Results count: ${result.results.length}`);
        }
        
        console.log(`[Tool Call] SUCCESS: Tool executed successfully\n`);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        const err = error as Error;
        console.error(`[Tool Call] ERROR executing tool:`, err.message);
        console.error(`[Tool Call] Stack:`, err.stack);
        throw error;
      }
    }
  );

  return server;
}

type SessionRecord = {
  server: Server;
  transport: SSEServerTransport;
};

const sessions = new Map<string, SessionRecord>();

const ssePath = "/mcp";
const postPath = "/mcp/messages";

async function handleSseRequest(res: ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const server = createFdaServer();
  const transport = new SSEServerTransport(postPath, res);
  const sessionId = transport.sessionId;

  console.log(`[Session] New SSE session created: ${sessionId}`);

  sessions.set(sessionId, { server, transport });
  console.log(`[Session] Total active sessions: ${sessions.size}`);

  transport.onclose = async () => {
    console.log(`[Session] Session closed: ${sessionId}`);
    sessions.delete(sessionId);
    console.log(`[Session] Total active sessions: ${sessions.size}`);
  };

  transport.onerror = (error) => {
    console.error(`[Session] SSE transport error for session ${sessionId}:`, error);
  };

  try {
    console.log(`[Session] Connecting server to transport for session ${sessionId}...`);
    await server.connect(transport);
    console.log(`[Session] Server connected for session ${sessionId}`);
  } catch (error) {
    console.error(`[Session] Failed to start SSE session ${sessionId}:`, error);
    sessions.delete(sessionId);
    if (!res.headersSent) {
      res.writeHead(500).end("Failed to establish SSE connection");
    }
  }
}

async function handlePostMessage(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  const sessionId = url.searchParams.get("sessionId");

  console.log(`[Message] POST message for sessionId: ${sessionId}`);

  if (!sessionId) {
    console.warn(`[Message] Missing sessionId query parameter`);
    res.writeHead(400).end("Missing sessionId query parameter");
    return;
  }

  const session = sessions.get(sessionId);

  if (!session) {
    console.warn(`[Message] Unknown session: ${sessionId}`);
    res.writeHead(404).end("Unknown session");
    return;
  }

  try {
    console.log(`[Message] Processing message for session: ${sessionId}`);
    await session.transport.handlePostMessage(req, res);
    console.log(`[Message] Message processed successfully for session: ${sessionId}`);
  } catch (error) {
    console.error(`[Message] Failed to process message for session ${sessionId}:`, error);
    if (!res.headersSent) {
      res.writeHead(500).end("Failed to process message");
    }
  }
}

const portEnv = Number(process.env.PORT ?? 8000);
const port = Number.isFinite(portEnv) ? portEnv : 8000;

const httpServer = createServer(
  async (req: IncomingMessage, res: ServerResponse) => {
    if (!req.url) {
      console.warn(`[HTTP] Request without URL`);
      res.writeHead(400).end("Missing URL");
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    console.log(`[HTTP] ${req.method} ${url.pathname}`);

    if (
      req.method === "OPTIONS" &&
      (url.pathname === ssePath || url.pathname === postPath)
    ) {
      console.log(`[HTTP] Responding to OPTIONS request for ${url.pathname}`);
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "content-type",
      });
      res.end();
      return;
    }

    if (req.method === "GET" && url.pathname === ssePath) {
      console.log(`[HTTP] Incoming SSE request`);
      await handleSseRequest(res);
      return;
    }

    if (req.method === "POST" && url.pathname === postPath) {
      console.log(`[HTTP] Incoming POST message`);
      await handlePostMessage(req, res, url);
      return;
    }

    console.warn(`[HTTP] 404: ${req.method} ${url.pathname}`);
    res.writeHead(404).end("Not Found");
  }
);

httpServer.on("clientError", (err: Error, socket) => {
  console.error("HTTP client error", err);
  socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
});

httpServer.listen(port, () => {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[Server] FDA MCP server listening on http://localhost:${port}`);
  console.log(`[Server] SSE stream: GET http://localhost:${port}${ssePath}`);
  console.log(`[Server] Message post endpoint: POST http://localhost:${port}${postPath}?sessionId=...`);
  console.log(`${'='.repeat(60)}\n`);
});