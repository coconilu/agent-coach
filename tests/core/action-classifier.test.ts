import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { classifyAction, CLASSIFIER_VERSION } from "../../src/action-classifier.js";

interface Fixture {
  name: string;
  action: string;
  arguments: Record<string, unknown>;
  expected: "read" | "write" | "unknown";
  coverage?: "covered" | "unsupported";
}

describe("ActionClassifier v1 golden fixtures", () => {
  it("classifies conservative reads, writes, unknowns, and unsupported paths", async () => {
    const fixtures = JSON.parse(await readFile(new URL("../../fixtures/action-classifier.v1.json", import.meta.url), "utf8")) as Fixture[];
    for (const fixture of fixtures) {
      const result = classifyAction(fixture.action, fixture.arguments);
      expect(result.class, fixture.name).toBe(fixture.expected);
      expect(result.coverage, fixture.name).toBe(fixture.coverage ?? "covered");
      expect(result.classifier_version).toBe(CLASSIFIER_VERSION);
      expect(result.reason.length).toBeGreaterThan(5);
    }
  });

  it("does not let command prefix tricks through the read allowlist", () => {
    expect(classifyAction("exec_command", { cmd: "rg foo; Remove-Item secret" }).class).toBe("unknown");
    expect(classifyAction("exec_command", { cmd: "git status | Set-Content leaked" }).class).toBe("unknown");
    expect(classifyAction("exec_command", {}).class).toBe("unknown");
  });
});
