import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createChecksumManifest, verifyChecksumManifest } from "../../scripts/release-checksums.mjs";

test("release checksums are sorted, deterministic and detect tampering", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-coach-checksums-"));
  try {
    writeFileSync(join(directory, "z.txt"), "z\n");
    writeFileSync(join(directory, "a.txt"), "a\n");
    const first = await createChecksumManifest({
      base: directory,
      inputs: ["z.txt", "a.txt"],
      output: "SHA256SUMS.txt",
    });
    const firstContent = readFileSync(join(directory, "SHA256SUMS.txt"), "utf8");
    const second = await createChecksumManifest({
      base: directory,
      inputs: ["a.txt", "z.txt"],
      output: "SHA256SUMS.txt",
    });
    assert.deepEqual(first.lines, second.lines);
    assert.equal(firstContent, readFileSync(join(directory, "SHA256SUMS.txt"), "utf8"));
    assert.match(firstContent, /  a\.txt\n[\s\S]*  z\.txt\n$/);
    assert.equal((await verifyChecksumManifest({ base: directory, manifest: "SHA256SUMS.txt" })).status, "PASS");

    writeFileSync(join(directory, "a.txt"), "tampered\n");
    const verification = await verifyChecksumManifest({ base: directory, manifest: "SHA256SUMS.txt" });
    assert.equal(verification.status, "FAIL");
    assert.deepEqual(verification.failures.map((failure) => failure.reason), ["MISMATCH"]);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("checksum verification refuses a manifest path escape", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-coach-checksums-"));
  try {
    writeFileSync(join(directory, "SHA256SUMS.txt"), `${"0".repeat(64)}  ../outside.txt\n`);
    const result = await verifyChecksumManifest({ base: directory, manifest: "SHA256SUMS.txt" });
    assert.equal(result.status, "FAIL");
    assert.equal(result.failures[0].reason, "PATH_ESCAPE");
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
