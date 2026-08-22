#!/usr/bin/env node

import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { buildKimiPlugin } from '../../integrations/scripts/build-kimi-plugin.mjs'
import { execFileAsync } from './test-helpers.mjs'

const repoRoot = resolve(import.meta.dirname, '..', '..')
const home = await mkdtemp(resolve(tmpdir(), 'agent-coach-kimi-home-'))
const sentinel = resolve(home, 'sentinel.txt')
await writeFile(sentinel, 'preserve-me')
const version = await execFileAsync('kimi', ['--version'], { env: { ...process.env, KIMI_CODE_HOME: home }, timeout: 10_000 })
assert.equal(version.stdout.trim(), '0.38.0')
const artifact = await buildKimiPlugin({ repoRoot, outputPath: resolve(home, 'agent-coach-kimi.zip') })
assert.ok(artifact.entries.includes('kimi.plugin.json'))
assert.equal(await readFile(sentinel, 'utf8'), 'preserve-me')
process.stdout.write(`${JSON.stringify({
  host: 'kimi',
  version: '0.38.0',
  package: 'PASS',
  install: 'MANUAL_STEP_REQUIRED',
  reason: 'Remote installs accept the release ZIP URL. For a local H1, extract the ZIP and pass the extracted directory to the interactive /plugins install command, then /reload.',
  sentinel: 'preserved',
})}\n`)
