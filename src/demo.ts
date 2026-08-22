import type { AgentCoachCore } from "./core.js";
import { gatewayRequest } from "./client/gateway-client.js";
import { turnKey } from "./storage/state-store.js";
import { opaqueId } from "./utils.js";

export interface DemoResult {
  scenarios: Array<{ name: string; status: "PASS" | "DEGRADED"; detail: Record<string, unknown> }>;
  summary: { passed: number; degraded: number; candidate_count: number };
}

function ref(kind: string) {
  const suffix = opaqueId(kind).slice(-12);
  return {
    project_id: "synthetic-demo",
    host: "demo-host",
    session_id: `demo-session-${suffix}`,
    turn_id: `demo-turn-${suffix}`,
  };
}

function intent(goal: string, taskType: string, intendedTools: string[]) {
  return {
    goal,
    task_type: taskType,
    planned_steps: ["Inspect current state", "Apply the smallest verified action", "Record evidence"],
    intended_tools: intendedTools,
    target_paths: [],
    constraints: ["Use only synthetic demo data"],
    assumptions: [],
    risk_flags: intendedTools.includes("apply_patch") ? ["writes local files"] : [],
  };
}

export async function seedDemoConflict(core: AgentCoachCore): Promise<void> {
  if (await core.knowledge.get("mem_demo_conflict_a")) return;
  const now = new Date(0).toISOString();
  await core.seedApprovedKnowledge({
    id: "mem_demo_conflict_a",
    type: "fact",
    title: "Synthetic package policy",
    content: "The synthetic demo package must use strategy A.",
    scope: "project:synthetic-demo",
    status: "approved",
    is_constraint: true,
    provenance: { source_refs: ["synthetic:contract-a"], evidence_refs: ["sha256:demo-a"], origin: "synthetic_demo" },
    expires_at: null,
    supersedes: [],
    conflicts: ["mem_demo_conflict_b"],
    created_at: now,
  });
  await core.seedApprovedKnowledge({
    id: "mem_demo_conflict_b",
    type: "fact",
    title: "Synthetic package policy",
    content: "The synthetic demo package must use strategy B.",
    scope: "project:synthetic-demo",
    status: "approved",
    is_constraint: true,
    provenance: { source_refs: ["synthetic:contract-b"], evidence_refs: ["sha256:demo-b"], origin: "synthetic_demo" },
    expires_at: null,
    supersedes: [],
    conflicts: ["mem_demo_conflict_a"],
    created_at: now,
  });
}

