import { defaultDataHome } from "../paths.js";
import { CoachError } from "../errors.js";
import { readGatewayDiscovery } from "../server/gateway.js";

export interface GatewayRequestOptions {
  method?: "GET" | "POST";
  body?: unknown;
  timeoutMs?: number;
  home?: string;
}

export async function gatewayRequest<T>(path: string, options: GatewayRequestOptions = {}): Promise<T> {
  let connection: Awaited<ReturnType<typeof readGatewayDiscovery>>;
  try {
    connection = await readGatewayDiscovery(options.home ?? defaultDataHome());
  } catch {
    throw new CoachError("PROVIDER_UNAVAILABLE", "Agent Coach Gateway is not running; start it with `agent-coach start`");
  }
  try {
    const response = await fetch(`${connection.discovery.origin}${path}`, {
      method: options.method ?? (options.body === undefined ? "GET" : "POST"),
      headers: {
        authorization: `Bearer ${connection.bearer}`,
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 1_000),
    });
    const payload = await response.json() as { error?: { code?: string; message?: string } } & T;
    if (!response.ok) {
      throw new CoachError(
        (payload.error?.code as never) ?? "VALIDATION_ERROR",
        payload.error?.message ?? `Gateway returned HTTP ${response.status}`,
      );
    }
    return payload;
  } catch (error) {
    if (error instanceof CoachError) throw error;
    throw new CoachError("PROVIDER_UNAVAILABLE", "Agent Coach Gateway timed out or is unavailable");
  }
}
