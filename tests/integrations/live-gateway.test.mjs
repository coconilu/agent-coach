#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'

import { spawnWithInput } from './test-helpers.mjs'

// CI builds the TypeScript runtime before running this assembled host canary.
const repoRoot = resolve(import.meta.dirname, '..', '..')
const home = await mkdtemp(resolve(tmpdir(), 'agent-coach-live-home-'))
const knowledgeHome = await mkdtemp(resolve(tmpdir(), 'agent-coach-live-knowledge-'))
const sentinel = resolve(home, 'sentinel.txt')
await writeFile(sentinel, 'preserve-me')
const daemon = spawn(process.execPath, [
  resolve(repoRoot, 'dist', 'cli.js'),
  'start',
  '--home', home,
  '--knowledge-home', knowledgeHome,
  '--json',
], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] })

async function waitForDiscovery() {
  const path = resolve(home, 'gateway.json')
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    try {
      await access(path)
      return
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 50))
    }
  }
  throw new Error('Gateway discovery timeout')
}

function startMcp() {
  const child = spawn(process.execPath, [resolve(repoRoot, 'plugins', 'agent-coach', 'scripts', 'mcp-entry.mjs')], {
    env: { ...process.env, AGENT_COACH_HOME: home },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const pending = new Map()
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
    const message = JSON.parse(line)
    pending.get(message.id)?.(message)
    pending.delete(message.id)
  })
  let nextId = 0
  return {
    child,
    request(method, params = {}) {
      nextId += 1
      const id = nextId
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      return new Promise((resolveMessage, reject) => {
        const timeout = setTimeout(() => reject(new Error(`MCP timeout: ${method}`)), 5000)
        pending.set(id, (message) => {
          clearTimeout(timeout)
          resolveMessage(message)
        })
      })
    },
  }
}

await waitForDiscovery()
const rawIdentity = {
  session_id: 'synthetic-live-session',
  turn_id: 'synthetic-live-turn',
  cwd: '<SYNTHETIC_HOME>/live-project',
}
const promptHook = await spawnWithInput(process.execPath, [
  resolve(repoRoot, 'plugins', 'agent-coach', 'scripts', 'hook-entry.mjs'),
  '--host', 'codex',
  '--mode', 'enforce',
], {
  env: { ...process.env, AGENT_COACH_HOME: home },
  input: JSON.stringify({
    hook_event_name: 'UserPromptSubmit',
    ...rawIdentity,
    prompt: 'SYNTHETIC_LIVE_PROMPT',
  }),
  timeout: 5000,
})
const bootstrap = JSON.parse(promptHook.stdout).hookSpecificOutput.additionalContext
const fields = Object.fromEntries(
  bootstrap.split('\n').filter((line) => line.includes('=')).map((line) => line.split('=', 2)),
)
assert.equal(fields.host, 'codex')
assert.notEqual(fields.session_id, rawIdentity.session_id)
assert.notEqual(fields.turn_id, rawIdentity.turn_id)

