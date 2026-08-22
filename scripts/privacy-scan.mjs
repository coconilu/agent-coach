#!/usr/bin/env node

/**
 * Repository privacy/secret gate.
 *
 * The scanner intentionally uses only Node built-ins so the exact same command
 * runs before dependency installation on Windows, Linux and macOS.
 */
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

const DEFAULT_IGNORED_DIRECTORIES = new Set([
  ".git",
  ".pnpm-store",
  ".turbo",
  ".ui-style-director",
  ".vite",
  "coverage",
  "node_modules",
]);

const TEXT_EXTENSIONS = new Set([
  "",
  ".cjs",
  ".conf",
  ".css",
  ".csv",
  ".env",
  ".example",
  ".gitignore",
  ".html",
  ".ini",
  ".js",
  ".json",
  ".jsonl",
  ".lock",
  ".map",
  ".md",
  ".mjs",
  ".ps1",
  ".sh",
  ".sql",
  ".svg",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);

const PLACEHOLDER_PREFIXES = [
  "example-",
  "example_",
  "fixture-",
  "fixture_",
  "placeholder-",
  "placeholder_",
  "synthetic-",
  "synthetic_",
  "test-",
  "test_",
];

const KNOWN_SECRET_PATTERNS = [
  ["PRIVATE_KEY", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g],
  ["OPENAI_KEY", /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/g],
  ["GITHUB_TOKEN", /\bgh(?:p|o|u|s|r)_[A-Za-z0-9]{24,}\b/g],
  ["AWS_ACCESS_KEY", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ["SLACK_TOKEN", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g],
  ["GOOGLE_API_KEY", /\bAIza[A-Za-z0-9_-]{30,}\b/g],
  ["NPM_TOKEN", /\bnpm_[A-Za-z0-9]{30,}\b/g],
  ["PYPI_TOKEN", /\bpypi-[A-Za-z0-9_-]{40,}\b/g],
  ["STRIPE_SECRET", /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/g],
  ["JWT", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g],
];

const VALUE_PATTERNS = [
  [
    "AUTHORIZATION_HEADER",
    /\bAuthorization\s*[:=]\s*["']?(?:Basic|Bearer)\s+([^\s"',}\]]+)/gi,
  ],
  [
    "CREDENTIAL_ASSIGNMENT",
    /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|_authToken|client[_-]?secret|password|private[_-]?key|secret[_-]?key)\b["']?\s*[:=]\s*["']([^"'\r\n]{8,})["']/gi,
  ],
  [
    "SESSION_ID",
    /["']?(?:session_id|sessionId)["']?\s*[:=]\s*["']([^"'\r\n]{6,})["']/g,
  ],
  [
    "TURN_ID",
    /["']?(?:turn_id|turnId)["']?\s*[:=]\s*["']([^"'\r\n]{6,})["']/g,
  ],
  [
    "RAW_CAPTURE",
    /["']?(?:raw_prompt|full_prompt|hook_payload|raw_hook_payload|full_tool_output)["']?\s*[:=]\s*["']([^"'\r\n]{4,})["']/gi,
  ],
];

const PATH_PATTERNS = [
  ["WINDOWS_USER_PATH", /\b[A-Za-z]:\\Users\\([^\\\s"'<>%{}]+)\\/g],
  ["WINDOWS_USER_PATH", /\b[A-Za-z]:\\\\Users\\\\([^\\\s"'<>%{}]+)\\\\/g],
  ["WINDOWS_USER_PATH", /\b[A-Za-z]:\/Users\/([^/\s"'<>%{}]+)\//g],
  ["POSIX_HOME_PATH", /(?:^|[\s"'(])\/(?:home|Users)\/([^/\s"'<>$\{]+)\//gm],
];

const TEMP_PROVIDER_URL = /https?:\/\/(?:[a-z0-9-]+\.)?(?:ngrok(?:-free)?\.app|trycloudflare\.com|loca\.lt|localtunnel\.me)(?:[:/]|$)/gi;
const CREDENTIAL_URL = /\b(?:https?|postgres(?:ql)?|mysql|redis):\/\/([^\s/:@]+):([^\s/@]+)@/gi;
const PRIVATE_KNOWLEDGE_MARKER = new RegExp(
  ["BEGIN PRIVATE", "PRIVATE KNOWLEDGE", "DO NOT PUBLISH PRIVATE"].map((prefix, index) =>
    `${prefix} ${["KNOWLEDGE", "BODY", "MEMORY"][index]}`,
  ).join("|"),
  "gi",
);

function parseArguments(argv) {
  const result = { root: process.cwd(), json: false, output: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--root") {
      result.root = argv[++index];
    } else if (argument === "--json") {
      result.json = true;
    } else if (argument === "--output") {
      result.output = argv[++index];
    } else if (argument === "--help" || argument === "-h") {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!result.root) throw new Error("--root requires a directory");
  return result;
}

function printUsage() {
  console.log("Usage: node scripts/privacy-scan.mjs [--root <directory>] [--json] [--output <report.json>]");
}

function normalizePath(path) {
  return path.split(sep).join("/");
}

function isSyntheticValue(value) {
  const normalized = value.trim().replace(/^['"]|['"]$/g, "").replace(/^\[|\]$/g, "").toLowerCase();
  return (
    normalized.length === 0 ||
    normalized === "redacted" ||
    normalized === "changeme" ||
    normalized === "not-a-secret" ||
    normalized.startsWith("<") ||
    normalized.startsWith("${") ||
    normalized.startsWith("%") ||
    normalized.startsWith("00000000-0000-0000-0000-") ||
    PLACEHOLDER_PREFIXES.some((prefix) => normalized.startsWith(prefix))
  );
}

function lineAndColumn(text, offset) {
  const prefix = text.slice(0, offset);
  const lines = prefix.split(/\r?\n/);
  return { line: lines.length, column: lines.at(-1).length + 1 };
}

function redactMatch(value) {
  if (value.length <= 8) return "[REDACTED]";
  return `${value.slice(0, 3)}…${value.slice(-3)}`;
}

function addFinding(findings, path, text, offset, rule, matchedValue) {
  const location = lineAndColumn(text, offset);
  findings.push({
    path,
    line: location.line,
    column: location.column,
    rule,
    sample: redactMatch(matchedValue.replace(/[\r\n]/g, " ")),
  });
}

function scanText(path, text, findings) {
  for (const [rule, pattern] of KNOWN_SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      addFinding(findings, path, text, match.index, rule, match[0]);
    }
  }

  for (const [rule, pattern] of VALUE_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const value = match[1];
      if (!isSyntheticValue(value)) {
        addFinding(findings, path, text, match.index, rule, value);
      }
    }
  }

  for (const [rule, pattern] of PATH_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      if (!isSyntheticValue(match[1])) {
        addFinding(findings, path, text, match.index, rule, match[0]);
      }
    }
  }

  for (const [rule, pattern, valueGroup = 0] of [
    ["TEMP_PROVIDER_URL", TEMP_PROVIDER_URL],
    ["PRIVATE_KNOWLEDGE", PRIVATE_KNOWLEDGE_MARKER],
  ]) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      addFinding(findings, path, text, match.index, rule, match[valueGroup]);
    }
  }

  CREDENTIAL_URL.lastIndex = 0;
  for (const match of text.matchAll(CREDENTIAL_URL)) {
    if (!isSyntheticValue(match[1]) || !isSyntheticValue(match[2])) {
      addFinding(findings, path, text, match.index, "CREDENTIAL_URL", match[0]);
    }
  }
}

function archiveFinding(findings, path, rule, sample = "[archive entry]") {
  findings.push({ path, line: 1, column: 1, rule, sample });
}

function scanZip(path, buffer, findings) {
  let offset = 0;
  let scannedTextFiles = 0;
  let scannedBytes = 0;
  let totalExpandedBytes = 0;
  let entries = 0;

  while (offset + 4 <= buffer.length) {
    const signature = buffer.readUInt32LE(offset);
    if (signature === 0x02014b50 || signature === 0x06054b50) break;
    if (signature !== 0x04034b50 || offset + 30 > buffer.length) {
      archiveFinding(findings, path, "ARCHIVE_FORMAT", "[invalid ZIP structure]");
      return { scannedTextFiles, scannedBytes };
    }
    const flags = buffer.readUInt16LE(offset + 6);
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const expandedSize = buffer.readUInt32LE(offset + 22);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const dataOffset = offset + 30 + nameLength + extraLength;
    const endOffset = dataOffset + compressedSize;
    if (endOffset > buffer.length) {
      archiveFinding(findings, path, "ARCHIVE_FORMAT", "[truncated ZIP entry]");
      return { scannedTextFiles, scannedBytes };
    }
    const entryName = buffer.subarray(offset + 30, offset + 30 + nameLength).toString("utf8").replaceAll("\\", "/");
    const displayPath = `${path}!${entryName}`;
    entries += 1;
    if (entries > 10_000) {
      archiveFinding(findings, path, "ARCHIVE_LIMIT", "[too many entries]");
      return { scannedTextFiles, scannedBytes };
    }
    if (!entryName || entryName.startsWith("/") || entryName.split("/").includes("..")) {
      archiveFinding(findings, displayPath, "ARCHIVE_PATH_ESCAPE");
      offset = endOffset;
      continue;
    }
    if ((flags & 0x0001) !== 0 || (flags & 0x0008) !== 0) {
      archiveFinding(findings, displayPath, "UNSCANNED_ARCHIVE_ENTRY", "[encrypted or streamed ZIP entry]");
      offset = endOffset;
      continue;
    }

    let expanded;
    try {
      if (method === 0) expanded = buffer.subarray(dataOffset, endOffset);
      else if (method === 8) expanded = inflateRawSync(buffer.subarray(dataOffset, endOffset), { maxOutputLength: 5 * 1024 * 1024 });
      else {
        archiveFinding(findings, displayPath, "UNSCANNED_ARCHIVE_ENTRY", `[ZIP method ${method}]`);
        offset = endOffset;
        continue;
      }
    } catch {
      archiveFinding(findings, displayPath, "ARCHIVE_FORMAT", "[decompression failed]");
      offset = endOffset;
      continue;
    }
    if (expanded.length !== expandedSize) {
      archiveFinding(findings, displayPath, "ARCHIVE_FORMAT", "[expanded size mismatch]");
      offset = endOffset;
      continue;
    }
    totalExpandedBytes += expanded.length;
    if (totalExpandedBytes > 50 * 1024 * 1024) {
      archiveFinding(findings, path, "ARCHIVE_LIMIT", "[expanded archive exceeds 50 MiB]");
      return { scannedTextFiles, scannedBytes };
    }

    const entryBase = entryName.split("/").at(-1).toLowerCase();
    const entryExtension = extname(entryBase);
    if (
      entryExtension === ".db" ||
      entryExtension === ".sqlite" ||
      entryExtension === ".sqlite3" ||
      entryBase === "gateway.token" ||
      entryBase.endsWith(".db-wal") ||
      entryBase.endsWith(".db-shm") ||
      entryBase.endsWith(".sqlite-wal") ||
      entryBase.endsWith(".sqlite-shm") ||
      entryBase.endsWith(".sqlite3-wal") ||
      entryBase.endsWith(".sqlite3-shm")
    ) {
      archiveFinding(findings, displayPath, "RUNTIME_DATA", "[runtime file in archive]");
    } else if (
      entryBase === ".env" ||
      (entryBase.startsWith(".env.") && !entryBase.endsWith(".example") && !entryBase.endsWith(".template")) ||
      entryBase === "credentials.json" ||
      entryBase === "id_rsa" ||
      entryBase.endsWith(".pem") ||
      entryBase.endsWith(".key") ||
      entryBase.endsWith(".p12") ||
      entryBase.endsWith(".pfx")
    ) {
      archiveFinding(findings, displayPath, "CREDENTIAL_FILE", "[credential file in archive]");
    } else if (TEXT_EXTENSIONS.has(entryExtension) || TEXT_EXTENSIONS.has(entryBase)) {
      if (expanded.length > 5 * 1024 * 1024) {
        archiveFinding(findings, displayPath, "UNSCANNED_LARGE_TEXT", `[${expanded.length} bytes]`);
      } else if (!expanded.includes(0)) {
        scanText(displayPath, expanded.toString("utf8"), findings);
        scannedTextFiles += 1;
        scannedBytes += expanded.length;
      }
    }
    offset = endOffset;
  }
  if (entries === 0) archiveFinding(findings, path, "ARCHIVE_FORMAT", "[ZIP contains no local entries]");
  return { scannedTextFiles, scannedBytes };
}

function collectFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && DEFAULT_IGNORED_DIRECTORIES.has(entry.name)) continue;
      const absolutePath = resolve(directory, entry.name);
      const relativePath = normalizePath(relative(root, absolutePath));
      if (entry.isSymbolicLink()) {
        files.push({ absolutePath, relativePath, symbolicLink: true });
      } else if (entry.isDirectory()) {
        visit(absolutePath);
      } else if (entry.isFile()) {
        files.push({ absolutePath, relativePath, symbolicLink: false });
      }
    }
  };
  visit(root);
  return files;
}

export function scanRepository(rootDirectory) {
  const root = realpathSync(resolve(rootDirectory));
  if (!statSync(root).isDirectory()) throw new Error(`Not a directory: ${root}`);

  const findings = [];
  const files = collectFiles(root);
  let scannedTextFiles = 0;
  let scannedBytes = 0;

  for (const file of files) {
    const lowerPath = file.relativePath.toLowerCase();
    const baseName = lowerPath.split("/").at(-1);
    const extension = extname(baseName);

    if (file.symbolicLink) {
      const resolvedTarget = realpathSync(file.absolutePath);
      if (!resolvedTarget.startsWith(`${root}${sep}`)) {
        findings.push({ path: file.relativePath, line: 1, column: 1, rule: "EXTERNAL_SYMLINK", sample: "[external target]" });
      }
      continue;
    }

    if (
      baseName === "state.db" ||
      baseName === "index.db" ||
      baseName === "gateway.token" ||
      extension === ".db" ||
      extension === ".sqlite" ||
      extension === ".sqlite3" ||
      extension === ".db-wal" ||
      extension === ".db-shm" ||
      baseName.endsWith(".sqlite-wal") ||
      baseName.endsWith(".sqlite-shm") ||
      baseName.endsWith(".sqlite3-wal") ||
      baseName.endsWith(".sqlite3-shm")
    ) {
      findings.push({ path: file.relativePath, line: 1, column: 1, rule: "RUNTIME_DATA", sample: "[runtime file]" });
      continue;
    }

    if (
      (
        baseName === ".env" ||
        (baseName.startsWith(".env.") && !baseName.endsWith(".example") && !baseName.endsWith(".template")) ||
        baseName === "credentials.json" ||
        baseName === "id_rsa" ||
        baseName.endsWith(".pem") ||
        baseName.endsWith(".key") ||
        baseName.endsWith(".p12") ||
        baseName.endsWith(".pfx")
      ) &&
      !baseName.includes("example")
    ) {
      findings.push({ path: file.relativePath, line: 1, column: 1, rule: "CREDENTIAL_FILE", sample: "[credential file]" });
      continue;
    }

    if (extension === ".zip") {
      const size = lstatSync(file.absolutePath).size;
      if (size > 50 * 1024 * 1024) {
        findings.push({ path: file.relativePath, line: 1, column: 1, rule: "ARCHIVE_LIMIT", sample: `[${size} bytes]` });
        continue;
      }
      const archiveMetrics = scanZip(file.relativePath, readFileSync(file.absolutePath), findings);
      scannedTextFiles += archiveMetrics.scannedTextFiles;
      scannedBytes += archiveMetrics.scannedBytes;
      continue;
    }

    if (!TEXT_EXTENSIONS.has(extension) && !TEXT_EXTENSIONS.has(baseName)) continue;
    const size = lstatSync(file.absolutePath).size;
    if (size > 5 * 1024 * 1024) {
      findings.push({ path: file.relativePath, line: 1, column: 1, rule: "UNSCANNED_LARGE_TEXT", sample: `[${size} bytes]` });
      continue;
    }
    const buffer = readFileSync(file.absolutePath);
    if (buffer.includes(0)) continue;
    const text = buffer.toString("utf8");
    scannedTextFiles += 1;
    scannedBytes += buffer.length;
    scanText(file.relativePath, text, findings);
  }

  findings.sort((left, right) =>
    left.path.localeCompare(right.path) || left.line - right.line || left.column - right.column || left.rule.localeCompare(right.rule),
  );

  return {
    schema_version: "agent-coach/privacy-scan/v1",
    status: findings.length === 0 ? "PASS" : "FAIL",
    scanned_text_files: scannedTextFiles,
    scanned_bytes: scannedBytes,
    finding_count: findings.length,
    findings,
  };
}

function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
    const report = scanRepository(options.root);
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    if (options.output) {
      const output = resolve(options.output);
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(output, serialized, "utf8");
    }
    if (options.json) {
      process.stdout.write(serialized);
    } else if (report.status === "PASS") {
      console.log(`Privacy scan PASS: ${report.scanned_text_files} text files, ${report.scanned_bytes} bytes.`);
    } else {
      console.error(`Privacy scan FAIL: ${report.finding_count} finding(s).`);
      for (const finding of report.findings) {
        console.error(`${finding.path}:${finding.line}:${finding.column} [${finding.rule}] ${finding.sample}`);
      }
    }
    process.exitCode = report.status === "PASS" ? 0 : 1;
  } catch (error) {
    console.error(`Privacy scan could not run: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath.toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  main();
}
