import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { scanRepository } from "../../scripts/privacy-scan.mjs";

function withTemporaryRepository(run) {
  const directory = mkdtempSync(join(tmpdir(), "agent-coach-privacy-"));
  try {
    run(directory);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

function createStoredZip(entryName, content) {
  const name = Buffer.from(entryName, "utf8");
  const data = Buffer.from(content, "utf8");
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(local.length + name.length + data.length, 16);
  return Buffer.concat([local, name, data, central, name, end]);
}

test("synthetic placeholders and public documentation are accepted", () => {
  withTemporaryRepository((directory) => {
    writeFileSync(
      join(directory, "fixture.json"),
      JSON.stringify({
        session_id: "synthetic-session-001",
        turn_id: "fixture-turn-001",
        api_key: "<API_KEY>",
        Authorization: "Bearer [REDACTED]",
      }),
    );
    writeFileSync(join(directory, ".env.example"), "API_KEY=<API_KEY>\n");
    assert.equal(scanRepository(directory).status, "PASS");
  });
});

test("a concrete Windows user path is rejected without echoing it", () => {
  withTemporaryRepository((directory) => {
    const privatePath = ["C:", "Users", "casey", "private", "memory.md"].join("\\");
    writeFileSync(join(directory, "leak.txt"), `source=${privatePath}\n`);
    const report = scanRepository(directory);
    assert.equal(report.status, "FAIL");
    assert.ok(report.findings.some((finding) => finding.rule === "WINDOWS_USER_PATH"));
    assert.ok(report.findings.every((finding) => !finding.sample.includes("casey")));
  });
});

test("a JSON-escaped Windows user path is also rejected", () => {
  withTemporaryRepository((directory) => {
    const privatePath = ["D:", "Users", "operator", "workspace"].join("\\");
    writeFileSync(join(directory, "capture.json"), JSON.stringify({ cwd: privatePath }));
    const report = scanRepository(directory);
    assert.equal(report.status, "FAIL");
    assert.ok(report.findings.some((finding) => finding.rule === "WINDOWS_USER_PATH"));
  });
});

test("Linux and macOS user home paths are rejected", () => {
  withTemporaryRepository((directory) => {
    const linuxPath = ["", "home", "operator", "knowledge.json"].join("/");
    const macPath = ["", "Users", "operator", "knowledge.json"].join("/");
    writeFileSync(join(directory, "paths.txt"), `${linuxPath}\n${macPath}\n`);
    const report = scanRepository(directory);
    assert.equal(report.status, "FAIL");
    assert.equal(report.findings.filter((finding) => finding.rule === "POSIX_HOME_PATH").length, 2);
  });
});

test("real-looking session and turn identifiers are rejected", () => {
  withTemporaryRepository((directory) => {
    const data = {
      session_id: ["sess", "ion", "-8f70d6d0"].join(""),
      turn_id: ["turn", "-91d4f628"].join(""),
    };
    writeFileSync(join(directory, "capture.json"), JSON.stringify(data));
    const report = scanRepository(directory);
    assert.equal(report.status, "FAIL");
    assert.deepEqual(
      new Set(report.findings.map((finding) => finding.rule)),
      new Set(["SESSION_ID", "TURN_ID"]),
    );
  });
});

test("bearer credentials and credential URLs are rejected", () => {
  withTemporaryRepository((directory) => {
    const header = ["Authorization", ": Bearer ", "eyJhbGciOiJIUzI1NiJ9", ".eyJzdWIiOiJ1c2VyIn0", ".a-long-signature-value"].join("");
    const url = ["postgres", "://", "actual-user", ":", "actual-password", "@db.invalid/app"].join("");
    writeFileSync(join(directory, "leak.txt"), `${header}\n${url}\n`);
    const report = scanRepository(directory);
    assert.equal(report.status, "FAIL");
    assert.ok(report.findings.some((finding) => finding.rule === "AUTHORIZATION_HEADER"));
    assert.ok(report.findings.some((finding) => finding.rule === "CREDENTIAL_URL"));
  });
});

test("runtime databases and gateway tokens are rejected by filename", () => {
  withTemporaryRepository((directory) => {
    writeFileSync(join(directory, "state.db"), "SQLite format 3");
    writeFileSync(join(directory, "gateway.token"), "synthetic-placeholder");
    const report = scanRepository(directory);
    assert.equal(report.status, "FAIL");
    assert.equal(report.findings.filter((finding) => finding.rule === "RUNTIME_DATA").length, 2);
  });
});

test("environment-specific secret files are rejected even when their contents look empty", () => {
  withTemporaryRepository((directory) => {
    writeFileSync(join(directory, ".env.production"), "# intentionally empty\n");
    const report = scanRepository(directory);
    assert.equal(report.status, "FAIL");
    assert.equal(report.findings[0].rule, "CREDENTIAL_FILE");
  });
});

test("stored release archives are scanned instead of treated as opaque binaries", () => {
  withTemporaryRepository((directory) => {
    const secret = ["sk", "-", "abcdefghijklmnopqrstuvwx"].join("");
    writeFileSync(join(directory, "release.zip"), createStoredZip("config.txt", `token=${secret}\n`));
    const report = scanRepository(directory);
    assert.equal(report.status, "FAIL");
    assert.ok(report.findings.some((finding) => finding.rule === "OPENAI_KEY" && finding.path.includes("release.zip!config.txt")));
  });
});

test("dependency and Git metadata directories are excluded", () => {
  withTemporaryRepository((directory) => {
    for (const child of ["node_modules", ".git"]) {
      mkdirSync(join(directory, child), { recursive: true });
      writeFileSync(join(directory, child, "state.db"), "ignored");
    }
    assert.equal(scanRepository(directory).status, "PASS");
  });
});

test("the checked-out repository passes its own privacy gate", () => {
  const repository = resolve(import.meta.dirname, "../..");
  const report = scanRepository(repository);
  assert.equal(report.status, "PASS", JSON.stringify(report.findings, null, 2));
});
