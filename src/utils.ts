import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

export type Clock = () => Date;

export const systemClock: Clock = () => new Date();

export function isoNow(clock: Clock = systemClock): string {
  return clock().toISOString();
}

export function addMilliseconds(iso: string, milliseconds: number): string {
  return new Date(Date.parse(iso) + milliseconds).toISOString();
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(object)
        .sort()
        .map((key) => [key, sorted(object[key])]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sorted(value));
}

export function sha256(value: unknown): string {
  const text = typeof value === "string" ? value : canonicalJson(value);
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function opaqueId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

export function secret(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function safeSecretEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.byteLength !== rightBuffer.byteLength) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

export function estimateTokens(text: string): number {
  return Math.ceil([...text].length / 3);
}

export function redactAbsolutePaths(text: string): string {
  return text
    .replace(/[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s]*/g, "<redacted-path>")
    .replace(/\/(?:Users|home)\/[^\s]+/g, "<redacted-path>");
}

export function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}
