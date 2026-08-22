#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { AgentCoachCore } from "./core.js";
import { gatewayRequest } from "./client/gateway-client.js";
import { runSyntheticDemo, seedDemoConflict } from "./demo.js";
import { defaultDataHome, defaultKnowledgeHome, permissionStatus } from "./paths.js";
import { AgentCoachGateway } from "./server/gateway.js";
import { opaqueId } from "./utils.js";

interface CliIo {
  out(value: string): void;
  error(value: string): void;
}

const defaultIo: CliIo = {
  out: (value) => process.stdout.write(`${value}\n`),
  error: (value) => process.stderr.write(`${value}\n`),
};

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function has(args: string[], name: string): boolean {
  return args.includes(name);
}

function positionals(args: string[]): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index]?.startsWith("--")) {
      if (!["--json", "--apply"].includes(args[index]!)) index += 1;
      continue;
    }
    values.push(args[index]!);
  }
  return values;
}

function output(io: CliIo, value: unknown, asJson: boolean): void {
  if (asJson || typeof value !== "string") io.out(JSON.stringify(value, null, 2));
  else io.out(value);
}

function usage(): string {
  return `Agent Coach 0.1.0

Usage: agent-coach <command> [options]

Commands:
  init                 Initialize private runtime and knowledge directories
  start                Start the authenticated loopback Gateway
  status               Read Gateway and learning health
  demo                 Run the deterministic synthetic Demo Host
  doctor               Check Node, SQLite/FTS, permissions, and Gateway
  search <query>       Search approved knowledge
  review               List inactive learning candidates
  approve <id>         Exact-preview and approve a candidate
  reject <id>          Reject a candidate (--reason <text>)
  forget <id>          Preview deletion; add --apply to execute
  export               Export redacted state (--output <file>)
  reset <mode>         Preview index|operational|candidates|all; add --apply
  provider <action>    status|enable|disable
  integrations         List host integration states

Global options: --home <dir> --knowledge-home <dir> --json`;
}

async function gatewayOnline(home: string): Promise<boolean> {
  try {
    await gatewayRequest("/v1/health", { home, timeoutMs: 400 });
    return true;
  } catch {
    return false;
  }
}

