import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { AgentCoachCore } from "../core.js";
import { CoachError, asCoachError, publicError } from "../errors.js";
import { addMilliseconds, canonicalJson, opaqueId, safeSecretEqual, secret, sha256 } from "../utils.js";
import { turnKey } from "../storage/state-store.js";

const execFileAsync = promisify(execFile);
const BODY_LIMIT = 1_000_000;
const SESSION_TTL_MS = 8 * 60 * 60 * 1_000;
const BOOTSTRAP_TTL_MS = 2 * 60 * 1_000;

export interface GatewayDiscoveryV1 {
  protocol_version: "agent-coach/gateway-v1";
  origin: string;
  pid: number;
  instance_id: string;
  token_file: string;
  started_at: string;
}

export interface GatewayOptions {
  host?: "127.0.0.1" | "::1";
  port?: number;
  dashboardRoot?: string;
  bearerSecret?: string;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function securityHeaders(response: ServerResponse): void {
  response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Cache-Control", "no-store");
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  securityHeaders(response);
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(value));
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > BODY_LIMIT) throw new CoachError("VALIDATION_ERROR", "Request body exceeds 1 MB");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readBody(request);
  if (body.length === 0) return {};
  try {
    const value = JSON.parse(body.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("JSON object required");
    }
    return value as Record<string, unknown>;
  } catch {
    throw new CoachError("VALIDATION_ERROR", "Request body must be a valid JSON object");
  }
}

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  return Object.fromEntries(
    header.split(";").map((part) => {
      const [key, ...value] = part.trim().split("=");
      return [key ?? "", decodeURIComponent(value.join("="))];
    }).filter(([key]) => Boolean(key)),
  );
}

async function atomicWrite(path: string, content: string, mode: number): Promise<void> {
  await mkdir(resolve(path, ".."), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, content, { encoding: "utf8", mode });
  await rename(temporary, path);
  if (process.platform !== "win32") await chmod(path, mode);
}