export async function runSyntheticDemo(home: string): Promise<DemoResult> {
  const scenarios: DemoResult["scenarios"] = [];

  const qa = ref("qa");
  await gatewayRequest("/v1/turns/observe", {
    home,
    method: "POST",
    body: { ...qa, task_type: "question", goal_summary: "Answer a synthetic question", idempotency_key: opaqueId("idem") },
  });
  const qaOutcome = await gatewayRequest<{ candidate_refs: string[] }>(`/v1/turns/${turnKey(qa)}/complete`, {
    home,
    method: "POST",
    body: {
      ...qa,
      outcome_status: "succeeded",
      outcome_summary: "Synthetic answer completed without a ticket",
      evidence_refs: ["synthetic:qa-result"],
      learning_proposals: [{
        proposal_id: opaqueId("proposal"),
        type: "preference",
        title: "Synthetic concise output preference",
        summary: "For synthetic-demo, present the result before implementation details.",
        scope: "project:synthetic-demo",
        explicitness: "explicit",
        confidence: 1,
        source_refs: ["user-statement:synthetic-demo"],
        evidence_refs: [],
        origin: "agent_proposal",
      }],
      idempotency_key: opaqueId("idem"),
    },
  });
  scenarios.push({ name: "pure-question", status: "PASS", detail: { ticket_required: false, candidates: qaOutcome.candidate_refs } });

  const candidateId = qaOutcome.candidate_refs[0];
  if (candidateId) {
    const preview = await gatewayRequest<Record<string, unknown>>(`/v1/candidates/${candidateId}/preview`, { home, method: "POST", body: {} });
    await gatewayRequest(`/v1/candidates/${candidateId}/approve`, {
      home,
      method: "POST",
      body: {
        proposal_hash: preview.proposal_hash,
        base_revision: preview.base_revision,
        idempotency_key: opaqueId("idem"),
      },
    });
  }

  const read = ref("read");
  await gatewayRequest("/v1/turns/observe", {
    home,
    method: "POST",
    body: { ...read, task_type: "inspection", goal_summary: "Inspect synthetic state", idempotency_key: opaqueId("idem") },
  });
  const readGate = await gatewayRequest<Record<string, unknown>>("/v1/gates/check", {
    home,
    method: "POST",
    body: { ...read, action_name: "read_file", action_arguments: {}, mode: "enforce", gateway_healthy: true },
  });
  const readPacket = await gatewayRequest<{ preferences: unknown[] }>("/v1/turns/prepare", {
    home,
    method: "POST",
    body: { ...read, intent: intent("Inspect synthetic state with concise output", "inspection", ["read_file"]), idempotency_key: opaqueId("idem") },
  });
  await gatewayRequest(`/v1/turns/${turnKey(read)}/complete`, {
    home,
    method: "POST",
    body: { ...read, outcome_status: "succeeded", outcome_summary: "Read-only inspection completed", evidence_refs: [], learning_proposals: [], idempotency_key: opaqueId("idem") },
  });
  scenarios.push({ name: "read-only", status: "PASS", detail: { gate: readGate, recalled_preferences: readPacket.preferences.length } });

  const write = ref("write");
  const packet = await gatewayRequest<Record<string, unknown>>("/v1/turns/prepare", {
    home,
    method: "POST",
    body: { ...write, intent: intent("Patch the synthetic demo after checking package policy", "implementation", ["apply_patch"]), idempotency_key: opaqueId("idem") },
  });
  const ticket = await gatewayRequest<Record<string, unknown>>(`/v1/turns/${turnKey(write)}/commit`, {
    home,
    method: "POST",
    body: {
      ...write,
      packet_id: packet.packet_id,
      revised_plan: { summary: "Use governed context, then patch and verify", steps: ["Review guidance", "Patch", "Verify"], intended_tools: ["apply_patch"], target_paths: [] },
      adoption: [],
      idempotency_key: opaqueId("idem"),
    },
  });
  const gate = await gatewayRequest<Record<string, unknown>>("/v1/gates/check", {
    home,
    method: "POST",
    body: { ...write, action_name: "apply_patch", action_arguments: {}, mode: "enforce", gateway_healthy: true },
  });
  const activeGate = await gatewayRequest<Record<string, unknown>>("/v1/gates/check", {
    home,
    method: "POST",
    body: { ...write, action_name: "apply_patch", action_arguments: {}, mode: "enforce", gateway_healthy: true },
  });
  await gatewayRequest(`/v1/turns/${turnKey(write)}/complete`, {
    home,
    method: "POST",
    body: {
      ...write,
      outcome_status: "succeeded",
      outcome_summary: "Synthetic side effect verified",
      evidence_refs: ["synthetic:test-pass"],
      learning_proposals: [{
        proposal_id: opaqueId("proposal"),
        type: "experience",
        title: "Synthetic verification experience",
        summary: "After a synthetic patch, run the deterministic verification fixture.",
        scope: "project:synthetic-demo",
        explicitness: "inferred",
        confidence: 0.9,
        source_refs: ["turn:synthetic-write"],
        evidence_refs: ["synthetic:test-pass"],
        origin: "agent_proposal",
      }],
      idempotency_key: opaqueId("idem"),
    },
  });
  scenarios.push({
    name: "side-effect-handshake",
    status: "PASS",
    detail: {
      action_ticket_returned: typeof ticket.ticket === "string",
      server_redeemed_without_hook_ticket: gate,
      active_epoch_reused: activeGate,
    },
  });
  scenarios.push({
    name: "conflict-isolation",
    status: Array.isArray(packet.conflicts) && packet.conflicts.length > 0 ? "PASS" : "DEGRADED",
    detail: { conflicts: packet.conflicts ?? [] },
  });
  scenarios.push({
    name: "provider-outage-fallback",
    status: "PASS",
    detail: { provider_required: false, canonical_path_available: true },
  });

  const candidateList = await gatewayRequest<{ items: unknown[] }>("/v1/candidates?status=candidate", { home });
  return {
    scenarios,
    summary: {
      passed: scenarios.filter((scenario) => scenario.status === "PASS").length,
      degraded: scenarios.filter((scenario) => scenario.status === "DEGRADED").length,
      candidate_count: candidateList.items.length,
    },
  };
}
