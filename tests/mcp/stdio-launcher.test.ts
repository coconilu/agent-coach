import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { AgentCoachCore } from "../../src/core.js";
import { AgentCoachGateway } from "../../src/server/gateway.js";

const workspace = resolve(import.meta.dirname, "../..");

function childEnvironment(home: string): Record<string, string> {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
    AGENT_COACH_HOME: home,
  };
}

async function connect(home: string) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/mcp/launcher.ts"],
    cwd: workspace,
    env: childEnvironment(home),
    stderr: "pipe",
  });
  const client = new Client({ name: "synthetic-test-client", version: "1.0.0" });
  await client.connect(transport);
  return { client, transport };
}

function jsonResult(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const content = (result as { content: Array<{ type: string; text?: string }> }).content[0];
  if (!content || content.type !== "text") throw new Error("Expected MCP text result");
  return JSON.parse(content.text ?? "null") as Record<string, unknown>;
}

describe("MCP stdio launcher", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()!();
  });

  it("initializes and lists all six tools quickly while the Gateway is offline", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-coach-mcp-offline-"));
    const home = join(root, "runtime");
    const started = performance.now();
    const { client, transport } = await connect(home);
    cleanups.push(async () => { await client.close(); await rm(root, { recursive: true, force: true }); });
    const listed = await client.listTools();
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
      "coach_commit_plan",
      "coach_complete",
      "coach_explain",
      "coach_feedback",
      "coach_prepare",
      "coach_search",
    ]);
    const unavailable = await client.callTool({ name: "coach_search", arguments: { query: "synthetic" } });
    expect(unavailable.isError).toBe(true);
    expect(transport.pid).toBeTypeOf("number");
  });

  it("runs all six tools against the same authenticated Core and exits with stdin transport", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-coach-mcp-live-"));
    const home = join(root, "runtime");
    const core = await AgentCoachCore.create({ home, knowledgeHome: join(root, "knowledge") });
    const gateway = await AgentCoachGateway.start(core);
    const { client, transport } = await connect(home);
    cleanups.push(async () => {
      await client.close();
      await gateway.close();
      core.close();
      await rm(root, { recursive: true, force: true });
    });

    const ref = {
      project_id: "synthetic-project-mcp",
      host: "synthetic-mcp-host",
      session_id: "synthetic-session-mcp",
      turn_id: "synthetic-turn-mcp",
    };
    const preparedResult = await client.callTool({
      name: "coach_prepare",
      arguments: {
        ...ref,
        intent: {
          goal: "Run a synthetic MCP write",
          task_type: "implementation",
          planned_steps: ["Prepare", "Commit", "Verify"],
          intended_tools: ["apply_patch"],
          target_paths: [],
          constraints: [],
          assumptions: [],
          risk_flags: ["synthetic write"],
        },
        idempotency_key: "synthetic-idem-prepare",
      },
    });
    const packet = jsonResult(preparedResult);

    const search = await client.callTool({ name: "coach_search", arguments: { query: "synthetic", project_id: ref.project_id } });
    expect(search.isError).not.toBe(true);
    const explain = await client.callTool({ name: "coach_explain", arguments: { packet_id: packet.packet_id } });
    expect(jsonResult(explain)).toMatchObject({ kind: "packet" });

    const committed = await client.callTool({
      name: "coach_commit_plan",
      arguments: {
        ...ref,
        packet_id: packet.packet_id,
        revised_plan: { summary: "Synthetic MCP plan", steps: ["write", "verify"], intended_tools: ["apply_patch"], target_paths: [] },
        adoption: [],
        idempotency_key: "synthetic-idem-commit",
      },
    });
    expect(jsonResult(committed).execution_epoch).toBe(1);

    const completed = await client.callTool({
      name: "coach_complete",
      arguments: {
        ...ref,
        outcome_status: "succeeded",
        outcome_summary: "Synthetic MCP cycle succeeded",
        evidence_refs: ["synthetic:mcp-pass"],
        learning_proposals: [],
        idempotency_key: "synthetic-idem-complete",
      },
    });
    expect(jsonResult(completed).status).toBe("succeeded");
    const feedback = await client.callTool({
      name: "coach_feedback",
      arguments: { packet_id: packet.packet_id, sentiment: "helpful", note: "synthetic", idempotency_key: "synthetic-idem-feedback" },
    });
    expect(jsonResult(feedback).sentiment).toBe("helpful");

    const pid = transport.pid!;
    await client.close();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    expect(() => process.kill(pid, 0)).toThrow();
  });
});