async function hardenWindowsFile(path: string): Promise<boolean> {
  if (process.platform !== "win32") return true;
  const account = process.env.USERDOMAIN && process.env.USERNAME
    ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}`
    : process.env.USERNAME;
  if (!account) return false;
  try {
    await execFileAsync("icacls.exe", [path, "/inheritance:r", "/grant:r", `${account}:(R,W)`], {
      windowsHide: true,
      timeout: 5_000,
    });
    return true;
  } catch {
    return false;
  }
}

export class AgentCoachGateway {
  private readonly server: HttpServer;
  private readonly instanceId = opaqueId("gateway");
  private readonly dashboardRoots: string[];
  private bearer: string;
  private origin = "";
  private startedAt = "";
  private closed = false;
  private tokenPermissionHardened = false;

  private constructor(
    readonly core: AgentCoachCore,
    private readonly options: GatewayOptions,
  ) {
    this.bearer = options.bearerSecret ?? secret(48);
    this.dashboardRoots = [...new Set([
      process.env.AGENT_COACH_DASHBOARD_DIR,
      options.dashboardRoot,
      join(process.cwd(), "dashboard", "dist"),
      fileURLToPath(new URL("../dashboard/", import.meta.url)),
    ].filter((value): value is string => Boolean(value)).map((value) => resolve(value)))];
    this.server = createServer((request, response) => {
      void this.route(request, response);
    });
  }

  static async start(core: AgentCoachCore, options: GatewayOptions = {}): Promise<AgentCoachGateway> {
    const gateway = new AgentCoachGateway(core, options);
    await gateway.listen();
    return gateway;
  }

  get discovery(): GatewayDiscoveryV1 {
    return {
      protocol_version: "agent-coach/gateway-v1",
      origin: this.origin,
      pid: process.pid,
      instance_id: this.instanceId,
      token_file: basename(this.core.paths.token),
      started_at: this.startedAt,
    };
  }

  get tokenPermission(): "owner-only" | "degraded" {
    return this.tokenPermissionHardened ? "owner-only" : "degraded";
  }

  private async listen(): Promise<void> {
    const host = this.options.host ?? "127.0.0.1";
    if (host !== "127.0.0.1" && host !== "::1") {
      throw new CoachError("VALIDATION_ERROR", "Gateway must listen on a loopback address");
    }
    await new Promise<void>((resolvePromise, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.options.port ?? 0, host, () => {
        this.server.off("error", reject);
        resolvePromise();
      });
    });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("Gateway did not expose a TCP address");
    this.origin = `http://${host === "::1" ? "[::1]" : host}:${address.port}`;
    this.startedAt = new Date().toISOString();
    await atomicWrite(this.core.paths.token, `${this.bearer}\n`, 0o600);
    this.tokenPermissionHardened = await hardenWindowsFile(this.core.paths.token);
    await atomicWrite(this.core.paths.discovery, `${JSON.stringify(this.discovery, null, 2)}\n`, 0o600);
  }

  async rotateSecret(): Promise<void> {
    this.bearer = secret(48);
    await atomicWrite(this.core.paths.token, `${this.bearer}\n`, 0o600);
    this.tokenPermissionHardened = await hardenWindowsFile(this.core.paths.token);
  }

  async issueDashboardBootstrap(): Promise<{ url: string; expires_at: string }> {
    const nonce = secret(32);
    const expiresAt = addMilliseconds(new Date().toISOString(), BOOTSTRAP_TTL_MS);
    this.core.state.saveBrowserNonce(sha256(nonce), expiresAt);
    return { url: `${this.origin}/bootstrap?nonce=${encodeURIComponent(nonce)}`, expires_at: expiresAt };
  }

  private isAllowedHost(request: IncomingMessage): boolean {
    try {
      const expected = new URL(this.origin);
      const host = request.headers.host?.toLowerCase();
      return host === expected.host.toLowerCase();
    } catch {
      return false;
    }
  }

  private bearerAuthenticated(request: IncomingMessage): boolean {
    const header = request.headers.authorization;
    return Boolean(header?.startsWith("Bearer ") && safeSecretEqual(header.slice(7), this.bearer));
  }

  private browserSession(request: IncomingMessage): { authenticated: boolean; csrfHash?: string } {
    const cookie = parseCookies(request.headers.cookie).agent_coach_session;
    if (!cookie) return { authenticated: false };
    const session = this.core.state.getBrowserSession(sha256(cookie), new Date().toISOString());
    return session ? { authenticated: true, csrfHash: session.csrf_hash } : { authenticated: false };
  }

  private dashboardCsrf(request: IncomingMessage): string | null {
    const csrf = parseCookies(request.headers.cookie).agent_coach_csrf;
    if (!csrf || !/^[A-Za-z0-9_-]+$/.test(csrf)) return null;
    const session = this.browserSession(request);
    if (!session.authenticated || !session.csrfHash || !safeSecretEqual(sha256(csrf), session.csrfHash)) {
      return null;
    }
    return csrf;
  }

  private authorize(request: IncomingMessage, mutation: boolean): "bearer" | "browser" {
    if (this.bearerAuthenticated(request)) return "bearer";
    const session = this.browserSession(request);
    if (!session.authenticated) throw new CoachError("UNAUTHORIZED", "Authentication required");
    if (mutation) {
      if (!this.isAllowedHost(request) || request.headers.origin !== this.origin) {
        throw new CoachError("CSRF_REJECTED", "Mutation Origin or Host is not allowed");
      }
      const csrf = request.headers["x-agent-coach-csrf"];
      if (typeof csrf !== "string" || !session.csrfHash || sha256(csrf) !== session.csrfHash) {
        throw new CoachError("CSRF_REJECTED", "CSRF token is missing or invalid");
      }
    }
    return "browser";
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (!request.url || !request.method) throw new CoachError("VALIDATION_ERROR", "Malformed HTTP request");
      if (request.method === "OPTIONS") {
        securityHeaders(response);
        response.statusCode = 403;
        response.end();
        return;
      }
      const url = new URL(request.url, this.origin);
      if (url.pathname === "/bootstrap" && request.method === "GET") {
        if (!this.isAllowedHost(request)) throw new CoachError("CSRF_REJECTED", "Invalid Host");
        const nonce = url.searchParams.get("nonce");
        if (!nonce) throw new CoachError("UNAUTHORIZED", "Bootstrap nonce required");
        await this.bootstrap(response, nonce);
        return;
      }
      if (url.pathname.startsWith("/v1/")) {
        const mutation = !["GET", "HEAD"].includes(request.method);
        this.authorize(request, mutation);
        await this.api(request, response, url);
        return;
      }
      if (url.pathname.startsWith("/api/")) {
        const mutation = !["GET", "HEAD"].includes(request.method);
        this.authorize(request, mutation);
        await this.dashboardApi(request, response, url);
        return;
      }
      await this.serveDashboard(response, url.pathname, this.dashboardCsrf(request));
    } catch (error) {
      const safe = asCoachError(error);
      sendJson(response, safe.status, publicError(safe));
    }
  }

  private async bootstrap(response: ServerResponse, nonce: string): Promise<void> {
    const now = new Date().toISOString();
    if (!this.core.state.consumeBrowserNonce(sha256(nonce), now)) {
      throw new CoachError("UNAUTHORIZED", "Bootstrap nonce is invalid, expired, or already used");
    }
    const session = secret(32);
    const csrf = secret(32);
    this.core.state.saveBrowserSession(sha256(session), sha256(csrf), addMilliseconds(now, SESSION_TTL_MS), now);
    securityHeaders(response);
    response.statusCode = 302;
    response.setHeader("Set-Cookie", [
      `agent_coach_session=${encodeURIComponent(session)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`,
      `agent_coach_csrf=${encodeURIComponent(csrf)}; SameSite=Strict; Path=/; Max-Age=28800`,
    ]);
    response.setHeader("Location", "/");
    response.end();
  }

  private async api(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const method = request.method!;
    const path = url.pathname;
    if (method === "GET" && path === "/v1/health") {
      sendJson(response, 200, {
        ...this.core.status(),
        gateway: { origin: this.origin, loopback: true, token_permission: this.tokenPermission },
      });
      return;
    }
    if (method === "POST" && path === "/v1/dashboard/bootstrap-token") {
      sendJson(response, 200, await this.issueDashboardBootstrap());
      return;
    }
    if (method === "GET" && path === "/v1/dashboard/overview") {
      sendJson(response, 200, {
        ...this.core.state.dashboardOverview(),
        knowledge: this.core.knowledge.status(),
        provider: { id: this.core.provider.id, enabled: this.core.provider.enabled },
        settings: this.core.getSettings(),
      });
      return;
    }
    if (method === "GET" && path === "/v1/turns") {
      sendJson(response, 200, { items: this.core.state.listTurns(Number(url.searchParams.get("limit") ?? 100)) });
      return;
    }
    if (method === "GET" && path === "/v1/audit") {
      sendJson(response, 200, { items: this.core.state.listAudit(Number(url.searchParams.get("limit") ?? 100)) });
      return;
    }
    if (method === "POST" && path === "/v1/turns/observe") {
      const body = await readJson(request);
      if (body.resolve_active_turn === true) {
        const host = String(body.host ?? "");
        const sessionId = String(body.session_id ?? "");
        if (!host || !sessionId) {
          throw new CoachError("VALIDATION_ERROR", "resolve_active_turn requires host and session_id");
        }
        const active = this.core.state.findUnfinishedTurns(host, sessionId, new Date().toISOString());
        if (active.length === 0) throw new CoachError("TURN_NOT_FOUND", "No unexpired unfinished turn matches this host session");
        if (active.length !== 1) throw new CoachError("CONFLICT", "Multiple unfinished turns match this host session; an explicit turn_id is required");
        body.project_id = active[0]!.project_id;
        body.turn_id = active[0]!.turn_id;
      }
      sendJson(response, 201, this.core.observe(body as never));
      return;
    }
    if (method === "POST" && path === "/v1/turns/prepare") {
      sendJson(response, 201, await this.core.prepare(await readJson(request) as never));
      return;
    }
    const commitMatch = path.match(/^\/v1\/turns\/([^/]+)\/commit$/);
    if (method === "POST" && commitMatch) {
      const body = await readJson(request);
      if (![turnKey(body as never), String(body.turn_id ?? "")].includes(decodeURIComponent(commitMatch[1]!))) {
        throw new CoachError("TURN_NOT_FOUND", "Turn path and identity do not match");
      }
      sendJson(response, 201, this.core.commitPlan(body as never));
      return;
    }
    const completeMatch = path.match(/^\/v1\/turns\/([^/]+)\/complete$/);
    if (method === "POST" && completeMatch) {
      const body = await readJson(request);
      if (![turnKey(body as never), String(body.turn_id ?? "")].includes(decodeURIComponent(completeMatch[1]!))) {
        throw new CoachError("TURN_NOT_FOUND", "Turn path and identity do not match");
      }
      sendJson(response, 201, this.core.complete(body as never));
      return;
    }
    if (method === "POST" && path === "/v1/gates/check") {
      const body = await readJson(request);
      if (body.resolve_active_turn === true) {
        const host = String(body.host ?? "");
        const sessionId = String(body.session_id ?? "");
        if (!host || !sessionId) {
          throw new CoachError("VALIDATION_ERROR", "resolve_active_turn requires host and session_id");
        }
        const active = this.core.state.findUnfinishedTurns(host, sessionId, new Date().toISOString());
        if (active.length === 0) {
          throw new CoachError("ACTION_REQUIRES_COACHING", "No unexpired unfinished turn matches this host session");
        }
        if (active.length !== 1) {
          throw new CoachError("CONFLICT", "Multiple unfinished turns match this host session; an explicit turn_id is required");
        }
        body.project_id = active[0]!.project_id;
        body.turn_id = active[0]!.turn_id;
      }
      sendJson(response, 200, this.core.checkGate(body as never));
      return;
    }
    if (method === "POST" && path === "/v1/feedback") {
      sendJson(response, 201, this.core.feedback(await readJson(request) as never));
      return;
    }
    if (method === "POST" && path === "/v1/explain") {
      sendJson(response, 200, await this.core.explain(await readJson(request)));
      return;
    }
    if (method === "GET" && path === "/v1/knowledge/search") {
      sendJson(response, 200, { items: this.core.search({
        query: url.searchParams.get("query") ?? "",
        ...(url.searchParams.get("project_id") ? { project_id: url.searchParams.get("project_id")! } : {}),
        ...(url.searchParams.get("scope") ? { scopes: url.searchParams.getAll("scope") } : {}),
        ...(url.searchParams.get("type") ? { types: url.searchParams.getAll("type") as never } : {}),
        ...(url.searchParams.get("status") ? { statuses: url.searchParams.getAll("status") as never } : {}),
        limit: Number(url.searchParams.get("limit") ?? 8),
      }) });
      return;
    }
    if (method === "GET" && path === "/v1/candidates") {
      sendJson(response, 200, { items: this.core.listCandidates((url.searchParams.get("status") ?? "candidate") as never) });
      return;
    }
    const previewCandidate = path.match(/^\/v1\/candidates\/([^/]+)\/preview$/);
    if (method === "POST" && previewCandidate) {
      sendJson(response, 200, this.core.previewCandidate(decodeURIComponent(previewCandidate[1]!)));
      return;
    }
    const approveCandidate = path.match(/^\/v1\/candidates\/([^/]+)\/approve$/);
    if (method === "POST" && approveCandidate) {
      const body = await readJson(request);
      sendJson(response, 200, await this.core.approveCandidate({ candidate_id: decodeURIComponent(approveCandidate[1]!), ...body } as never));
      return;
    }
    const rejectCandidate = path.match(/^\/v1\/candidates\/([^/]+)\/reject$/);
    if (method === "POST" && rejectCandidate) {
      const body = await readJson(request);
      sendJson(response, 200, this.core.rejectCandidate({
        candidate_id: decodeURIComponent(rejectCandidate[1]!),
        reason: String(body.reason ?? "Rejected by user"),
        idempotency_key: String(body.idempotency_key ?? ""),
      }));
      return;
    }
    if (method === "GET" && path === "/v1/settings") {
      sendJson(response, 200, this.core.getSettings());
      return;
    }
    if (method === "POST" && path === "/v1/settings/preview") {
      sendJson(response, 200, this.core.previewSettings(await readJson(request)));
      return;
    }
    if (method === "POST" && path === "/v1/settings/apply") {
      sendJson(response, 200, this.core.applySettings(await readJson(request) as never));
      return;
    }
    const memoryMatch = path.match(/^\/v1\/memories\/([^/]+)$/);
    if (method === "GET" && memoryMatch) {
      sendJson(response, 200, await this.core.explain({ memory_id: decodeURIComponent(memoryMatch[1]!) }));
      return;
    }
    if (method === "POST" && path === "/v1/privacy/forget/preview") {
      const body = await readJson(request);
      sendJson(response, 200, this.core.previewForget(String(body.memory_id ?? "")));
      return;
    }
    if (method === "POST" && path === "/v1/privacy/forget/apply") {
      const body = await readJson(request);
      sendJson(response, 200, await this.core.forget(String(body.memory_id ?? ""), body as never));
      return;
    }
    if (method === "POST" && path === "/v1/privacy/export") {
      sendJson(response, 200, this.core.export());
      return;
    }
    if (method === "POST" && path === "/v1/privacy/reset/preview") {
      const body = await readJson(request);
      const mode = String(body.mode ?? body.target ?? "index");
      sendJson(response, 200, this.core.previewReset(mode as never));
      return;
    }
    if (method === "POST" && path === "/v1/privacy/reset/apply") {
      const body = await readJson(request);
      const mode = String(body.mode ?? body.target ?? "index");
      sendJson(response, 200, await this.core.applyReset(mode as never, body as never));
      return;
    }
    if (method === "GET" && path === "/v1/providers") {
      sendJson(response, 200, { items: [{ id: this.core.provider.id, enabled: this.core.provider.enabled, consent: this.core.getSettings().provider_consent }] });
      return;
    }
    const providerPreview = path.match(/^\/v1\/providers\/([^/]+)\/(enable|disable)\/preview$/);
    if (method === "POST" && providerPreview) {
      const enabled = providerPreview[2] === "enable";
      const preview = this.core.previewSettings({ provider_consent: enabled });
      sendJson(response, 200, { provider_id: decodeURIComponent(providerPreview[1]!), enabled, preview });
      return;
    }
    const providerApply = path.match(/^\/v1\/providers\/([^/]+)\/(enable|disable)\/apply$/);
    if (method === "POST" && providerApply) {
      const body = await readJson(request);
      sendJson(response, 200, {
        provider_id: decodeURIComponent(providerApply[1]!),
        settings: this.core.applySettings(body as never),
      });
      return;
    }
    if (method === "GET" && path === "/v1/integrations") {
      sendJson(response, 200, { items: this.core.state.listIntegrations() });
      return;
    }
    throw new CoachError("NOT_FOUND", "API route does not exist");
  }

  private async dashboardApi(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    if (request.method !== "GET" || url.pathname !== "/api/dashboard") {
      throw new CoachError("NOT_FOUND", "Dashboard API route does not exist");
    }
    const overview = this.core.state.dashboardOverview() as {
      candidates?: Record<string, number>;
      feedback?: Record<string, number>;
    };
    const candidates = this.core.listCandidates("candidate");
    const memories = await this.core.knowledge.list();
    const counts = { preference: 0, fact: 0, experience: 0, procedure: 0 };
    for (const memory of memories) counts[memory.type] += 1;
    const turns = this.core.state.listTurns(100);
    const integrations = this.core.state.listIntegrations();
    const integrationByHost = new Map(integrations.map((item) => [String(item.host), item]));
    const settings = this.core.getSettings();
    const feedbackTotal = Object.values(overview.feedback ?? {}).reduce((sum, value) => sum + Number(value), 0);
    const packetMatches = (packetId: unknown): number => {
      if (typeof packetId !== "string") return 0;
      const packet = this.core.state.getPacket(packetId);
      return packet ? packet.constraints.length + packet.preferences.length + packet.facts.length + packet.experiences.length + packet.procedures.length : 0;
    };
    const hostRows = [
      { id: "codex", name: "Codex", version: "0.147.x" },
      { id: "kimi", name: "Kimi Code", version: "0.38.x" },
      { id: "dsh", name: "DeepSeek Harness", version: "0.1.0-rc.7" },
    ].map((base) => {
      const actual = integrationByHost.get(base.id);
      return {
        ...base,
        version: String(actual?.version ?? base.version),
        status: String(actual?.status ?? "unverified"),
        detail: String((actual?.details as Record<string, unknown> | undefined)?.detail ?? "尚未完成 fresh-process canary"),
        coverage: String((actual?.details as Record<string, unknown> | undefined)?.coverage ?? "等待宿主验证"),
      };
    });
    const indexStatus = this.core.knowledge.status();
    sendJson(response, 200, {
      health: indexStatus.fts5 ? "healthy" : "degraded",
      health_message: indexStatus.fts5 ? "本地权威知识与 FTS5 索引运行正常" : "FTS5 不可用，正在使用确定性检索降级",
      pending_count: candidates.length,
      counts,
      growth: [0, 0, 0, 0, 0, 0, memories.length],
      candidates,
      traces: turns.map((turn) => {
        const adoption = Array.isArray(turn.adoption) ? turn.adoption as Array<Record<string, unknown>> : [];
        const plan = turn.revised_plan as { steps?: string[] } | null;
        return {
          id: String(turn.turn_key),
          title: String(turn.goal_summary || turn.task_type),
          host: String(turn.host),
          time: String(turn.updated_at),
          status: String(turn.state).toLowerCase(),
          matches: packetMatches(turn.packet_id),
          before: [],
          after: plan?.steps ?? [],
          adopted: adoption.filter((item) => item.decision === "adopted").map((item) => String(item.memory_id)),
          omitted: adoption.filter((item) => item.decision === "ignored").map((item) => String(item.memory_id)),
          outcome: String(turn.state === "COMPLETED" ? "已完成并记录结果" : "进行中"),
        };
      }),
      integrations: hostRows,
      memories: memories.map((memory) => ({
        id: memory.id,
        type: memory.type,
        title: memory.title,
        content: memory.content,
        scope: memory.scope,
        status: memory.status,
        uses: memory.use_count,
        feedback: feedbackTotal,
        source: memory.provenance.source_refs.join(", "),
        updated_at: memory.updated_at,
      })),
      settings: {
        learning_paused: settings.learning_paused,
        recall_enabled: settings.recall_enabled,
        gate_mode: settings.gate_mode,
        journal_ttl_days: settings.journal_ttl_days,
        diagnostic_capture_ttl_days: settings.diagnostic_capture_ttl_days,
        provider_consent: settings.provider_consent,
      },
      provider: {
        name: this.core.provider.id === "disabled" ? "Built-in" : this.core.provider.id,
        status: this.core.provider.enabled ? "healthy" : "disabled",
        detail: this.core.provider.enabled ? "已启用外部增强；File/Git 仍是权威" : "使用 File knowledge + SQLite 本地检索",
      },
      demo: false,
    });
  }

  private async serveDashboard(response: ServerResponse, requestPath: string, csrf: string | null): Promise<void> {
    let relative = decodeURIComponent(requestPath).replace(/^\/+/, "") || "index.html";
    if (relative.includes("..")) throw new CoachError("NOT_FOUND", "Dashboard asset does not exist");
    for (const dashboardRoot of this.dashboardRoots) {
      let candidate = resolve(dashboardRoot, normalize(relative));
      if (!candidate.startsWith(`${dashboardRoot}${sep}`) && candidate !== dashboardRoot) continue;
      try {
        const info = await stat(candidate);
        if (info.isDirectory()) candidate = join(candidate, "index.html");
        let content = await readFile(candidate);
        if (extname(candidate) === ".html" && csrf && /^[A-Za-z0-9_-]+$/.test(csrf)) {
          content = Buffer.from(content.toString("utf8").replace("<head>", `<head><meta name="agent-coach-csrf" content="${csrf}">`), "utf8");
        }
        securityHeaders(response);
        response.statusCode = 200;
        response.setHeader("Content-Type", MIME[extname(candidate)] ?? "application/octet-stream");
        response.end(content);
        return;
      } catch {
        // try the next configured dashboard location or the SPA fallback
      }
      if (relative !== "index.html") {
        try {
          let content = await readFile(join(dashboardRoot, "index.html"));
          if (csrf && /^[A-Za-z0-9_-]+$/.test(csrf)) {
            content = Buffer.from(content.toString("utf8").replace("<head>", `<head><meta name="agent-coach-csrf" content="${csrf}">`), "utf8");
          }
          securityHeaders(response);
          response.statusCode = 200;
          response.setHeader("Content-Type", "text/html; charset=utf-8");
          response.end(content);
          return;
        } catch {
          // try the next configured dashboard location
        }
      }
    }
    securityHeaders(response);
    response.statusCode = 200;
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end("<!doctype html><html><head><meta charset=\"utf-8\"><title>Agent Coach</title></head><body><main><h1>Agent Coach</h1><p>Dashboard assets are not built yet. The authenticated API is running.</p></main></body></html>");
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await new Promise<void>((resolvePromise, reject) => {
      this.server.close((error) => error ? reject(error) : resolvePromise());
    });
    try {
      const current = JSON.parse(await readFile(this.core.paths.discovery, "utf8")) as GatewayDiscoveryV1;
      if (current.instance_id === this.instanceId) await rm(this.core.paths.discovery, { force: true });
    } catch {
      // A replaced or already-removed discovery file is intentionally preserved/ignored.
    }
  }
}

export async function readGatewayDiscovery(home: string): Promise<{
  discovery: GatewayDiscoveryV1;
  bearer: string;
}> {
  const discovery = JSON.parse(await readFile(join(home, "gateway.json"), "utf8")) as GatewayDiscoveryV1;
  if (discovery.protocol_version !== "agent-coach/gateway-v1") {
    throw new CoachError("VALIDATION_ERROR", "Unsupported gateway discovery version");
  }
  const tokenPath = join(home, discovery.token_file);
  if (resolve(tokenPath) !== resolve(home, basename(discovery.token_file))) {
    throw new CoachError("VALIDATION_ERROR", "Discovery token reference must stay inside Agent Coach home");
  }
  return { discovery, bearer: (await readFile(tokenPath, "utf8")).trim() };
}
