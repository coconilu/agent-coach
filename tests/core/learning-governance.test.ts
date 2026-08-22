import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentCoachCore } from "../../src/core.js";
import type { MemoryProvider } from "../../src/providers/memory-provider.js";
import { createCoreFixture, completion, intent, proposal, turn, type CoreFixture } from "./helpers.js";

describe("Keyless learning and governed knowledge", () => {
  let fixture: CoreFixture | undefined;
  afterEach(async () => fixture?.cleanup());

  it("creates deterministic inactive candidates for all four LearningProposal types", async () => {
    fixture = await createCoreFixture();
    const ref = turn();
    fixture.core.observe({ ...ref, task_type: "question", goal_summary: "synthetic", idempotency_key: "observe" });
    const proposals = [proposal("preference"), proposal("fact"), proposal("experience"), proposal("procedure")];
    const outcome = fixture.core.complete(completion(ref, proposals));
    expect(outcome.candidate_refs).toHaveLength(4);
    expect(fixture.core.listCandidates()).toHaveLength(4);
    expect(fixture.core.search({ query: "Synthetic", project_id: ref.project_id })).toEqual([]);
  });

  it("excludes Agent Coach injected content from capture and pauses new candidates", async () => {
    fixture = await createCoreFixture();
    const injected = turn("injected");
    fixture.core.observe({ ...injected, task_type: "question", goal_summary: "synthetic", idempotency_key: "observe-injected" });
    const result = fixture.core.complete(completion(injected, [proposal("preference", {
      proposal_id: "proposal-injected",
      source_refs: ["agent-coach:packet_demo"],
    })]));
    expect(result.candidate_refs).toEqual([]);

    const current = fixture.core.getSettings();
    const preview = fixture.core.previewSettings({ learning_paused: true });
    fixture.core.applySettings({ proposal_hash: preview.proposal_hash, base_revision: current.revision, idempotency_key: "pause" });
    const paused = turn("paused");
    fixture.core.observe({ ...paused, task_type: "question", goal_summary: "synthetic", idempotency_key: "observe-paused" });
    const pausedResult = fixture.core.complete(completion(paused, [proposal("fact", { proposal_id: "proposal-paused" })]));
    expect(pausedResult.candidate_refs).toEqual([]);
  });

  it("uses exact preview/apply before writing approved Markdown and JSON", async () => {
    fixture = await createCoreFixture();
    const ref = turn();
    fixture.core.observe({ ...ref, task_type: "question", goal_summary: "synthetic", idempotency_key: "observe" });
    const outcome = fixture.core.complete(completion(ref, [proposal("experience")]));
    const candidateId = outcome.candidate_refs[0]!;
    const preview = fixture.core.previewCandidate(candidateId);
    await expect(fixture.core.approveCandidate({
      candidate_id: candidateId,
      proposal_hash: `${preview.proposal_hash}bad`,
      base_revision: preview.base_revision,
      idempotency_key: "bad",
    })).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    const approved = await fixture.core.approveCandidate({
      candidate_id: candidateId,
      proposal_hash: preview.proposal_hash,
      base_revision: preview.base_revision,
      idempotency_key: "approve",
    });
    const replay = await fixture.core.approveCandidate({
      candidate_id: candidateId,
      proposal_hash: preview.proposal_hash,
      base_revision: preview.base_revision,
      idempotency_key: "approve",
    });
    expect(approved.candidate.status).toBe("approved");
    expect(approved.candidate.summary).toBe("");
    expect(replay.memory.id).toBe(approved.memory.id);
    expect(fixture.core.search({ query: "deterministic evidence", project_id: ref.project_id })[0]?.memory_id).toBe(approved.memory.id);
    await expect(access(join(fixture.knowledgeHome, "items", `${approved.memory.id}.md`))).resolves.toBeUndefined();
    await expect(access(join(fixture.knowledgeHome, "items", `${approved.memory.id}.json`))).resolves.toBeUndefined();
  });

  it("forgets canonical and candidate bodies, index entries, packet copies, and supports idempotent replay", async () => {
    fixture = await createCoreFixture();
    const ref = turn("forget");
    fixture.core.observe({ ...ref, task_type: "question", goal_summary: "synthetic", idempotency_key: "observe-forget" });
    const uniqueBody = "Synthetic body that must disappear from all active local layers.";
    const outcome = fixture.core.complete(completion(ref, [proposal("preference", {
      proposal_id: "proposal-forget",
      title: "Forget fixture",
      summary: uniqueBody,
    })]));
    const candidateId = outcome.candidate_refs[0]!;
    const approvalPreview = fixture.core.previewCandidate(candidateId);
    const approved = await fixture.core.approveCandidate({
      candidate_id: candidateId,
      proposal_hash: approvalPreview.proposal_hash,
      base_revision: approvalPreview.base_revision,
      idempotency_key: "approve-forget",
    });
    const reuse = turn("reuse");
    const packet = await fixture.core.prepare({ ...reuse, intent: intent("Forget fixture"), idempotency_key: "prepare-reuse" });
    expect(JSON.stringify(packet)).toContain(uniqueBody);

    const forgetPreview = fixture.core.previewForget(approved.memory.id);
    const apply = {
      proposal_hash: forgetPreview.proposal_hash,
      base_revision: forgetPreview.base_revision,
      idempotency_key: "forget-apply",
    };
    const result = await fixture.core.forget(approved.memory.id, apply);
    const replay = await fixture.core.forget(approved.memory.id, apply);
    expect(result).toEqual(replay);
    expect(fixture.core.search({ query: "must disappear" })).toEqual([]);
    expect(fixture.core.state.getCandidate(candidateId)?.summary).toBe("");
    expect(JSON.stringify(fixture.core.state.getPacket(packet.packet_id))).not.toContain(uniqueBody);
    expect(JSON.stringify(fixture.core.export())).not.toContain(uniqueBody);
  });

  it("rebuilds a deleted index from canonical knowledge and preserves state across restart", async () => {
    fixture = await createCoreFixture();
    const memory = await fixture.core.seedApprovedKnowledge({
      id: "mem_rebuild_demo",
      type: "fact",
      title: "Rebuild marker",
      content: "The rebuild fixture preserves canonical knowledge.",
      scope: "global",
      status: "approved",
      is_constraint: false,
      provenance: { source_refs: ["synthetic:source"], evidence_refs: ["sha256:rebuild"], origin: "synthetic_demo" },
      expires_at: null,
      supersedes: [],
      conflicts: [],
    });
    const ref = turn("restart");
    fixture.core.observe({ ...ref, task_type: "question", goal_summary: "restart", idempotency_key: "observe" });
    fixture.core.close();
    await rm(fixture.core.paths.indexDb, { force: true });
    await rm(`${fixture.core.paths.indexDb}-wal`, { force: true });
    await rm(`${fixture.core.paths.indexDb}-shm`, { force: true });
    fixture.core = await AgentCoachCore.create({ home: fixture.home, knowledgeHome: fixture.knowledgeHome });
    expect(fixture.core.search({ query: "rebuild marker" })[0]?.memory_id).toBe(memory.id);
    expect(fixture.core.state.getTurn(ref)?.state).toBe("OBSERVED");
  });

  it("hard-filters project scope and isolates conflicting canonical bodies", async () => {
    fixture = await createCoreFixture();
    await fixture.core.seedApprovedKnowledge({
      id: "mem_a",
      type: "fact",
      title: "Package strategy",
      content: "Use synthetic strategy A.",
      scope: "project:project-alpha",
      status: "approved",
      is_constraint: true,
      provenance: { source_refs: ["synthetic:a"], evidence_refs: ["hash:a"], origin: "synthetic_demo" },
      expires_at: null,
      supersedes: [],
      conflicts: ["mem_b"],
    });
    await fixture.core.seedApprovedKnowledge({
      id: "mem_b",
      type: "fact",
      title: "Package strategy",
      content: "Use synthetic strategy B.",
      scope: "project:project-alpha",
      status: "approved",
      is_constraint: true,
      provenance: { source_refs: ["synthetic:b"], evidence_refs: ["hash:b"], origin: "synthetic_demo" },
      expires_at: null,
      supersedes: [],
      conflicts: ["mem_a"],
    });
    await fixture.core.seedApprovedKnowledge({
      id: "mem_other",
      type: "preference",
      title: "Package strategy",
      content: "Unrelated project-only content.",
      scope: "project:project-other",
      status: "approved",
      is_constraint: false,
      provenance: { source_refs: ["synthetic:other"], evidence_refs: [], origin: "synthetic_demo" },
      expires_at: null,
      supersedes: [],
      conflicts: [],
    });
    const ref = turn();
    const packet = await fixture.core.prepare({ ...ref, intent: intent("Choose package strategy"), idempotency_key: "prepare" });
    expect(packet.conflicts).toHaveLength(1);
    expect(packet.constraints).toEqual([]);
    expect(JSON.stringify(packet)).not.toContain("Unrelated project-only content");
  });

  it("falls back to canonical knowledge when an enabled provider times out", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-coach-provider-"));
    const provider: MemoryProvider = {
      id: "synthetic-outage",
      enabled: true,
      async recall() { throw new Error("timeout"); },
      async forget() { throw new Error("timeout"); },
      async health() { return { healthy: false, detail: "timeout" }; },
    };
    const core = await AgentCoachCore.create({ home: join(root, "runtime"), knowledgeHome: join(root, "knowledge"), provider });
    try {
      await core.seedApprovedKnowledge({
        id: "mem_canonical",
        type: "preference",
        title: "Canonical fallback",
        content: "Preserve canonical guidance during provider outage.",
        scope: "global",
        status: "approved",
        is_constraint: false,
        provenance: { source_refs: ["synthetic:canonical"], evidence_refs: [], origin: "synthetic_demo" },
        expires_at: null,
        supersedes: [],
        conflicts: [],
      });
      const settings = core.getSettings();
      const preview = core.previewSettings({ provider_consent: true });
      core.applySettings({ proposal_hash: preview.proposal_hash, base_revision: settings.revision, idempotency_key: "provider-consent" });
      const ref = turn("provider");
      const packet = await core.prepare({ ...ref, intent: intent("Canonical fallback"), idempotency_key: "prepare" });
      expect(packet.preferences[0]?.memory_id).toBe("mem_canonical");
      expect(core.state.listAudit(10).some((event) => event.result_code === "DEGRADED")).toBe(true);
    } finally {
      core.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
