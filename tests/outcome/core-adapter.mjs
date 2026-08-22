import { join } from "node:path";
import { pathToFileURL } from "node:url";

function packetItems(packet) {
  return [
    ...packet.constraints,
    ...packet.preferences,
    ...packet.facts,
    ...packet.experiences,
    ...packet.procedures,
  ];
}

function unique(values) {
  return [...new Set(values)];
}

class DeterministicOutageProvider {
  id = "synthetic-outage-provider";
  enabled = true;
  recalls = 0;
  failures = 0;

  async recall(input) {
    this.recalls += 1;
    if (input.turn_ref.project_id === "synthetic-provider") {
      this.failures += 1;
      throw new Error("synthetic provider outage");
    }
    return [];
  }

  async forget() {
    return { deleted: false, verified: false, detail: "synthetic provider has no stored records" };
  }

  async health() {
    return { healthy: false, detail: "synthetic provider outage fixture" };
  }
}

function turnRef(scenario, host, runIndex) {
  return {
    project_id: scenario.project_id,
    host,
    session_id: `synthetic-session-${host}`,
    turn_id: `synthetic-turn-${scenario.id}-${runIndex}`,
  };
}

function conflictsFor(memory, knowledge) {
  if (!memory.conflict_key) return [];
  return knowledge
    .filter((candidate) => candidate.conflict_key === memory.conflict_key && candidate.id !== memory.id)
    .map((candidate) => candidate.id)
    .sort();
}

