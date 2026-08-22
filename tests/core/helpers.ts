import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentCoachCore } from "../../src/core.js";
import type { CompleteInput, IntentEnvelope, LearningProposal, TurnRef } from "../../src/contracts.js";

export interface CoreFixture {
  root: string;
  home: string;
  knowledgeHome: string;
  core: AgentCoachCore;
  advance(milliseconds: number): void;
  cleanup(): Promise<void>;
}

export async function createCoreFixture(): Promise<CoreFixture> {
  const root = await mkdtemp(join(tmpdir(), "agent-coach-test-"));
  const home = join(root, "runtime");
  const knowledgeHome = join(root, "knowledge");
  let timestamp = Date.parse("2026-08-23T00:00:00.000Z");
  const core = await AgentCoachCore.create({ home, knowledgeHome, clock: () => new Date(timestamp) });
  const fixture: CoreFixture = {
    root,
    home,
    knowledgeHome,
    core,
    advance(milliseconds) { timestamp += milliseconds; },
    async cleanup() {
      fixture.core.close();
      await rm(root, { recursive: true, force: true });
    },
  };
  return fixture;
}

export function turn(suffix = "1", projectId = "project-alpha"): TurnRef {
  return {
    project_id: projectId,
    host: "synthetic-host",
    session_id: `session-${suffix}`,
    turn_id: `turn-${suffix}`,
  };
}

export function intent(goal = "Update the synthetic package safely", tools = ["apply_patch"]): IntentEnvelope {
  return {
    goal,
    task_type: "implementation",
    planned_steps: ["Inspect", "Change", "Verify"],
    intended_tools: tools,
    target_paths: ["synthetic/package.json"],
    constraints: ["Preserve unrelated settings"],
    assumptions: [],
    risk_flags: tools.includes("apply_patch") ? ["local write"] : [],
  };
}

export function proposal(type: LearningProposal["type"], overrides: Partial<LearningProposal> = {}): LearningProposal {
  const evidence = type === "procedure" ? ["synthetic:pass-1", "synthetic:pass-2"] : type === "fact" || type === "experience" ? ["synthetic:pass-1"] : [];
  return {
    proposal_id: `proposal-${type}`,
    type,
    title: `Synthetic ${type}`,
    summary: `Synthetic ${type} content with deterministic evidence.`,
    scope: "project:project-alpha",
    explicitness: type === "preference" ? "explicit" : "inferred",
    confidence: 0.9,
    source_refs: ["synthetic:turn"],
    evidence_refs: evidence,
    origin: "agent_proposal",
    ...overrides,
  };
}

export function completion(ref: TurnRef, proposals: LearningProposal[] = []): CompleteInput {
  return {
    ...ref,
    outcome_status: "succeeded",
    outcome_summary: "Synthetic task succeeded",
    evidence_refs: ["synthetic:outcome"],
    learning_proposals: proposals,
    idempotency_key: `complete-${ref.turn_id}`,
  };
}
