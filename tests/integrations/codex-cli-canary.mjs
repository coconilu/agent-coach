#!/usr/bin/env node

import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { execFileAsync } from './test-helpers.mjs'

const repoRoot = resolve(import.meta.dirname, '..', '..')
const home = await mkdtemp(resolve(tmpdir(), 'agent-coach-codex-home-'))
const sentinel = resolve(home, 'sentinel.txt')
await writeFile(sentinel, 'preserve-me')
const env = { ...process.env, CODEX_HOME: home }

const run = async (...args) => execFileAsync('codex', args, { env, cwd: repoRoot, timeout: 30000 })

async function installedFiles(directory) {
  const files = []
  const walk = async (current) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = resolve(current, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) files.push(path.replaceAll('\\', '/'))
    }
  }
  await walk(directory)
  return files
}

await run('plugin', 'marketplace', 'add', repoRoot, '--json')
await run('plugin', 'add', 'agent-coach@agent-coach', '--json')
const listed = JSON.parse((await run('plugin', 'list', '--json')).stdout)
assert.match(JSON.stringify(listed), /agent-coach/)
const files = await installedFiles(home)
assert.ok(files.some((path) => path.endsWith('/.codex-plugin/plugin.json')))
assert.ok(files.some((path) => path.endsWith('/hooks/hooks.json')))
assert.ok(files.some((path) => path.endsWith('/.mcp.json')))
assert.ok(files.some((path) => path.endsWith('/skills/agent-coach/SKILL.md')))
await run('plugin', 'remove', 'agent-coach@agent-coach', '--json')
await run('plugin', 'marketplace', 'remove', 'agent-coach')
assert.equal(await readFile(sentinel, 'utf8'), 'preserve-me')
process.stdout.write(`${JSON.stringify({ host: 'codex', status: 'PASS', isolated_home: true, sentinel: 'preserved' })}\n`)
