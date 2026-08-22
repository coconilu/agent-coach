import { afterEach, describe, expect, it } from "vitest";
import { CoachError } from "../../src/errors.js";
import type { AgentCoachCore } from "../../src/core.js";
import { createCoreFixture, intent, turn, type CoreFixture } from "./helpers.js";

describe("Turn state machine and execution lease", () => {
  let fixture: CoreFixture | undefined;
  afterEach(async () => fixture?.cleanup());

  async function prepared(core: AgentCoachCore, suffix = "1") {
    const ref = turn(suffix);
    core.observe({ ...ref, task_type: "implementation", goal_summary: "synthetic", idempotency_key: `observe-${suffix}` });
    const packet = await core.prepare({ ...ref, intent: intent(), idempotency_key: `prepare-${suffix}` });
    return { ref, packet };
  }

  it("normalizes TurnRef and accepts repeated sanitized lifecycle observations", async () => {
    fixture = await createCoreFixture();
    const ref = turn();
    const observed = fixture.core.observe({
      ...ref,
      task_type: "question",
      goal_summary: "synthetic",
      host_event: { event_type: "UserPromptSubmit" },
      idempotency_key: "observe-1",
    });
    const repeated = fixture.core.observe({
      ...ref,
      task_type: "question",
      goal_summary: "synthetic",
      host_event: { event_type: "PostToolUse", action_class: "read" },
      idempotency_key: "observe-2",
    });
    const packet = await fixture.core.prepare({ ...ref, intent: intent(), idempotency_key: "prepare" });
    expect(repeated.turn_key).toBe(observed.turn_key);
    expect(packet.turn_ref).toEqual(ref);
    expect(JSON.stringify(repeated)).not.toContain("host_event");
  });

  it("rejects commit before prepare but permits an empty GuidancePacket after prepare", async () => {
    fixture = await createCoreFixture();
    const ref = turn();
    fixture.core.observe({ ...ref, task_type: "implementation", goal_summary: "synthetic", idempotency_key: "observe" });
    expect(() => fixture!.core.commitPlan({
      ...ref,
      packet_id: "packet-missing",
      revised_plan: { summary: "safe plan", steps: [], intended_tools: [], target_paths: [] },
      adoption: [],
      idempotency_key: "commit-before-prepare",
    })).toThrowError(expect.objectContaining({ code: "INVALID_STATE" }));
    const packet = await fixture.core.prepare({ ...ref, intent: intent("unmatched qzxv", []), idempotency_key: "prepare" });
    expect(packet.constraints).toEqual([]);
    expect(packet.preferences).toEqual([]);
    const commitInput = {
      ...ref,
      packet_id: packet.packet_id,
      revised_plan: { summary: "unchanged safe plan", steps: [], intended_tools: [], target_paths: [] },
      adoption: [],
      idempotency_key: "commit",
    };
    const ticket = fixture.core.commitPlan(commitInput);
    expect(ticket.execution_epoch).toBe(1);
    const persisted = fixture.core.state.db.prepare("SELECT response_json FROM idempotency").all() as unknown as Array<{ response_json: string }>;
    expect(persisted.some((row) => row.response_json.includes(ticket.ticket))).toBe(false);
    fixture.core.close();
    fixture.core = await (await import("../../src/core.js")).AgentCoachCore.create({
      home: fixture.home,
      knowledgeHome: fixture.knowledgeHome,
    });
    expect(fixture.core.commitPlan(commitInput).ticket).toBe(ticket.ticket);
  });

  it("redeems the pending server-side ticket once, then reuses the active epoch", async () => {
    fixture = await createCoreFixture();
    const { ref, packet } = await prepared(fixture.core);
    const ticket = fixture.core.commitPlan({
      ...ref,
      packet_id: packet.packet_id,
      revised_plan: { summary: "safe revised plan", steps: ["patch"], intended_tools: ["apply_patch"], target_paths: [] },
      adoption: [],
      idempotency_key: "commit",
    });
    const first = fixture.core.checkGate({ ...ref, action_name: "apply_patch", mode: "enforce", gateway_healthy: true });
    const concurrent = fixture.core.checkGate({ ...ref, action_name: "apply_patch", mode: "enforce", gateway_healthy: true });
    expect(first).toMatchObject({ allowed: true, execution_epoch: ticket.execution_epoch });
    expect(concurrent).toMatchObject({ allowed: true, execution_epoch: ticket.execution_epoch });
    const redeemed = fixture.core.state.db.prepare("SELECT count(*) AS count FROM tickets WHERE redeemed_at IS NOT NULL").get() as { count: number };
    expect(redeemed.count).toBe(1);
  });

  it("invalidates an old ticket and active epoch after a new PlanCommit", async () => {
    fixture = await createCoreFixture();
    const { ref, packet } = await prepared(fixture.core);
    const first = fixture.core.commitPlan({
      ...ref,
      packet_id: packet.packet_id,
      revised_plan: { summary: "plan one", steps: ["one"], intended_tools: ["apply_patch"], target_paths: [] },
      adoption: [],
      idempotency_key: "commit-1",
    });
    fixture.core.checkGate({ ...ref, action_name: "apply_patch", mode: "enforce" });
    const second = fixture.core.commitPlan({
      ...ref,
      packet_id: packet.packet_id,
      revised_plan: { summary: "plan two", steps: ["two"], intended_tools: ["apply_patch"], target_paths: [] },
      adoption: [],
      idempotency_key: "commit-2",
    });
    expect(second.execution_epoch).toBe(first.execution_epoch + 1);
    expect(() => fixture!.core.checkGate({
      ...ref,
      action_name: "apply_patch",
      ticket: first.ticket,
      execution_epoch: first.execution_epoch,
      mode: "enforce",
    })).toThrowError(expect.objectContaining({ code: "EPOCH_STALE" }));
    expect(fixture.core.checkGate({ ...ref, action_name: "apply_patch", mode: "enforce" }).execution_epoch).toBe(second.execution_epoch);
  });

  it("rejects cross-turn tickets and expired tickets", async () => {
    fixture = await createCoreFixture();
    const first = await prepared(fixture.core, "a");
    const ticket = fixture.core.commitPlan({
      ...first.ref,
      packet_id: first.packet.packet_id,
      revised_plan: { summary: "safe", steps: [], intended_tools: ["apply_patch"], target_paths: [] },
      adoption: [],
      idempotency_key: "commit-a",
    });
    const other = await prepared(fixture.core, "b");
    fixture.core.commitPlan({
      ...other.ref,
      packet_id: other.packet.packet_id,
      revised_plan: { summary: "safe", steps: [], intended_tools: ["apply_patch"], target_paths: [] },
      adoption: [],
      idempotency_key: "commit-b",
    });
    expect(() => fixture!.core.checkGate({ ...other.ref, action_name: "apply_patch", ticket: ticket.ticket, mode: "enforce" }))
      .toThrowError(expect.objectContaining({ code: "TICKET_INVALID" }));
    fixture.advance(11 * 60 * 1_000);
    expect(() => fixture!.core.checkGate({ ...first.ref, action_name: "apply_patch", ticket: ticket.ticket, mode: "enforce" }))
      .toThrowError(expect.objectContaining({ code: "TICKET_INVALID" }));
  });

  it("returns the same result for a repeated idempotency key and rejects payload reuse", async () => {
    fixture = await createCoreFixture();
    const ref = turn();
    const input = { ...ref, task_type: "question", goal_summary: "synthetic", idempotency_key: "same-key" };
    expect(fixture.core.observe(input)).toEqual(fixture.core.observe(input));
    expect(() => fixture!.core.observe({ ...input, goal_summary: "different" }))
      .toThrowError(expect.objectContaining({ code: "IDEMPOTENCY_CONFLICT" }));
  });

  it("allows reads without coaching, treats unknowns as writes, and fails open only when degraded", async () => {
    fixture = await createCoreFixture();
    const ref = turn();
    expect(fixture.core.checkGate({ ...ref, action_name: "read_file", mode: "enforce" })).toMatchObject({ allowed: true, degraded: false });
    expect(() => fixture!.core.checkGate({ ...ref, action_name: "future_tool", mode: "enforce" }))
      .toThrowError(expect.objectContaining({ code: "ACTION_REQUIRES_COACHING" }));
    expect(fixture.core.checkGate({ ...ref, action_name: "future_tool", mode: "enforce", gateway_healthy: false }))
      .toMatchObject({ allowed: true, degraded: true });
  });
});
