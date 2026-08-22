import { describe, expect, it } from "vitest";
import { demoData } from "./demo-data";

describe("dashboard demo contract", () => {
  it("contains all governed memory types and host integrations", () => {
    expect(Object.keys(demoData.counts).sort()).toEqual(["experience", "fact", "preference", "procedure"]);
    expect(demoData.integrations.map((item) => item.id).sort()).toEqual(["codex", "dsh", "kimi"]);
    expect(demoData.candidates).toHaveLength(3);
  });

  it("keeps the provider and privacy defaults local and advisory", () => {
    expect(demoData.provider.name).toBe("Built-in");
    expect(demoData.settings.gate_mode).toBe("advisory");
    expect(demoData.settings.provider_consent).toBe(false);
  });
});
