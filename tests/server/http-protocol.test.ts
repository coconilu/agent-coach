import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentCoachCore } from "../../src/core.js";
import { AgentCoachGateway } from "../../src/server/gateway.js";

describe("versioned HTTP protocol", () => {
  let root: string | undefined;
  let core: AgentCoachCore | undefined;
  let gateway: AgentCoachGateway | undefined;
  afterEach(async () => {
    await gateway?.close();
    core?.close();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("runs observe/prepare/commit/server-gate/complete and explain by turn_id", async () => {
    root = await mkdtemp(join(tmpdir(), "agent-coach-http-"));
    core = await AgentCoachCore.create({ home: join(root, "runtime"), knowledgeHome: join(root, "knowledge") });
    gateway = await AgentCoachGateway.start(core);
    const token = (await readFile(core.paths.token, "utf8")).trim();
    const request = async (path: string, body?: unknown) => {
      const response = await fetch(`${gateway!.discovery.origin}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { response, payload: await response.json() as Record<string, unknown> };
    };
    const ref = { project_id: "synthetic-project-http", host: "demo", session_id: "synthetic-session-http", turn_id: "synthetic-turn-http" };
    expect((await request("/v1/turns/observe", { ...ref, task_type: "implementation", goal_summary: "synthetic", idempotency_key: "observe" })).response.status).toBe(201);
    const prepared = await request("/v1/turns/prepare", {
      ...ref,
      intent: { goal: "synthetic", task_type: "implementation", planned_steps: [], intended_tools: ["apply_patch"], target_paths: [], constraints: [], assumptions: [], risk_flags: [] },
      idempotency_key: "prepare",
    });
    expect(prepared.response.status).toBe(201);
    const committed = await request(`/v1/turns/${ref.turn_id}/commit`, {
      ...ref,
      packet_id: prepared.payload.packet_id,
      revised_plan: { summary: "synthetic safe plan", steps: [], intended_tools: ["apply_patch"], target_paths: [] },
      adoption: [],
      idempotency_key: "commit",
    });
    expect(committed.response.status).toBe(201);
    expect(typeof committed.payload.ticket).toBe("string");

    const gated = await request("/v1/gates/check", { ...ref, action_name: "apply_patch", action_arguments: {}, mode: "enforce", gateway_healthy: true });
    expect(gated.payload).toMatchObject({ allowed: true, execution_epoch: 1 });
    const resolvedGate = await request("/v1/gates/check", {
      host: ref.host,
      session_id: ref.session_id,
      resolve_active_turn: true,
      action_name: "apply_patch",
      action_arguments: {},
      mode: "enforce",
      gateway_healthy: true,
    });
    expect(resolvedGate.payload).toMatchObject({ allowed: true, execution_epoch: 1 });
    const explained = await request("/v1/explain", { packet_id: prepared.payload.packet_id });
    expect(explained.payload).toMatchObject({ kind: "packet", packet_id: prepared.payload.packet_id });
    const completed = await request(`/v1/turns/${ref.turn_id}/complete`, {
      ...ref,
      outcome_status: "succeeded",
      outcome_summary: "synthetic done",
      evidence_refs: ["synthetic:pass"],
      learning_proposals: [],
      idempotency_key: "complete",
    });
    expect(completed.response.status).toBe(201);
    expect(completed.payload).toMatchObject({ status: "succeeded" });
  });

  it("resolves Kimi lifecycle events without turn_id and closes the lightweight trace on Stop", async () => {
    root = await mkdtemp(join(tmpdir(), "agent-coach-http-kimi-"));
    core = await AgentCoachCore.create({ home: join(root, "runtime"), knowledgeHome: join(root, "knowledge") });
    gateway = await AgentCoachGateway.start(core);
    const token = (await readFile(core.paths.token, "utf8")).trim();
    const post = async (path: string, body: unknown) => {
      const response = await fetch(`${gateway!.discovery.origin}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return { response, payload: await response.json() as Record<string, unknown> };
    };
    const ref = {
      project_id: "synthetic-project-kimi",
      host: "kimi",
      session_id: "synthetic-session-kimi",
      turn_id: "synthetic-turn-kimi-one",
    };
    await post("/v1/turns/observe", {
      ...ref,
      task_type: "question",
      goal_summary: "synthetic",
      host_event: { event_type: "UserPromptSubmit" },
      idempotency_key: "synthetic-kimi-prompt",
    });
    const postTool = await post("/v1/turns/observe", {
      host: ref.host,
      session_id: ref.session_id,
      resolve_active_turn: true,
      task_type: "question",
      goal_summary: "",
      host_event: { event_type: "PostToolUse", action_class: "read" },
      idempotency_key: "synthetic-kimi-post-tool",
    });
    expect(postTool.payload).toMatchObject({ turn_id: ref.turn_id, state: "OBSERVED" });
    const stopped = await post("/v1/turns/observe", {
      host: ref.host,
      session_id: ref.session_id,
      resolve_active_turn: true,
      task_type: "question",
      goal_summary: "",
      host_event: { event_type: "Stop", outcome_status: "succeeded" },
      idempotency_key: "synthetic-kimi-stop",
    });
    expect(stopped.payload).toMatchObject({ turn_id: ref.turn_id, state: "COMPLETED" });
    expect(core.state.findUnfinishedTurns(ref.host, ref.session_id, new Date().toISOString())).toHaveLength(0);

    const next = await post("/v1/turns/observe", {
      ...ref,
      turn_id: "synthetic-turn-kimi-two",
      task_type: "implementation",
      goal_summary: "synthetic next turn",
      host_event: { event_type: "UserPromptSubmit" },
      idempotency_key: "synthetic-kimi-next",
    });
    expect(next.payload).toMatchObject({ state: "OBSERVED", turn_id: "synthetic-turn-kimi-two" });
    expect(core.state.findUnfinishedTurns(ref.host, ref.session_id, new Date().toISOString())).toHaveLength(1);
  });
});
