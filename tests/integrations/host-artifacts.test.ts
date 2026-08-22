import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("host integration artifacts", () => {
  it("passes the isolated Node protocol, privacy, manifest, and packaging canaries", async () => {
    const directory = import.meta.dirname;
    const files = (await readdir(directory))
      .filter((name) => name.endsWith(".test.mjs") && name !== "live-gateway.test.mjs")
      .map((name) => `${directory}/${name}`);
    const result = await execFileAsync(process.execPath, ["--test", ...files], {
      cwd: `${directory}/../..`,
      timeout: 30_000,
      windowsHide: true,
    });
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("fail 0");
  });
});