export async function createEvaluationAdapter({ fixtures, temporaryHome, repositoryRoot }) {
  let runtime;
  try {
    runtime = await import(pathToFileURL(join(repositoryRoot, "dist", "index.js")).href);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "IMPORT_FAILED";
    throw new Error(`Built Core is unavailable (${code}). Run 'pnpm build' first.`);
  }
  if (typeof runtime.AgentCoachCore?.create !== "function") {
    throw new Error("dist/index.js does not export AgentCoachCore.create()");
  }

  const provider = new DeterministicOutageProvider();
  const core = await runtime.AgentCoachCore.create({
    home: join(temporaryHome, "runtime"),
    knowledgeHome: join(temporaryHome, "knowledge"),
    sourceRoot: repositoryRoot,
    provider,
  });
  const rawPackets = new Map();
  let seededCount = 0;

  return {
    evidence_kind: "CORE_RUNTIME",

    async setup(knowledge) {
      for (const memory of knowledge) {
        if (memory.status === "candidate" || memory.status === "rejected") continue;
        await core.seedApprovedKnowledge({
          id: memory.id,
          type: memory.type,
          title: memory.title,
          content: memory.summary,
          scope: memory.scope,
          status: memory.status,
          is_constraint: ["synthetic-memory-package-manager", "synthetic-memory-release-gate"].includes(memory.id),
          provenance: {
            source_refs: [`synthetic-source:${memory.id}`],
            evidence_refs: [`synthetic-evidence:${memory.id}`],
            origin: "synthetic_demo",
          },
          expires_at: null,
          supersedes: [],
          conflicts: conflictsFor(memory, knowledge),
        });
        seededCount += 1;
      }
      const preview = core.previewSettings({ provider_consent: true });
      core.applySettings({
        proposal_hash: preview.proposal_hash,
        base_revision: preview.base_revision,
        idempotency_key: "synthetic-settings-provider-consent",
      });
    },

    async prepare({ scenario, host, runIndex }) {
      const ref = turnRef(scenario, host, runIndex);
      core.observe({
        ...ref,
        task_type: scenario.intent.task_type,
        goal_summary: scenario.intent.goal,
        idempotency_key: `synthetic-observe-${runIndex}`,
      });
      const failuresBefore = provider.failures;
      const packet = await core.prepare({
        ...ref,
        intent: scenario.intent,
        idempotency_key: `synthetic-prepare-${runIndex}`,
      });
      const key = `${scenario.id}\u0000${host}\u0000${runIndex}`;
      rawPackets.set(key, { packet, ref });
      const items = packetItems(packet);
      return {
        _key: key,
        retrieved_memory_ids: unique(items.map((item) => item.memory_id)),
        injected_constraint_ids: unique(packet.constraints.map((item) => item.memory_id)),
        conflict_memory_ids: unique(packet.conflicts.flatMap((conflict) => conflict.memory_ids)),
        estimated_tokens: packet.estimated_tokens,
        guidance_item_count: items.length,
        degraded: provider.failures > failuresBefore,
      };
    },

    async commitAndComplete({ scenario, planAfter, packet, completed, runIndex }) {
      const stored = rawPackets.get(packet._key);
      if (!stored) throw new Error(`Missing raw GuidancePacket for ${scenario.id}`);
      const items = packetItems(stored.packet);
      const required = new Set(scenario.expected.required_memory_ids);
      const ticket = core.commitPlan({
        ...stored.ref,
        packet_id: stored.packet.packet_id,
        revised_plan: {
          summary: `Synthetic revised plan for ${scenario.id}`,
          steps: planAfter,
          intended_tools: scenario.intent.intended_tools,
          target_paths: scenario.intent.target_paths,
        },
        adoption: items.map((item) => ({
          memory_id: item.memory_id,
          decision: required.has(item.memory_id) ? "adopted" : "ignored",
          reason: required.has(item.memory_id) ? "matched deterministic scenario" : "not needed for deterministic plan delta",
        })),
        idempotency_key: `synthetic-commit-${runIndex}`,
      });
      const gate = core.checkGate({
        ...stored.ref,
        action_name: "apply_patch",
        action_arguments: {},
        ticket: ticket.ticket,
        execution_epoch: ticket.execution_epoch,
        mode: "enforce",
        gateway_healthy: true,
      });
      if (!gate.allowed || gate.degraded) throw new Error(`Healthy deterministic gate was not allowed for ${scenario.id}`);
      core.complete({
        ...stored.ref,
        outcome_status: completed ? "succeeded" : "failed",
        outcome_summary: `Synthetic ${completed ? "successful" : "failed"} outcome for ${scenario.id}`,
        evidence_refs: [`synthetic-evidence:outcome:${scenario.id}`],
        learning_proposals: [],
        idempotency_key: `synthetic-complete-${runIndex}`,
      });
      rawPackets.delete(packet._key);
    },

    async seedBenchmarkMemories(total) {
      const missing = Math.max(0, total - seededCount);
      for (let index = 0; index < missing; index += 1) {
        const suffix = String(index).padStart(4, "0");
        await core.seedApprovedKnowledge({
          id: `synthetic-memory-benchmark-${suffix}`,
          type: index % 2 === 0 ? "experience" : "fact",
          title: `Synthetic benchmark shard ${suffix}`,
          content: `Deterministic benchmark retrieval memory shard ${suffix} for a synthetic performance workload.`,
          scope: "global",
          status: "approved",
          is_constraint: false,
          provenance: {
            source_refs: [`synthetic-source:benchmark:${suffix}`],
            evidence_refs: [`synthetic-evidence:benchmark:${suffix}`],
            origin: "synthetic_demo",
          },
          expires_at: null,
          supersedes: [],
          conflicts: [],
        });
      }
      seededCount += missing;
      const records = core.status().index.records;
      if (records !== total) throw new Error(`Benchmark expected ${total} indexed memories, observed ${records}`);
    },

    async prepareBenchmark({ iteration }) {
      const ref = {
        project_id: "synthetic-benchmark",
        host: "codex",
        session_id: "synthetic-session-benchmark",
        turn_id: `synthetic-turn-benchmark-${iteration}`,
      };
      const packet = await core.prepare({
        ...ref,
        intent: {
          goal: "Retrieve deterministic synthetic benchmark memory",
          task_type: "benchmark",
          planned_steps: ["inspect benchmark guidance"],
          intended_tools: ["filesystem-read"],
          target_paths: ["<SYNTHETIC_PROJECT>/benchmark"],
          constraints: [],
          assumptions: [],
          risk_flags: [],
        },
        idempotency_key: `synthetic-prepare-benchmark-${iteration}`,
      });
      if (packetItems(packet).length === 0) throw new Error("Benchmark prepare returned no guidance");
    },

    async close() {
      core.close();
    },
  };
}
