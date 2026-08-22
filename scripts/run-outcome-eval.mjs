#!/usr/bin/env node

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { scoreEvaluation } from "../tests/outcome/scoring.mjs";

const REPOSITORY_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

function parseArguments(argv) {
  const options = {
    adapter: "tests/outcome/core-adapter.mjs",
    fixtures: "tests/outcome/scenarios.v1.json",
    jsonOutput: ".artifacts/qa/outcome-report.json",
    markdownOutput: ".artifacts/qa/outcome-report.md",
    samples: 50,
    warmup: 10,
    allowFailures: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--adapter") options.adapter = argv[++index];
    else if (argument === "--fixtures") options.fixtures = argv[++index];
    else if (argument === "--json-output") options.jsonOutput = argv[++index];
    else if (argument === "--markdown-output") options.markdownOutput = argv[++index];
    else if (argument === "--samples") options.samples = Number(argv[++index]);
    else if (argument === "--warmup") options.warmup = Number(argv[++index]);
    else if (argument === "--allow-failures") options.allowFailures = true;
    else if (argument === "--help" || argument === "-h") {
      console.log("Usage: node scripts/run-outcome-eval.mjs [--adapter <module>] [--samples 50] [--warmup 10]");
      console.log("       [--json-output <file>] [--markdown-output <file>] [--allow-failures]");
      process.exit(0);
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!Number.isInteger(options.samples) || options.samples < 20) throw new Error("--samples must be an integer >= 20");
  if (!Number.isInteger(options.warmup) || options.warmup < 0) throw new Error("--warmup must be a non-negative integer");
  return options;
}

function includesAll(actual, expected) {
  const values = new Set(actual);
  return expected.every((value) => values.has(value));
}

function safeDiagnostic(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/file:\/\/[A-Za-z]:\/[^\s"']+/gi, "<LOCAL_FILE>")
    .replace(/\b[A-Za-z]:[\\/][^\r\n"']+/g, "<LOCAL_PATH>")
    .replace(/\/(?:home|Users)\/[^\s"']+/g, "<LOCAL_PATH>")
    .replace(/\b(Basic|Bearer)\s+[^\s"']+/gi, "$1 [REDACTED]")
    .replace(/\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]");
}

function outputPath(relativePath) {
  const absolutePath = resolve(REPOSITORY_ROOT, relativePath);
  const relation = relative(REPOSITORY_ROOT, absolutePath);
  if (relation === "" || relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new Error("Evaluation report outputs must be files inside the repository checkout");
  }
  return absolutePath;
}

function markdown(report) {
  const lines = [
    "# Agent Coach 确定性效果与性能报告",
    "",
    `状态：**${report.status}**`,
    "",
    `证据类型：\`${report.evidence_kind}\`。只有 \`CORE_RUNTIME\` 可作为产品验收证据；\`HARNESS_SELF_TEST\` 只证明评测器本身。`,
    "",
    "## 核心指标",
    "",
    "| 指标 | 结果 |",
    "|---|---:|",
    `| Baseline 完成率 | ${(report.metrics.baseline_completion_rate * 100).toFixed(1)}% |`,
    `| Treatment 完成率 | ${(report.metrics.treatment_completion_rate * 100).toFixed(1)}% |`,
    `| 相关任务正确 Plan Delta | ${report.metrics.relevant_plan_delta_correct}/${report.metrics.relevant_plan_delta_total} |`,
    `| 控制任务负迁移 | ${report.metrics.control_negative_migrations} |`,
    `| 1000 条合成记忆 prepare P50 | ${report.metrics.prepare_p50_ms ?? "N/A"} ms |`,
    `| 1000 条合成记忆 prepare P95 | ${report.metrics.prepare_p95_ms ?? "N/A"} ms |`,
    `| 1000 条合成记忆 prepare P99 | ${report.metrics.prepare_p99_ms ?? "N/A"} ms |`,
    `| 最大 Guidance 数 | ${report.metrics.max_guidance_items} |`,
    `| 最大估算 tokens | ${report.metrics.max_estimated_tokens} |`,
    "",
    "## 门禁",
    "",
    "| 检查 | 状态 | 实测 | 阈值 |",
    "|---|---|---:|---:|",
    ...report.checks.map((check) => `| ${check.id} | ${check.status} | ${String(check.observed)} | ${String(check.expected)} |`),
    "",
    "## 八场景",
    "",
    "| 场景 | 类别 | 宿主 | Treatment | Plan Delta | 负迁移 |",
    "|---|---|---|---|---|---|",
    ...report.scenarios.map(
      (scenario) =>
        `| ${scenario.id} | ${scenario.category} | ${scenario.hosts.join(" / ")} | ${scenario.treatment_completed ? "PASS" : "FAIL"} | ${scenario.plan_delta_correct ? "PASS" : "FAIL"} | ${scenario.negative_migration ? "FAIL" : "PASS"} |`,
    ),
    "",
    "生成命令：`node scripts/run-outcome-eval.mjs`。报告只包含合成 ID、聚合指标和耗时，不包含本机目录或运行凭据。",
    "",
  ];
  return lines.join("\n");
}

async function runScenario(adapter, scenario, host, runIndex) {
  const started = process.hrtime.bigint();
  const packet = await adapter.prepare({ scenario, host, runIndex });
  const prepareMs = Number(process.hrtime.bigint() - started) / 1_000_000;
  const retrieved = packet.retrieved_memory_ids ?? [];
  const conflicts = packet.conflict_memory_ids ?? [];
  const constraints = packet.injected_constraint_ids ?? [];
  const requiredRecall = includesAll(retrieved, scenario.expected.required_memory_ids);
  const requiredConflicts = includesAll(conflicts, scenario.expected.required_conflict_ids ?? []);
  const forbidden = constraints.some((id) => scenario.expected.forbidden_constraint_ids.includes(id));
  const canApplyExpectedDelta = requiredRecall && requiredConflicts && !forbidden;
  const planAfter = canApplyExpectedDelta
    ? [...scenario.baseline.steps, ...scenario.expected.delta_steps]
    : [...scenario.baseline.steps];
  const treatmentCompleted = scenario.category === "control"
    ? scenario.baseline.completed && !forbidden && planAfter.length === scenario.baseline.steps.length
    : scenario.expected.completed && canApplyExpectedDelta;

  await adapter.commitAndComplete?.({
    scenario,
    host,
    planAfter,
    packet,
    completed: treatmentCompleted,
    runIndex,
  });

  return {
    scenario_id: scenario.id,
    host,
    baseline_completed: scenario.baseline.completed,
    treatment_completed: treatmentCompleted,
    plan_before: scenario.baseline.steps,
    plan_after: planAfter,
    retrieved_memory_ids: retrieved,
    injected_constraint_ids: constraints,
    conflict_memory_ids: conflicts,
    prepare_ms: Number(prepareMs.toFixed(3)),
    guidance_item_count: packet.guidance_item_count ?? retrieved.length,
    estimated_tokens: packet.estimated_tokens ?? 0,
    degraded: packet.degraded ?? false,
  };
}

async function benchmark(adapter, warmup, samples) {
  await adapter.seedBenchmarkMemories(1000);
  const durations = [];
  for (let iteration = 0; iteration < warmup + samples; iteration += 1) {
    const started = process.hrtime.bigint();
    const result = await adapter.prepareBenchmark({ iteration });
    const measured = Number(process.hrtime.bigint() - started) / 1_000_000;
    if (iteration >= warmup) {
      durations.push(typeof result === "number" ? result : measured);
    }
  }
  return durations.map((value) => Number(value.toFixed(3)));
}

export async function runEvaluation(options) {
  const fixtures = JSON.parse(readFileSync(resolve(REPOSITORY_ROOT, options.fixtures), "utf8"));
  const adapterModule = await import(pathToFileURL(resolve(REPOSITORY_ROOT, options.adapter)).href);
  if (typeof adapterModule.createEvaluationAdapter !== "function") {
    throw new Error(`Adapter ${options.adapter} must export createEvaluationAdapter()`);
  }
  const temporaryHome = mkdtempSync(resolve(tmpdir(), "agent-coach-eval-"));
  let adapter;
  try {
    adapter = await adapterModule.createEvaluationAdapter({ fixtures, temporaryHome, repositoryRoot: REPOSITORY_ROOT });
    if (!adapter || typeof adapter.prepare !== "function") throw new Error("Evaluation adapter does not implement prepare()");
    await adapter.setup(fixtures.knowledge);
    const runs = [];
    let runIndex = 0;
    for (const scenario of fixtures.scenarios) {
      for (const host of scenario.hosts) {
        runs.push(await runScenario(adapter, scenario, host, runIndex++));
      }
    }
    const prepareSamples = await benchmark(adapter, options.warmup, options.samples);
    const scored = scoreEvaluation(fixtures, runs, prepareSamples);
    return {
      schema_version: "agent-coach/outcome-report/v1",
      evidence_kind: adapter.evidence_kind ?? "UNKNOWN",
      fixture_version: fixtures.schema_version,
      synthetic_memory_count: 1000,
      ...scored,
      status: adapter.evidence_kind === "CORE_RUNTIME" ? scored.status : "HARNESS_ONLY",
    };
  } finally {
    await adapter?.close?.();
    rmSync(temporaryHome, { force: true, recursive: true });
  }
}

async function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
    const report = await runEvaluation(options);
    const jsonPath = outputPath(options.jsonOutput);
    const markdownPath = outputPath(options.markdownOutput);
    if (jsonPath.toLowerCase() === markdownPath.toLowerCase()) {
      throw new Error("JSON and Markdown reports must use different output files");
    }
    mkdirSync(dirname(jsonPath), { recursive: true });
    mkdirSync(dirname(markdownPath), { recursive: true });
    writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    writeFileSync(markdownPath, markdown(report), "utf8");
    console.log(`Outcome evaluation ${report.status}: ${report.metrics.relevant_plan_delta_correct}/${report.metrics.relevant_plan_delta_total} relevant Plan Deltas, ${report.metrics.control_negative_migrations} negative migrations, prepare P95 ${report.metrics.prepare_p95_ms}ms.`);
    console.log(`Reports: ${options.jsonOutput}, ${options.markdownOutput}`);
    if (report.status !== "PASS" && !options.allowFailures) process.exitCode = 1;
  } catch (error) {
    console.error(`Outcome evaluation could not run: ${safeDiagnostic(error)}`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  await main();
}
