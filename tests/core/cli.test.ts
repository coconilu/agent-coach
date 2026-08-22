import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../../src/cli.js";
import { AgentCoachCore } from "../../src/core.js";
import { AgentCoachGateway } from "../../src/server/gateway.js";

function collector() {
  const out: string[] = [];
  const errors: string[] = [];
  return { out, errors, io: { out: (value: string) => out.push(value), error: (value: string) => errors.push(value) } };
}

describe("CLI command surface", () => {
  const roots: string[] = [];
  afterEach(async () => {
    while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
  });

  it("never executes a side-effecting subcommand when --help is present", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-coach-cli-help-"));
    roots.push(root);
    const home = join(root, "runtime");
    const collected = collector();
    expect(await runCli(["start", "--help", "--home", home], collected.io)).toBe(0);
    expect(collected.out.join("\n")).toContain("Usage:");
    await expect(access(home)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("initializes and runs the deterministic synthetic demo without a pre-existing daemon", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-coach-cli-demo-"));
    roots.push(root);
    const home = join(root, "runtime");
    const knowledge = join(root, "knowledge");
    const initOutput = collector();
    expect(await runCli(["init", "--home", home, "--knowledge-home", knowledge, "--json"], initOutput.io)).toBe(0);
    expect(JSON.parse(initOutput.out[0]!)).toMatchObject({ initialized: true, state: "ready" });

    const demoOutput = collector();
    expect(await runCli(["demo", "--home", home, "--knowledge-home", knowledge, "--json"], demoOutput.io)).toBe(0);
    const result = JSON.parse(demoOutput.out[0]!) as { scenarios: Array<{ name: string; status: string }>; summary: { passed: number } };
    expect(result.scenarios.map((scenario) => scenario.name)).toEqual([
      "pure-question",
      "read-only",
      "side-effect-handshake",
      "conflict-isolation",
      "provider-outage-fallback",
    ]);
    expect(result.summary.passed).toBe(5);
  });

  it("covers status/search/review/reject/forget/export/reset/provider/integrations through HTTP", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-coach-cli-live-"));
    roots.push(root);
    const home = join(root, "runtime");
    const knowledge = join(root, "knowledge");
    const core = await AgentCoachCore.create({ home, knowledgeHome: knowledge });
    await core.seedApprovedKnowledge({
      id: "mem_cli_synthetic",
      type: "fact",
      title: "CLI synthetic marker",
      content: "Search and forget this synthetic marker.",
      scope: "global",
      status: "approved",
      is_constraint: false,
      provenance: { source_refs: ["synthetic:cli"], evidence_refs: ["hash:cli"], origin: "synthetic_demo" },
      expires_at: null,
      supersedes: [],
      conflicts: [],
    });
    const ref = { project_id: "synthetic-project-cli", host: "demo", session_id: "synthetic-session-cli", turn_id: "synthetic-turn-cli" };
    core.observe({ ...ref, task_type: "question", goal_summary: "synthetic", idempotency_key: "synthetic-observe-cli" });
    core.complete({
      ...ref,
      outcome_status: "succeeded",
      outcome_summary: "synthetic",
      evidence_refs: [],
      learning_proposals: [
        {
          proposal_id: "synthetic-proposal-cli",
          type: "preference",
          title: "CLI candidate",
          summary: "Synthetic candidate for CLI review and rejection.",
          scope: "project:synthetic-project-cli",
          explicitness: "explicit",
          confidence: 1,
          source_refs: ["synthetic:cli-turn"],
          evidence_refs: [],
          origin: "agent_proposal",
        },
        {
          proposal_id: "synthetic-proposal-cli-approve",
          type: "fact",
          title: "CLI approval candidate",
          summary: "Synthetic candidate for CLI exact preview and approval.",
          scope: "project:synthetic-project-cli",
          explicitness: "explicit",
          confidence: 1,
          source_refs: ["synthetic:cli-turn"],
          evidence_refs: ["hash:synthetic-cli"],
          origin: "agent_proposal",
        },
      ],
      idempotency_key: "synthetic-complete-cli",
    });
    const candidateId = core.listCandidates().find((candidate) => candidate.type === "preference")!.id;
    const approvalId = core.listCandidates().find((candidate) => candidate.type === "fact")!.id;
    const gateway = await AgentCoachGateway.start(core);
    try {
      for (const args of [
        ["status"],
        ["search", "CLI synthetic"],
        ["review"],
        ["integrations"],
        ["provider", "status"],
        ["provider", "enable"],
        ["provider", "disable"],
        ["reset", "index"],
        ["doctor"],
      ]) {
        const collected = collector();
        expect(await runCli([...args, "--home", home, "--json"], collected.io), args.join(" ")).toBe(0);
        expect(() => JSON.parse(collected.out[0]!)).not.toThrow();
      }

      const approveOutput = collector();
      expect(await runCli(["approve", approvalId, "--home", home], approveOutput.io)).toBe(0);
      expect(JSON.parse(approveOutput.out[0]!).result.candidate).toMatchObject({ status: "approved" });

      const resetOutput = collector();
      expect(await runCli(["reset", "index", "--apply", "--home", home], resetOutput.io)).toBe(0);
      expect(JSON.parse(resetOutput.out[0]!)).toMatchObject({ status: "complete", mode: "index" });

      const rejectOutput = collector();
      expect(await runCli(["reject", candidateId, "--reason", "synthetic rejection", "--home", home], rejectOutput.io)).toBe(0);
      expect(JSON.parse(rejectOutput.out[0]!)).toMatchObject({ status: "rejected" });

      const forgetPreview = collector();
      expect(await runCli(["forget", "mem_cli_synthetic", "--home", home], forgetPreview.io)).toBe(0);
      expect(JSON.parse(forgetPreview.out[0]!)).toHaveProperty("next");
      const forgetApply = collector();
      expect(await runCli(["forget", "mem_cli_synthetic", "--apply", "--home", home], forgetApply.io)).toBe(0);
      expect(JSON.parse(forgetApply.out[0]!)).toMatchObject({ status: "complete" });

      const destination = join(root, "synthetic-export.json");
      const exportOutput = collector();
      expect(await runCli(["export", "--home", home, "--output", destination], exportOutput.io)).toBe(0);
      expect(JSON.parse(await readFile(destination, "utf8"))).toHaveProperty("state");
    } finally {
      await gateway.close();
      core.close();
    }
  });
});
