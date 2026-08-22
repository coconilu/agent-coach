#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

function normalizePath(path) {
  return path.split(sep).join("/");
}

function isInside(base, target) {
  const value = relative(base, target);
  return value !== "" && !value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value);
}

function parseArguments(argv) {
  const options = { base: process.cwd(), output: undefined, verify: undefined, inputs: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--base") options.base = argv[++index];
    else if (argument === "--output") options.output = argv[++index];
    else if (argument === "--verify") options.verify = argv[++index];
    else if (argument === "--help" || argument === "-h") {
      console.log("Create: node scripts/release-checksums.mjs --output <SHA256SUMS.txt> <file-or-dir> [...]");
      console.log("Verify: node scripts/release-checksums.mjs --verify <SHA256SUMS.txt> [--base <directory>]");
      process.exit(0);
    } else if (argument.startsWith("-")) throw new Error(`Unknown option: ${argument}`);
    else options.inputs.push(argument);
  }
  return options;
}

function collectFiles(base, inputs, excludedPath) {
  const result = new Set();
  const visit = (absolutePath) => {
    const metadata = lstatSync(absolutePath);
    if (metadata.isSymbolicLink()) throw new Error(`Release input contains a symbolic link: ${normalizePath(relative(base, absolutePath))}`);
    if (metadata.isDirectory()) {
      for (const entry of readdirSync(absolutePath).sort((left, right) => left.localeCompare(right))) {
        visit(resolve(absolutePath, entry));
      }
      return;
    }
    if (!metadata.isFile()) return;
    if (excludedPath && absolutePath === excludedPath) return;
    if (!isInside(base, absolutePath)) throw new Error(`Release input escapes --base: ${absolutePath}`);
    const manifestPath = normalizePath(relative(base, absolutePath));
    if (/[\u0000-\u001f\u007f]/.test(manifestPath)) {
      throw new Error("Release input path contains a control character and cannot be represented safely");
    }
    result.add(absolutePath);
  };

  for (const input of inputs) {
    const absolutePath = resolve(base, input);
    if (!existsSync(absolutePath)) throw new Error(`Release input does not exist: ${input}`);
    visit(absolutePath);
  }
  return [...result].sort((left, right) => normalizePath(relative(base, left)).localeCompare(normalizePath(relative(base, right))));
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function createChecksumManifest({ base, inputs, output }) {
  const absoluteBase = resolve(base);
  const absoluteOutput = resolve(absoluteBase, output);
  if (!isInside(absoluteBase, absoluteOutput)) throw new Error("Checksum output must be inside --base");
  const files = collectFiles(absoluteBase, inputs, absoluteOutput);
  if (files.length === 0) throw new Error("No release files were selected");
  const lines = [];
  for (const file of files) {
    lines.push(`${await sha256(file)}  ${normalizePath(relative(absoluteBase, file))}`);
  }
  mkdirSync(dirname(absoluteOutput), { recursive: true });
  writeFileSync(absoluteOutput, `${lines.join("\n")}\n`, "utf8");
  return { output: normalizePath(relative(absoluteBase, absoluteOutput)), files: files.length, lines };
}

export async function verifyChecksumManifest({ base, manifest }) {
  const absoluteBase = resolve(base);
  const absoluteManifest = resolve(absoluteBase, manifest);
  if (!isInside(absoluteBase, absoluteManifest)) throw new Error("Checksum manifest must be inside --base");
  const content = readFileSync(absoluteManifest, "utf8");
  const entries = content.split(/\r?\n/).filter(Boolean);
  if (entries.length === 0) throw new Error("Checksum manifest is empty");
  const failures = [];
  for (const [index, entry] of entries.entries()) {
    const match = /^([a-f0-9]{64})  ([^\r\n]+)$/.exec(entry);
    if (!match) {
      failures.push({ line: index + 1, path: "[invalid entry]", reason: "FORMAT" });
      continue;
    }
    const expected = match[1];
    const relativePath = match[2];
    const absolutePath = resolve(absoluteBase, relativePath);
    if (!isInside(absoluteBase, absolutePath)) {
      failures.push({ line: index + 1, path: relativePath, reason: "PATH_ESCAPE" });
    } else if (!existsSync(absolutePath)) {
      failures.push({ line: index + 1, path: relativePath, reason: "MISSING" });
    } else if (lstatSync(absolutePath).isSymbolicLink()) {
      failures.push({ line: index + 1, path: relativePath, reason: "SYMLINK" });
    } else {
      const actual = await sha256(absolutePath);
      if (actual !== expected) failures.push({ line: index + 1, path: relativePath, reason: "MISMATCH" });
    }
  }
  return { status: failures.length === 0 ? "PASS" : "FAIL", files: entries.length, failures };
}

async function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.verify) {
      if (options.output || options.inputs.length > 0) throw new Error("--verify cannot be combined with --output or inputs");
      const result = await verifyChecksumManifest({ base: options.base, manifest: options.verify });
      if (result.status === "FAIL") {
        for (const failure of result.failures) console.error(`${failure.path}: ${failure.reason}`);
        process.exitCode = 1;
      } else {
        console.log(`Checksum verification PASS: ${result.files} file(s).`);
      }
      return;
    }
    if (!options.output) throw new Error("--output is required when creating a checksum manifest");
    if (options.inputs.length === 0) throw new Error("At least one release file or directory is required");
    const result = await createChecksumManifest({ base: options.base, inputs: options.inputs, output: options.output });
    console.log(`Wrote ${result.output} for ${result.files} file(s).`);
  } catch (error) {
    console.error(`Checksum operation failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  await main();
}
