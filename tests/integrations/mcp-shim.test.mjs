import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'
import test from 'node:test'

import { createMockGateway } from './test-helpers.mjs'

const repoRoot = resolve(import.meta.dirname, '..', '..')
const entry = resolve(repoRoot, 'plugins', 'agent-coach', 'scripts', 'mcp-entry.mjs')

function startClient(home) {
  const child = spawn(process.execPath, [entry], {
    env: { ...process.env, AGENT_COACH_HOME: home },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const pending = new Map()
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => { stderr += chunk })
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
    const message = JSON.parse(line)
    const waiter = pending.get(message.id)
    if (waiter) {
      pending.delete(message.id)
      waiter.resolve(message)
    }
  })
  let id = 0
  return {
    child,
    stderr: () => stderr,
    request(method, params = {}) {
      id += 1
      const current = id
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: current, method, params })}\n`)
      return new Promise((resolveRequest, reject) => {
        const timeout = setTimeout(() => reject(new Error(`MCP timeout: ${method}`)), 3000)
        pending.set(current, {
          resolve: (message) => {
            clearTimeout(timeout)
            resolveRequest(message)
          },
        })
      })
    },
  }
}

test('offline shim initializes and lists six tools without touching the Gateway', async () => {
  const home = await mkdtemp(resolve(tmpdir(), 'agent-coach-mcp-offline-'))
  const client = startClient(home)
  try {
    const started = performance.now()
    const initialized = await client.request('initialize', { protocolVersion: '2025-06-18' })
    assert.equal(initialized.result.serverInfo.name, 'agent-coach')
    const listed = await client.request('tools/list')
    assert.ok(performance.now() - started < 1500)
    assert.deepEqual(listed.result.tools.map((tool) => tool.name), [
      'coach_prepare',
      'coach_commit_plan',
      'coach_search',
      'coach_explain',
      'coach_complete',
      'coach_feedback',
    ])
    const called = await client.request('tools/call', { name: 'coach_search', arguments: { query: 'x' } })
    assert.equal(called.result.isError, true)
    assert.equal(called.result.structuredContent.degraded, true)
    assert.equal(client.stderr(), '')
  } finally {
    client.child.stdin.end()
    await new Promise((resolveExit) => client.child.once('exit', resolveExit))
  }
})

test('online shim flattens TurnRef into the documented HTTP commit contract', async () => {
  const home = await mkdtemp(resolve(tmpdir(), 'agent-coach-mcp-online-'))
  const gateway = await createMockGateway(home, (request) => ({ body: { ok: true, path: request.url } }))
  const client = startClient(home)
  try {
    await client.request('initialize', { protocolVersion: '2025-06-18' })
    const called = await client.request('tools/call', {
      name: 'coach_commit_plan',
      arguments: {
        turn_ref: {
          project_id: 'synthetic-project',
          host: 'codex',
          session_id: 'synthetic-session',
          turn_id: 'synthetic-turn',
        },
        packet_id: 'synthetic-packet',
        revised_plan: { summary: 'Synthetic plan', steps: [], intended_tools: [], target_paths: [] },
        adoption: [],
        idempotency_key: 'synthetic-idempotency',
      },
    })
    assert.equal(called.result.isError, undefined)
    assert.equal(gateway.requests[0].url, '/v1/turns/synthetic-turn/commit')
    assert.equal(gateway.requests[0].body.turn_ref, undefined)
    assert.equal(gateway.requests[0].body.project_id, 'synthetic-project')
    assert.equal(gateway.requests[0].body.turn_id, 'synthetic-turn')
  } finally {
    client.child.stdin.end()
    await new Promise((resolveExit) => client.child.once('exit', resolveExit))
    await gateway.close()
  }
})