export async function runCli(args: string[], io: CliIo = defaultIo): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    io.out(usage());
    return 0;
  }
  const [command = "help"] = positionals(args);
  const rest = args.slice(args.indexOf(command) + 1);
  const home = flag(args, "--home") ?? defaultDataHome();
  const knowledgeHome = flag(args, "--knowledge-home") ?? defaultKnowledgeHome(home);
  const asJson = has(args, "--json");

  if (["help", "--help", "-h"].includes(command)) {
    io.out(usage());
    return 0;
  }
  if (command === "init") {
    const core = await AgentCoachCore.create({ home, knowledgeHome });
    const status = core.status();
    core.close();
    output(io, { initialized: true, home, knowledge_home: knowledgeHome, ...status }, asJson);
    return 0;
  }
  if (command === "start") {
    const core = await AgentCoachCore.create({ home, knowledgeHome });
    const gateway = await AgentCoachGateway.start(core);
    const dashboard = await gateway.issueDashboardBootstrap();
    output(io, {
      started: true,
      ...gateway.discovery,
      token_permission: gateway.tokenPermission,
      dashboard_url: dashboard.url,
      dashboard_url_expires_at: dashboard.expires_at,
    }, asJson);
    await new Promise<void>((resolvePromise) => {
      const stop = () => resolvePromise();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
    await gateway.close();
    core.close();
    return 0;
  }
  if (command === "status") {
    try {
      output(io, await gatewayRequest("/v1/health", { home }), asJson);
      return 0;
    } catch (error) {
      output(io, { state: "stopped", degraded: true, detail: error instanceof Error ? error.message : "Gateway unavailable" }, true);
      return 1;
    }
  }
  if (command === "demo") {
    let core: AgentCoachCore | undefined;
    let gateway: AgentCoachGateway | undefined;
    if (!(await gatewayOnline(home))) {
      core = await AgentCoachCore.create({ home, knowledgeHome });
      await seedDemoConflict(core);
      gateway = await AgentCoachGateway.start(core);
    }
    try {
      output(io, await runSyntheticDemo(home), true);
    } finally {
      await gateway?.close();
      core?.close();
    }
    return 0;
  }
  if (command === "doctor") {
    const [nodeMajor = 0, nodeMinor = 0, nodePatch = 0] = process.versions.node
      .split(".")
      .map((part) => Number(part));
    const nodeSupported = nodeMajor === 24 && (nodeMinor > 15 || (nodeMinor === 15 && nodePatch >= 0));
    const core = await AgentCoachCore.create({ home, knowledgeHome });
    const tokenPermission = await permissionStatus(core.paths.token);
    const report = {
      node: { version: process.versions.node, status: nodeSupported ? "verified" : "unsupported" },
      sqlite: core.knowledge.status(),
      data_home_outside_source: true,
      token_permission: tokenPermission,
      gateway: { running: await gatewayOnline(home) },
      provider: { id: core.provider.id, enabled: core.provider.enabled },
    };
    core.close();
    output(io, report, true);
    return nodeSupported ? 0 : 1;
  }
  if (command === "search") {
    const queryText = positionals(rest).join(" ");
    if (!queryText) throw new Error("search requires a query");
    const query = new URLSearchParams({ query: queryText });
    const projectId = flag(args, "--project");
    if (projectId) query.set("project_id", projectId);
    output(io, await gatewayRequest(`/v1/knowledge/search?${query.toString()}`, { home }), true);
    return 0;
  }
  if (command === "review") {
    output(io, await gatewayRequest("/v1/candidates?status=candidate", { home }), true);
    return 0;
  }
  if (command === "approve") {
    const candidateId = positionals(rest)[0];
    if (!candidateId) throw new Error("approve requires a candidate id");
    const preview = await gatewayRequest<Record<string, unknown>>(`/v1/candidates/${encodeURIComponent(candidateId)}/preview`, { home, method: "POST", body: {} });
    const result = await gatewayRequest(`/v1/candidates/${encodeURIComponent(candidateId)}/approve`, {
      home,
      method: "POST",
      body: { proposal_hash: preview.proposal_hash, base_revision: preview.base_revision, idempotency_key: opaqueId("cli") },
    });
    output(io, { preview, result }, true);
    return 0;
  }
  if (command === "reject") {
    const candidateId = positionals(rest)[0];
    if (!candidateId) throw new Error("reject requires a candidate id");
    output(io, await gatewayRequest(`/v1/candidates/${encodeURIComponent(candidateId)}/reject`, {
      home,
      method: "POST",
      body: { reason: flag(args, "--reason") ?? "Rejected by user", idempotency_key: opaqueId("cli") },
    }), true);
    return 0;
  }
  if (command === "forget") {
    const memoryId = positionals(rest)[0];
    if (!memoryId) throw new Error("forget requires a memory id");
    const preview = await gatewayRequest<Record<string, unknown>>("/v1/privacy/forget/preview", { home, method: "POST", body: { memory_id: memoryId } });
    if (!has(args, "--apply")) {
      output(io, { preview, next: "Repeat with --apply to execute" }, true);
      return 0;
    }
    output(io, await gatewayRequest("/v1/privacy/forget/apply", {
      home,
      method: "POST",
      body: { memory_id: memoryId, proposal_hash: preview.proposal_hash, base_revision: preview.base_revision, idempotency_key: opaqueId("cli") },
    }), true);
    return 0;
  }
  if (command === "export") {
    const exported = await gatewayRequest<Record<string, unknown>>("/v1/privacy/export", { home, method: "POST", body: {} });
    const destination = flag(args, "--output");
    if (destination) {
      await writeFile(destination, `${JSON.stringify(exported, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      output(io, { exported: true, output: destination }, true);
    } else output(io, exported, true);
    return 0;
  }
  if (command === "reset") {
    const mode = (positionals(rest)[0] ?? "index") as "index" | "operational" | "candidates" | "all";
    if (!["index", "operational", "candidates", "all"].includes(mode)) throw new Error("reset mode must be index, operational, candidates, or all");
    const preview = await gatewayRequest<Record<string, unknown>>("/v1/privacy/reset/preview", { home, method: "POST", body: { mode } });
    if (!has(args, "--apply")) {
      output(io, { preview, next: "Repeat with --apply to execute" }, true);
      return 0;
    }
    output(io, await gatewayRequest("/v1/privacy/reset/apply", {
      home,
      method: "POST",
      body: { mode, proposal_hash: preview.proposal_hash, base_revision: preview.base_revision, idempotency_key: opaqueId("cli") },
    }), true);
    return 0;
  }
  if (command === "provider") {
    const action = positionals(rest)[0] ?? "status";
    if (action === "status") {
      output(io, await gatewayRequest("/v1/providers", { home }), true);
      return 0;
    }
    if (!["enable", "disable"].includes(action)) throw new Error("provider action must be status, enable, or disable");
    const id = flag(args, "--id") ?? "tencentdb-agent-memory";
    const previewEnvelope = await gatewayRequest<{ preview: Record<string, unknown> }>(`/v1/providers/${encodeURIComponent(id)}/${action}/preview`, { home, method: "POST", body: {} });
    output(io, await gatewayRequest(`/v1/providers/${encodeURIComponent(id)}/${action}/apply`, {
      home,
      method: "POST",
      body: { proposal_hash: previewEnvelope.preview.proposal_hash, base_revision: previewEnvelope.preview.base_revision, idempotency_key: opaqueId("cli") },
    }), true);
    return 0;
  }
  if (command === "integrations") {
    output(io, await gatewayRequest("/v1/integrations", { home }), true);
    return 0;
  }
  io.error(`Unknown command: ${command}`);
  io.out(usage());
  return 2;
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entry) {
  runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    process.stderr.write(`agent-coach: ${error instanceof Error ? error.message : "command failed"}\n`);
    process.exitCode = 1;
  });
}
