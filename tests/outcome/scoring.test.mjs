import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createEvaluationAdapter } from "./fixture-adapter.mjs";
import { scoreEvaluation } from "./scoring.mjs";

const fixtures = JSON.parse(readFileSync(new URL("./scenarios.v1.json", import.meta.url), "utf8"));

async function buildPassingRuns() {
  const adapter = await createEvaluationAdapter({ fixtures });
  const runs = [];
  for (const scenario of fixtures.scenarios) {
    for (const host of scenario.hosts) {
      const packet = await adapter.prepare({ scenario, host });
      runs.push({
        scenario_id: scenario.id,
        host,
        baseline_completed: scenario.baseline.completed,
        treatment_completed: scenario.expected.completed,
        plan_before: scenario.baseline.steps,
        plan_after: [...scenario.baseline.steps, ...scenario.expected.delta_steps],
        prepare_ms: 12,
        ...packet,
      });
    }
  }
  return runs;
}

test("the fixture catalog contains the exact M4 scenario distribution", () => {
  assert.equal(fixtures.scenarios.length, 8);
  const distribution = fixtures.scenarios.reduce((result, scenario) => {
    result[scenario.category] = (result[scenario.category] ?? 0) + 1;
    return result;
  }, {});
  assert.deepEqual(distribution, { relevant: 3, control: 3, conflict: 1, "provider-outage": 1 });
  assert.deepEqual(fixtures.scenarios[0].hosts, ["codex", "kimi-code", "deepseek-harness"]);
});
test("passing deterministic runs satisfy all thresholds", async () => {
  const report = scoreEvaluation(fixtures, await buildPassingRuns(), Array.from({ length: 50 }, (_, index) => 20 + index));
  assert.equal(report.status, "PASS", JSON.stringify(report.checks, null, 2));
  assert.equal(report.metrics.logical_scenarios, 8);
  assert.equal(report.metrics.executed_runs, 10);
  assert.equal(report.metrics.control_negative_migrations, 0);
  assert.equal(report.metrics.relevant_plan_delta_correct, 3);
});

test("wrong guidance on a control task is a negative migration and blocks the report", async () => {
  const runs = await buildPassingRuns();
  const control = runs.find((run) => run.scenario_id === "control-doc-tone-vs-sqlite");
  control.injected_constraint_ids.push("synthetic-memory-doc-tone");
  control.plan_after.push("apply editorial tone to the query planner");
  const report = scoreEvaluation(fixtures, runs, Array.from({ length: 50 }, () => 20));
  assert.equal(report.status, "FAIL");
  assert.equal(report.metrics.control_negative_migrations, 1);
  assert.equal(report.checks.find((check) => check.id === "control-negative-migration").status, "FAIL");
});

test("a timeout or missing prepare samples cannot become PASS", async () => {
  const report = scoreEvaluation(fixtures, await buildPassingRuns(), []);
  assert.equal(report.status, "FAIL");
  assert.equal(report.checks.find((check) => check.id === "prepare-p95").status, "FAIL");
});
