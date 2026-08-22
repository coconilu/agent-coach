import type { DashboardData, Settings } from "./types";

export interface ApiResult<T> {
  data: T;
  live: boolean;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const csrf = document.querySelector<HTMLMetaElement>('meta[name="agent-coach-csrf"]')?.content;
  const headers = new Headers(init?.headers);
  if (init?.body) headers.set("content-type", "application/json");
  if (csrf) headers.set("x-agent-coach-csrf", csrf);
  const response = await fetch(path, { ...init, credentials: "same-origin", headers });
  if (!response.ok) throw new Error(`Agent Coach API ${response.status}`);
  return response.json() as Promise<T>;
}

export async function loadDashboard(): Promise<DashboardData> {
  return request<DashboardData>("/api/dashboard");
}

export async function previewCandidate(id: string): Promise<Record<string, unknown>> {
  return request(`/v1/candidates/${encodeURIComponent(id)}/preview`, { method: "POST", body: "{}" });
}

export async function applyCandidate(id: string, action: "approve" | "reject", proposalHash?: string, baseRevision?: number): Promise<Record<string, unknown>> {
  return request(`/v1/candidates/${encodeURIComponent(id)}/${action}`, {
    method: "POST",
    body: JSON.stringify({ proposal_hash: proposalHash, base_revision: baseRevision, idempotency_key: crypto.randomUUID() }),
  });
}

export async function saveSettings(settings: Settings): Promise<Settings> {
  const preview = await request<{ proposal_hash: string; base_revision: number }>("/v1/settings/preview", { method: "POST", body: JSON.stringify(settings) });
  return request<Settings>("/v1/settings/apply", { method: "POST", body: JSON.stringify({ ...preview, idempotency_key: crypto.randomUUID() }) });
}

export async function privacyAction(action: "export" | "forget" | "reset", target?: string): Promise<Record<string, unknown>> {
  if (action === "export") return request("/v1/privacy/export", { method: "POST", body: JSON.stringify({ target: target ?? "all" }) });
  const preview = await request<{ proposal_hash: string; base_revision: number }>(`/v1/privacy/${action}/preview`, { method: "POST", body: JSON.stringify({ target: target ?? "all" }) });
  return request(`/v1/privacy/${action}/apply`, { method: "POST", body: JSON.stringify({ ...preview, idempotency_key: crypto.randomUUID() }) });
}
