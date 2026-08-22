#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { gatewayRequest } from "../client/gateway-client.js";

const tools = [
  {
    name: "coach_prepare",
    description: "Retrieve governed guidance for an explicit plan summary before side effects.",
    inputSchema: {
      type: "object" as const,
      required: ["project_id", "host", "session_id", "turn_id", "intent", "idempotency_key"],
      additionalProperties: true,
      properties: {
        project_id: { type: "string" },
        host: { type: "string" },
        session_id: { type: "string" },
        turn_id: { type: "string" },
        intent: { type: "object" },
        idempotency_key: { type: "string" },
      },
    },
  },
  {
    name: "coach_commit_plan",
    description: "Commit the revised plan and adoption decisions, returning a single-use ActionTicket.",
    inputSchema: { type: "object" as const, additionalProperties: true },
  },
  {
    name: "coach_search",
    description: "Search approved governed knowledge with scope and type filters.",
    inputSchema: {
      type: "object" as const,
      required: ["query"],
      additionalProperties: true,
      properties: { query: { type: "string" }, project_id: { type: "string" }, limit: { type: "integer" } },
    },
  },
  {
    name: "coach_explain",
    description: "Explain the source, authority, conflict handling, and budget for a packet or memory.",
    inputSchema: {
      type: "object" as const,
      additionalProperties: false,
      properties: { packet_id: { type: "string" }, memory_id: { type: "string" } },
      anyOf: [{ required: ["packet_id"] }, { required: ["memory_id"] }],
    },
  },
  {
    name: "coach_complete",
    description: "Complete a turn and optionally submit keyless structured LearningProposals.",
    inputSchema: { type: "object" as const, additionalProperties: true },
  },
  {
    name: "coach_feedback",
    description: "Record helpful, not-helpful, stale, or wrong feedback for a packet or memory.",
    inputSchema: { type: "object" as const, additionalProperties: true },
  },
] as const;

async function call(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "coach_prepare":
      return gatewayRequest("/v1/turns/prepare", { method: "POST", body: args });
    case "coach_commit_plan":
      return gatewayRequest(`/v1/turns/${encodeURIComponent(String(args.turn_id ?? ""))}/commit`, { method: "POST", body: args });
    case "coach_search": {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(args)) {
        if (Array.isArray(value)) value.forEach((item) => query.append(key.replace(/s$/, ""), String(item)));
        else if (value !== undefined) query.set(key, String(value));
      }
      return gatewayRequest(`/v1/knowledge/search?${query.toString()}`);
    }
    case "coach_explain":
      return gatewayRequest("/v1/explain", { method: "POST", body: args });
    case "coach_complete":
      return gatewayRequest(`/v1/turns/${encodeURIComponent(String(args.turn_id ?? ""))}/complete`, { method: "POST", body: args });
    case "coach_feedback":
      return gatewayRequest("/v1/feedback", { method: "POST", body: args });
    default:
      throw new Error(`Unknown Agent Coach tool: ${name}`);
  }
}

export async function runMcpLauncher(): Promise<void> {
  const server = new Server(
    { name: "agent-coach", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...tools] }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const value = await call(request.params.name, (request.params.arguments ?? {}) as Record<string, unknown>);
      return {
        content: [{ type: "text", text: JSON.stringify(value) }],
        structuredContent: value as Record<string, unknown>,
      };
    } catch (error) {
      return {
        isError: true,
        content: [{
          type: "text",
          text: error instanceof Error ? error.message : "Agent Coach tool call failed",
        }],
      };
    }
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entry) {
  runMcpLauncher().catch((error) => {
    process.stderr.write(`agent-coach-mcp: ${error instanceof Error ? error.message : "startup failed"}\n`);
    process.exitCode = 1;
  });
}
