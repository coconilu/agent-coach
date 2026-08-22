import type { GuidanceItem, IntentEnvelope, TurnRef } from "../contracts.js";

export interface ProviderRecallInput {
  turn_ref: TurnRef;
  intent: IntentEnvelope;
  query: string;
  limit: number;
}

export interface ProviderDeleteResult {
  deleted: boolean;
  verified: boolean;
  detail: string;
}

export interface MemoryProvider {
  readonly id: string;
  readonly enabled: boolean;
  recall(input: ProviderRecallInput, signal?: AbortSignal): Promise<GuidanceItem[]>;
  forget(memoryId: string, signal?: AbortSignal): Promise<ProviderDeleteResult>;
  health(signal?: AbortSignal): Promise<{ healthy: boolean; detail: string }>;
}

export class DisabledMemoryProvider implements MemoryProvider {
  readonly id = "disabled";
  readonly enabled = false;

  async recall(): Promise<GuidanceItem[]> {
    return [];
  }

  async forget(): Promise<ProviderDeleteResult> {
    return { deleted: false, verified: true, detail: "provider disabled" };
  }

  async health(): Promise<{ healthy: boolean; detail: string }> {
    return { healthy: true, detail: "provider disabled; canonical and keyless paths remain available" };
  }
}