const mcp = startMcp()
try {
  await mcp.request('initialize', { protocolVersion: '2025-06-18' })
  const prepared = await mcp.request('tools/call', {
    name: 'coach_prepare',
    arguments: {
      project_id: fields.project_id,
      host: fields.host,
      session_id: fields.session_id,
      turn_id: fields.turn_id,
      intent: {
        goal: 'Run a synthetic coached mutation',
        task_type: 'implementation',
        planned_steps: ['Inspect', 'Patch', 'Verify'],
        intended_tools: ['apply_patch'],
        target_paths: ['synthetic.txt'],
        constraints: ['Synthetic fixture only'],
        assumptions: [],
        risk_flags: ['writes a synthetic file'],
      },
      idempotency_key: 'synthetic-live-prepare',
    },
  })
  assert.notEqual(prepared.result.isError, true)
  const packet = prepared.result.structuredContent
  const committed = await mcp.request('tools/call', {
    name: 'coach_commit_plan',
    arguments: {
      turn_ref: packet.turn_ref,
      packet_id: packet.packet_id,
      revised_plan: {
        summary: 'Apply one synthetic patch and verify it',
        steps: ['Patch', 'Verify'],
        intended_tools: ['apply_patch'],
        target_paths: ['synthetic.txt'],
      },
      adoption: [],
      idempotency_key: 'synthetic-live-commit',
    },
  })
  assert.equal(typeof committed.result.structuredContent.ticket, 'string')

  const gate = await spawnWithInput(process.execPath, [
    resolve(repoRoot, 'plugins', 'agent-coach', 'scripts', 'hook-entry.mjs'),
    '--host', 'codex',
    '--mode', 'enforce',
  ], {
    env: { ...process.env, AGENT_COACH_HOME: home },
    input: JSON.stringify({
      hook_event_name: 'PreToolUse',
      ...rawIdentity,
      tool_name: 'apply_patch',
      tool_use_id: 'synthetic-live-tool',
      tool_input: { command: 'SYNTHETIC_PATCH_CONTENT' },
    }),
    timeout: 5000,
  })
  assert.equal(gate.stdout, '')

  const completed = await mcp.request('tools/call', {
    name: 'coach_complete',
    arguments: {
      turn_ref: packet.turn_ref,
      outcome_status: 'succeeded',
      outcome_summary: 'Synthetic mutation verified',
      evidence_refs: ['synthetic:test-pass'],
      learning_proposals: [],
      idempotency_key: 'synthetic-live-complete',
    },
  })
  assert.notEqual(completed.result.isError, true)

  const kimiPrompt = await spawnWithInput(process.execPath, [
    resolve(repoRoot, 'plugins', 'agent-coach', 'scripts', 'hook-entry.mjs'),
    '--host', 'kimi',
    '--mode', 'enforce',
  ], {
    env: { ...process.env, AGENT_COACH_HOME: home },
    input: JSON.stringify({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'synthetic-live-kimi-session',
      cwd: '<SYNTHETIC_HOME>/live-kimi-project',
      prompt: [{ type: 'text', text: 'SYNTHETIC_LIVE_KIMI_PROMPT' }],
    }),
    timeout: 5000,
  })
  const kimiFields = Object.fromEntries(
    kimiPrompt.stdout.trim().split('\n').filter((line) => line.includes('=')).map((line) => line.split('=', 2)),
  )
  assert.equal(kimiFields.host, 'kimi')
  const kimiPrepared = await mcp.request('tools/call', {
    name: 'coach_prepare',
    arguments: {
      project_id: kimiFields.project_id,
      host: kimiFields.host,
      session_id: kimiFields.session_id,
      turn_id: kimiFields.turn_id,
      intent: {
        goal: 'Run a synthetic Kimi coached mutation',
        task_type: 'implementation',
        planned_steps: ['Patch', 'Verify'],
        intended_tools: ['Bash'],
        target_paths: ['synthetic-kimi.txt'],
        constraints: ['Synthetic fixture only'],
        assumptions: [],
        risk_flags: ['writes a synthetic file'],
      },
      idempotency_key: 'synthetic-live-kimi-prepare',
    },
  })
  const kimiPacket = kimiPrepared.result.structuredContent
  await mcp.request('tools/call', {
    name: 'coach_commit_plan',
    arguments: {
      turn_ref: kimiPacket.turn_ref,
      packet_id: kimiPacket.packet_id,
      revised_plan: {
        summary: 'Apply one synthetic Kimi patch and verify it',
        steps: ['Patch', 'Verify'],
        intended_tools: ['Bash'],
        target_paths: ['synthetic-kimi.txt'],
      },
      adoption: [],
      idempotency_key: 'synthetic-live-kimi-commit',
    },
  })
  const kimiGate = await spawnWithInput(process.execPath, [
    resolve(repoRoot, 'plugins', 'agent-coach', 'scripts', 'hook-entry.mjs'),
    '--host', 'kimi',
    '--mode', 'enforce',
  ], {
    env: { ...process.env, AGENT_COACH_HOME: home },
    input: JSON.stringify({
      hook_event_name: 'PreToolUse',
      session_id: 'synthetic-live-kimi-session',
      cwd: '<SYNTHETIC_HOME>/live-kimi-project',
      tool_name: 'Bash',
      tool_call_id: 'synthetic-live-kimi-tool',
      tool_input: { command: 'Set-Content synthetic-kimi.txt SYNTHETIC_VALUE' },
    }),
    timeout: 5000,
  })
  assert.equal(kimiGate.stdout, '')
  const kimiPost = await spawnWithInput(process.execPath, [
    resolve(repoRoot, 'plugins', 'agent-coach', 'scripts', 'hook-entry.mjs'),
    '--host', 'kimi',
    '--mode', 'enforce',
  ], {
    env: { ...process.env, AGENT_COACH_HOME: home },
    input: JSON.stringify({
      hook_event_name: 'PostToolUse',
      session_id: 'synthetic-live-kimi-session',
      cwd: '<SYNTHETIC_HOME>/live-kimi-project',
      tool_name: 'Bash',
      tool_call_id: 'synthetic-live-kimi-tool',
      tool_response: { isError: false, text: 'SYNTHETIC_PRIVATE_RESULT' },
    }),
    timeout: 5000,
  })
  assert.equal(kimiPost.stdout, '')
  const kimiCompleted = await mcp.request('tools/call', {
    name: 'coach_complete',
    arguments: {
      turn_ref: kimiPacket.turn_ref,
      outcome_status: 'succeeded',
      outcome_summary: 'Synthetic Kimi mutation verified',
      evidence_refs: ['synthetic:kimi-test-pass'],
      learning_proposals: [],
      idempotency_key: 'synthetic-live-kimi-complete',
    },
  })
  assert.notEqual(kimiCompleted.result.isError, true, JSON.stringify(kimiCompleted.result))
  const kimiStop = await spawnWithInput(process.execPath, [
    resolve(repoRoot, 'plugins', 'agent-coach', 'scripts', 'hook-entry.mjs'),
    '--host', 'kimi',
    '--mode', 'enforce',
  ], {
    env: { ...process.env, AGENT_COACH_HOME: home },
    input: JSON.stringify({
      hook_event_name: 'Stop',
      session_id: 'synthetic-live-kimi-session',
      cwd: '<SYNTHETIC_HOME>/live-kimi-project',
      last_assistant_message: 'SYNTHETIC_PRIVATE_ASSISTANT_RESULT',
    }),
    timeout: 5000,
  })
  assert.equal(kimiStop.stdout, '')
} finally {
  mcp.child.stdin.end()
  await new Promise((resolveExit) => mcp.child.once('exit', resolveExit))
  daemon.kill('SIGTERM')
  await new Promise((resolveExit) => daemon.once('exit', resolveExit))
}

assert.equal(await readFile(sentinel, 'utf8'), 'preserve-me')
process.stdout.write(`${JSON.stringify({ host: 'gateway+hook+mcp', status: 'PASS', sentinel: 'preserved' })}\n`)
