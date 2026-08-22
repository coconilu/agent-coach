#!/usr/bin/env node

import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { createMockGateway, execFileAsync } from './test-helpers.mjs'

const dshRepo = process.env.DSH_REPO
if (!dshRepo) throw new Error('Set DSH_REPO to a DeepSeek Harness 0.1.0-rc.7 checkout.')
const repoRoot = resolve(import.meta.dirname, '..', '..')
const bundle = resolve(repoRoot, 'integrations', 'dsh')
const home = await mkdtemp(resolve(tmpdir(), 'agent-coach-dsh-home-'))
const packDirectory = await mkdtemp(resolve(tmpdir(), 'agent-coach-dsh-pack-'))
const sentinel = resolve(home, 'sentinel.txt')
await writeFile(sentinel, 'preserve-me')
const env = { ...process.env, DSH_HOME: home }
const run = async (...args) => process.platform === 'win32'
  ? execFileAsync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'pnpm.cmd', 'dsh', ...args], { env, cwd: dshRepo, timeout: 120000 })
  : execFileAsync('pnpm', ['dsh', ...args], { env, cwd: dshRepo, timeout: 120000 })

const runNpm = async (...args) => process.platform === 'win32'
  ? execFileAsync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm.cmd', ...args], { cwd: bundle, timeout: 120000 })
  : execFileAsync('npm', args, { cwd: bundle, timeout: 120000 })

assert.match((await run('--version')).stdout, /0\.1\.0-rc\.7/)
await runNpm('pack', '--pack-destination', packDirectory)
const packedName = (await readdir(packDirectory)).find((name) => name.endsWith('.tgz'))
assert.ok(packedName)
const packedBundle = resolve(packDirectory, packedName)
await run('plugin', '--profile', 'agent-coach-canary', 'add', packedBundle)
const composed = await run('--profile', 'agent-coach-canary', '--dump-config')
assert.match(composed.stdout, /@agent-coach\/dsh/)
const profileDir = resolve(home, 'profiles', 'agent-coach-canary')
const loaded = await execFileAsync(process.execPath, [
  '--input-type=module',
  '--eval',
  "const plugin = await import('@agent-coach/dsh'); process.stdout.write(plugin.name)",
], { cwd: profileDir, env, timeout: 30_000 })
assert.equal(loaded.stdout, 'agent-coach')

const gatewayHome = await mkdtemp(resolve(tmpdir(), 'agent-coach-dsh-gateway-'))
const gateway = await createMockGateway(gatewayHome, (request) => ({
  body: request.url === '/v1/gates/check' ? { allowed: true, reason: 'Synthetic active epoch.' } : {},
}))
const previousCoachHome = process.env.AGENT_COACH_HOME
process.env.AGENT_COACH_HOME = gatewayHome
try {
  const installedEntry = resolve(profileDir, 'node_modules', '@agent-coach', 'dsh', 'index.mjs')
  const plugin = await import(pathToFileURL(installedEntry).href)
  const handlers = new Map()
  const mounted = []
  const ctx = {
    plugin(value, config) { mounted.push({ value, config }) },
    on(event, handler) { handlers.set(event, handler) },
    logger() { return { warn() {} } },
  }
  await plugin.apply(ctx, { mode: 'enforce' })
  assert.equal(mounted[0].config.serverName, 'agent_coach')
  const agent = {
    id: 'synthetic-dsh-session',
    session: { header: { cwd: '<SYNTHETIC_HOME>/dsh-project' } },
  }
  const signal = new AbortController().signal
  const preStep = await handlers.get('agent/pre-step')(
    { agent, turn: 1, step: 1, messages: [], signal },
    async () => ({ kind: 'enter', messages: [] }),
  )
  assert.equal(preStep.kind, 'enter')
  const bootstrap = preStep.messages.at(-1).content[0].text
  assert.match(bootstrap, /Agent Coach turn identity/)
  assert.doesNotMatch(bootstrap, /synthetic-dsh-session|SYNTHETIC_HOME/)

  const gateDecision = await handlers.get('tools/pre-execute')(
    { name: 'apply_patch', arguments: { command: 'SYNTHETIC_DSH_PATCH' }, callId: 'synthetic-dsh-tool', agent, signal },
    async () => ({ kind: 'allow' }),
  )
  assert.deepEqual(gateDecision, { kind: 'allow' })
  assert.equal(gateway.requests.at(-1).url, '/v1/gates/check')
  assert.doesNotMatch(JSON.stringify(gateway.requests.at(-1).body), /SYNTHETIC_DSH_PATCH/)
} finally {
  if (previousCoachHome === undefined) delete process.env.AGENT_COACH_HOME
  else process.env.AGENT_COACH_HOME = previousCoachHome
  await gateway.close()
}
await run('plugin', '--profile', 'agent-coach-canary', 'remove', '@agent-coach/dsh')
assert.equal(await readFile(sentinel, 'utf8'), 'preserve-me')
process.stdout.write(`${JSON.stringify({ host: 'dsh', status: 'PASS', isolated_home: true, sentinel: 'preserved' })}\n`)
