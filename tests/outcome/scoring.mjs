function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
  return Number(sorted[index].toFixed(3));
}

function includesAll(actual, expected) {
  const values = new Set(actual);
  return expected.every((value) => values.has(value));
}

function stepsIncludeAll(actual, expected) {
  const normalized = actual.map((step) => step.trim().toLowerCase());
  return expected.every((step) => normalized.includes(step.trim().toLowerCase()));
}

function unique(values) {
  return [...new Set(values)];
}

export function scoreEvaluation(fixtures, runs, prepareSamples) {
  const scenariosById = new Map(fixtures.scenarios.map((scenario) => [scenario.id, scenario]));
  const enrichedRuns = runs.map((run) => {
    const scenario = scenariosById.get(run.scenario_id);
    if (!scenario) throw new Error(`Unknown scenario result: ${run.scenario_id}`);
    const wrongConstraints = run.injected_constraint_ids.filter((id) =>
      scenario.expected.forbidden_constraint_ids.includes(id),
    );
    const requiredRecall = includesAll(run.retrieved_memory_ids, scenario.expected.required_memory_ids);
    const requiredConflicts = includesAll(run.conflict_memory_ids, scenario.expected.required_conflict_ids ?? []);
    const expectedDelta = stepsIncludeAll(run.plan_after, scenario.expected.delta_steps);
    const noUnexpectedDelta = scenario.expected.plan_delta_required || run.plan_after.length === run.plan_before.length;
    const planDeltaCorrect = requiredRecall && requiredConflicts && expectedDelta && noUnexpectedDelta && wrongConstraints.length === 0;
    const negativeMigration =
      scenario.category === "control" &&
      (wrongConstraints.length > 0 || run.plan_after.length !== run.plan_before.length || (run.baseline_completed && !run.treatment_completed));
    return {
      ...run,
      required_recall_satisfied: requiredRecall,
      required_conflicts_satisfied: requiredConflicts,
      wrong_constraint_ids: wrongConstraints,
      plan_delta_correct: planDeltaCorrect,
      negative_migration: negativeMigration,
    };
  });

  const logicalScenarios = fixtures.scenarios.map((scenario) => {
    const scenarioRuns = enrichedRuns.filter((run) => run.scenario_id === scenario.id);
    if (scenarioRuns.length === 0) throw new Error(`Missing result for scenario: ${scenario.id}`);
    const expectedHosts = new Set(scenario.hosts);
    const actualHosts = new Set(scenarioRuns.map((run) => run.host));
    return {
      id: scenario.id,
      category: scenario.category,
      hosts: scenarioRuns.map((run) => run.host),
      host_coverage: [...expectedHosts].every((host) => actualHosts.has(host)),
      baseline_completed: scenarioRuns.every((run) => run.baseline_completed),
      treatment_completed: scenarioRuns.every((run) => run.treatment_completed),
      plan_delta_correct: scenarioRuns.every((run) => run.plan_delta_correct),
      negative_migration: scenarioRuns.some((run) => run.negative_migration),
      degraded: scenarioRuns.some((run) => run.degraded),
      wrong_constraint_ids: unique(scenarioRuns.flatMap((run) => run.wrong_constraint_ids)),
      prepare_ms: scenarioRuns.map((run) => run.prepare_ms),
    };
  });

  const baselineCompleted = enrichedRuns.filter((run) => run.baseline_completed).length;
  const treatmentCompleted = enrichedRuns.filter((run) => run.treatment_completed).length;
  const relevantScenarios = logicalScenarios.filter((scenario) => scenario.category === "relevant");
  const controlScenarios = logicalScenarios.filter((scenario) => scenario.category === "control");
  const relevantCorrectPlanDelta = relevantScenarios.filter((scenario) => scenario.plan_delta_correct).length;
  const negativeMigrations = controlScenarios.filter((scenario) => scenario.negative_migration).length;
  const p95 = percentile(prepareSamples, 0.95);
  const maxGuidanceItems = Math.max(0, ...enrichedRuns.map((run) => run.guidance_item_count));
  const maxEstimatedTokens = Math.max(0, ...enrichedRuns.map((run) => run.estimated_tokens));
  const crossHost = logicalScenarios.find((scenario) => scenario.id === "relevant-cross-host-preference");
  const providerOutage = logicalScenarios.find((scenario) => scenario.id === "provider-outage-fallback");
  const conflict = logicalScenarios.find((scenario) => scenario.id === "conflict-isolation");

  const checks = [
    {
      id: "scenario-count",
      status: logicalScenarios.length === 8 ? "PASS" : "FAIL",
      observed: logicalScenarios.length,
      expected: 8,
    },
    {
      id: "treatment-completion-not-below-baseline",
      status: treatmentCompleted >= baselineCompleted ? "PASS" : "FAIL",
      observed: `${treatmentCompleted}/${enrichedRuns.length}`,
      expected: `>= ${baselineCompleted}/${enrichedRuns.length}`,
    },
    {
      id: "relevant-plan-delta",
      status: relevantCorrectPlanDelta >= fixtures.thresholds.relevant_plan_delta_minimum ? "PASS" : "FAIL",
      observed: `${relevantCorrectPlanDelta}/${relevantScenarios.length}`,
      expected: `>= ${fixtures.thresholds.relevant_plan_delta_minimum}/${fixtures.thresholds.relevant_scenario_count}`,
    },
    {
      id: "control-negative-migration",
      status: negativeMigrations <= fixtures.thresholds.control_negative_migration_maximum ? "PASS" : "FAIL",
      observed: negativeMigrations,
      expected: `<= ${fixtures.thresholds.control_negative_migration_maximum}`,
    },
    {
      id: "cross-host-preference",
      status: crossHost?.host_coverage && crossHost.plan_delta_correct ? "PASS" : "FAIL",
      observed: crossHost?.hosts.join(",") ?? "missing",
      expected: "codex,kimi-code,deepseek-harness",
    },
    {
      id: "conflict-isolation",
      status: conflict?.plan_delta_correct && conflict.wrong_constraint_ids.length === 0 ? "PASS" : "FAIL",
      observed: conflict?.plan_delta_correct ?? false,
      expected: true,
    },
    {
      id: "provider-outage-fallback",
      status: providerOutage?.treatment_completed && providerOutage.plan_delta_correct && providerOutage.degraded ? "PASS" : "FAIL",
      observed: `completed=${providerOutage?.treatment_completed ?? false}, degraded=${providerOutage?.degraded ?? false}`,
      expected: "completed=true, degraded=true",
    },
    {
      id: "prepare-p95",
      status: p95 !== null && p95 <= fixtures.thresholds.prepare_p95_ms_maximum ? "PASS" : "FAIL",
      observed: p95,
      expected: `<= ${fixtures.thresholds.prepare_p95_ms_maximum}ms`,
    },
    {
      id: "guidance-item-budget",
      status: maxGuidanceItems <= fixtures.thresholds.guidance_items_maximum ? "PASS" : "FAIL",
      observed: maxGuidanceItems,
      expected: `<= ${fixtures.thresholds.guidance_items_maximum}`,
    },
    {
      id: "guidance-token-budget",
      status: maxEstimatedTokens <= fixtures.thresholds.estimated_tokens_maximum ? "PASS" : "FAIL",
      observed: maxEstimatedTokens,
      expected: `<= ${fixtures.thresholds.estimated_tokens_maximum}`,
    },
  ];

  return {
    status: checks.every((check) => check.status === "PASS") ? "PASS" : "FAIL",
    metrics: {
      logical_scenarios: logicalScenarios.length,
      executed_runs: enrichedRuns.length,
      baseline_completion_rate: Number((baselineCompleted / enrichedRuns.length).toFixed(4)),
      treatment_completion_rate: Number((treatmentCompleted / enrichedRuns.length).toFixed(4)),
      relevant_plan_delta_correct: relevantCorrectPlanDelta,
      relevant_plan_delta_total: relevantScenarios.length,
      control_negative_migrations: negativeMigrations,
      prepare_samples: prepareSamples.length,
      prepare_p50_ms: percentile(prepareSamples, 0.5),
      prepare_p95_ms: p95,
      prepare_p99_ms: percentile(prepareSamples, 0.99),
      max_guidance_items: maxGuidanceItems,
      max_estimated_tokens: maxEstimatedTokens,
    },
    checks,
    scenarios: logicalScenarios,
    runs: enrichedRuns,
  };
}
