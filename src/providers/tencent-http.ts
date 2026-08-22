import { z } from "zod";
import type { GuidanceItem } from "../contracts.js";
import { CoachError } from "../errors.js";
import type { MemoryProvider, ProviderDeleteResult, ProviderRecallInput } from "./memory-provider.js";

const ProviderItemSchema = z.object({
  memory_id: z.string().min(1),
  type: z.enum(["preference", "fact", "experience", "procedure"]),
  title: z.string(),
  content: z.string(),
  scope: z.string(),
  provenance: z.object({
    source_refs: z.array(z.string()).default([]),
    evidence_refs: z.array(z.string()).default([]),
  }),
  content_hash: z.string(),
  score: z.number().default(0),
});

export interface TencentHttpProviderOptions {
  baseUrl: string;
  bearerToken?: string;
  enabled: boolean;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class TencentHttpMemoryProvider implements MemoryProvider {
  readonly id = "tencentdb-agent-memory";
  readonly enabled: boolean;
  private readonly baseUrl: string;
  private readonly bearerToken: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: TencentHttpProviderOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.bearerToken = options.bearerToken;
    this.enabled = options.enabled;
    this.timeoutMs = options.timeoutMs ?? 1_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async request(path: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    if (!this.enabled) throw new CoachError("PROVIDER_UNAVAILABLE", "Provider is disabled");
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        signal: combined,
        headers: {
          "content-type": "application/json",
          ...(this.bearerToken ? { authorization: `Bearer ${this.bearerToken}` } : {}),
          ...init.headers,
        },
      });
      if (!response.ok) {
        throw new CoachError("PROVIDER_UNAVAILABLE", `Provider returned HTTP ${response.status}`);
      }
      return response;
    } catch (error) {
      if (error instanceof CoachError) throw error;
      throw new CoachError("PROVIDER_UNAVAILABLE", "Provider request timed out or failed");
    }
  }

  async recall(input: ProviderRecallInput, signal?: AbortSignal): Promise<GuidanceItem[]> {
    const response = await this.request(
      "/v1/memories/recall",
      { method: "POST", body: JSON.stringify(input) },
      signal,
    );
    const parsed = z.object({ items: z.array(ProviderItemSchema).max(50) }).parse(await response.json());
    return parsed.items.map((item) => ({
      ...item,
      authority: "provider" as const,
      status: "candidate" as const,
      provenance: { ...item.provenance, origin: "provider" as const },
    }));
  }

  async forget(memoryId: string, signal?: AbortSignal): Promise<ProviderDeleteResult> {
    const response = await this.request(
      `/v1/memories/${encodeURIComponent(memoryId)}`,
      { method: "DELETE" },
      signal,
    );
    return z.object({ deleted: z.boolean(), verified: z.boolean(), detail: z.string() }).parse(await response.json());
  }

  async health(signal?: AbortSignal): Promise<{ healthy: boolean; detail: string }> {
    try {
      await this.request("/health", { method: "GET" }, signal);
      return { healthy: true, detail: "provider roundtrip succeeded" };
    } catch (error) {
      return { healthy: false, detail: error instanceof Error ? error.message : "provider unavailable" };
    }
  }
}
