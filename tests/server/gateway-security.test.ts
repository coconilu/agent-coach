import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentCoachCore } from "../../src/core.js";
import { AgentCoachGateway } from "../../src/server/gateway.js";

interface Fixture {
  root: string;
  core: AgentCoachCore;
  gateway: AgentCoachGateway;
  token: string;
  close(): Promise<void>;
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "agent-coach-gateway-"));
  const core = await AgentCoachCore.create({ home: join(root, "runtime"), knowledgeHome: join(root, "knowledge") });
  const gateway = await AgentCoachGateway.start(core);
  const token = (await readFile(core.paths.token, "utf8")).trim();
  return {
    root,
    core,
    gateway,
    token,
    async close() {
      await gateway.close();
      core.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function bearer(token: string, body?: unknown): RequestInit {
  return {
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
  };
}

describe("authenticated loopback Gateway", () => {
  let fixture: Fixture | undefined;
  afterEach(async () => fixture?.close());

  it("binds loopback on a random port and keeps the bearer out of discovery", async () => {
    fixture = await createFixture();
    expect(fixture.gateway.discovery.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const discoveryText = await readFile(fixture.core.paths.discovery, "utf8");
    expect(discoveryText).not.toContain(fixture.token);
    expect(JSON.parse(discoveryText)).toMatchObject({ token_file: "gateway.token", pid: process.pid });

    const unauthorized = await fetch(`${fixture.gateway.discovery.origin}/v1/health`);
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toMatchObject({ error: { code: "UNAUTHORIZED" } });
    expect(unauthorized.headers.get("access-control-allow-origin")).toBeNull();

    const authorized = await fetch(`${fixture.gateway.discovery.origin}/v1/health`, bearer(fixture.token));
    expect(authorized.status).toBe(200);
    expect(authorized.headers.get("content-security-policy")).toContain("object-src 'none'");
    expect(await authorized.json()).toMatchObject({ state: "ready", gateway: { loopback: true } });

    const dashboard = await fetch(`${fixture.gateway.discovery.origin}/api/dashboard`, bearer(fixture.token));
    expect(dashboard.status).toBe(200);
    expect(await dashboard.json()).toMatchObject({
      health: expect.stringMatching(/healthy|degraded/),
      counts: { preference: 0, fact: 0, experience: 0, procedure: 0 },
      demo: false,
    });
  });

  it("rotates the secret and immediately rejects the old one", async () => {
    fixture = await createFixture();
    const old = fixture.token;
    await fixture.gateway.rotateSecret();
    const fresh = (await readFile(fixture.core.paths.token, "utf8")).trim();
    expect(fresh).not.toBe(old);
    expect((await fetch(`${fixture.gateway.discovery.origin}/v1/health`, bearer(old))).status).toBe(401);
    expect((await fetch(`${fixture.gateway.discovery.origin}/v1/health`, bearer(fresh))).status).toBe(200);
  });

  it("keeps CSRF available after a bootstrap redirect and ordinary dashboard reload", async () => {
    fixture = await createFixture();
    const bootstrap = await fixture.gateway.issueDashboardBootstrap();
    const response = await fetch(bootstrap.url, { redirect: "manual" });
    expect(response.status).toBe(302);
    const setCookies = response.headers.getSetCookie();
    const sessionSetCookie = setCookies.find((value) => value.startsWith("agent_coach_session="))!;
    const csrfSetCookie = setCookies.find((value) => value.startsWith("agent_coach_csrf="))!;
    expect(sessionSetCookie).toContain("HttpOnly");
    expect(sessionSetCookie).toContain("SameSite=Strict");
    expect(csrfSetCookie).toContain("SameSite=Strict");
    expect(csrfSetCookie).not.toContain("HttpOnly");
    const sessionCookie = sessionSetCookie.split(";", 1)[0]!;
    const csrfCookie = csrfSetCookie.split(";", 1)[0]!;
    const cookie = `${sessionCookie}; ${csrfCookie}`;
    const location = new URL(response.headers.get("location")!, fixture.gateway.discovery.origin);
    expect(location.pathname).toBe("/");
    expect(location.search).toBe("");
    const csrf = decodeURIComponent(csrfCookie.slice(csrfCookie.indexOf("=") + 1));
    expect(csrf.length).toBeGreaterThan(20);
    const dashboardHtml = await fetch(location, { headers: { cookie } });
    expect(await dashboardHtml.text()).toContain(`meta name="agent-coach-csrf" content="${csrf}"`);
    const reloadedHtml = await fetch(`${fixture.gateway.discovery.origin}/`, { headers: { cookie } });
    expect(await reloadedHtml.text()).toContain(`meta name="agent-coach-csrf" content="${csrf}"`);
    const tamperedReload = await fetch(`${fixture.gateway.discovery.origin}/`, {
      headers: { cookie: `${sessionCookie}; agent_coach_csrf=tampered` },
    });
    expect(await tamperedReload.text()).not.toContain('meta name="agent-coach-csrf"');
    expect((await fetch(bootstrap.url, { redirect: "manual" })).status).toBe(401);

    const read = await fetch(`${fixture.gateway.discovery.origin}/v1/settings`, { headers: { cookie } });
    expect(read.status).toBe(200);
    const noCsrf = await fetch(`${fixture.gateway.discovery.origin}/v1/settings/preview`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ learning_paused: true }),
    });
    expect(noCsrf.status).toBe(403);
    expect(await noCsrf.json()).toMatchObject({ error: { code: "CSRF_REJECTED" } });

    const wrongOrigin = await fetch(`${fixture.gateway.discovery.origin}/v1/settings/preview`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", "x-agent-coach-csrf": csrf, origin: "https://evil.invalid" },
      body: JSON.stringify({ learning_paused: true }),
    });
    expect(wrongOrigin.status).toBe(403);

    const accepted = await fetch(`${fixture.gateway.discovery.origin}/v1/settings/preview`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", "x-agent-coach-csrf": csrf, origin: fixture.gateway.discovery.origin },
      body: JSON.stringify({ learning_paused: true }),
    });
    expect(accepted.status).toBe(200);
  });

  it("returns malicious memory only as JSON text under a restrictive CSP", async () => {
    fixture = await createFixture();
    const payload = `<img src=x onerror=alert(1)><script>globalThis.pwned=true</script>`;
    await fixture.core.seedApprovedKnowledge({
      id: "mem_xss_fixture",
      type: "fact",
      title: "XSS fixture",
      content: payload,
      scope: "global",
      status: "approved",
      is_constraint: false,
      provenance: { source_refs: ["synthetic:xss"], evidence_refs: ["hash:xss"], origin: "synthetic_demo" },
      expires_at: null,
      supersedes: [],
      conflicts: [],
    });
    const response = await fetch(`${fixture.gateway.discovery.origin}/v1/knowledge/search?query=XSS`, bearer(fixture.token));
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("content-security-policy")).toContain("script-src 'self'");
    const text = await response.text();
    expect(text).toContain(payload);
    expect(text).not.toContain("Access-Control-Allow-Origin");
  });
});
