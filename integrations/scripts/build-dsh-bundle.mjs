#!/usr/bin/env node

import { copyFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..', '..')
const sourceRoot = resolve(repoRoot, 'plugins', 'agent-coach', 'scripts')
const targetRoot = resolve(repoRoot, 'integrations', 'dsh', 'runtime')
const runtimeFiles = ['action-classifier.mjs', 'gateway-client.mjs', 'mcp-entry.mjs']

export async function buildDshBundle() {
  await mkdir(targetRoot, { recursive: true })
  for (const file of runtimeFiles) {
    await readFile(resolve(sourceRoot, file))
    await copyFile(resolve(sourceRoot, file), resolve(targetRoot, file))
  }
  return { targetRoot, files: [...runtimeFiles] }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await buildDshBundle()
  process.stdout.write(`${JSON.stringify({ status: 'built', target: 'integrations/dsh/runtime', files: result.files })}\n`)
}
