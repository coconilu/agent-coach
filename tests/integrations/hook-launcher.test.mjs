import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'

import { createMockGateway, spawnWithInput } from './test-helpers.mjs'

const repoRoot = resolve(import.meta.dirname, '..', '..')
const hook = resolve(repoRoot, 'plugins', 'agent-coach', 'scripts', 'hook-entry.mjs')

async function fixture(name) {
  return readFile(resolve(import.meta.dirname, 'fixtures', name), 'utf8')
}

test('UserPromptSubmit forwards bounded metadata and never the raw hook payload', async () => {
  const home = await mkdtemp(resolve(tmpdir(), 'agent-coach-hook-'))
  const gateway = await createMockGateway(home, () => ({ body: { additional_context: 'Synthetic coaching context.' } }))
  try {
    const input = await fixture('codex-user-prompt.json')
    const result = await spawnWithInput(process.execPath, [hook, '--host', 'codex'], {
      env: { ...process.env, AGENT_COACH_HOME: home },
      input,
      timeout: 5000,
    })
    assert.equal(result.stderr, '')
    assert.match(result.stdout, /Synthetic coaching context/)
    assert.equal(gateway.requests.length, 1)
    const forwarded = JSON.stringify(gateway.requests[0].body)
    assert.doesNotMatch(forwarded, /SYNTHETIC_PRIVATE_PROMPT_DO_NOT_FORWARD/)
    assert.doesNotMatch(forwarded, /synthetic-session/)
    assert.doesNotMatch(forwarded, /SYNTHETIC_HOME/)
    assert.equal(gateway.requests[0].body.host_event.event_type, 'UserPromptSubmit')
    assert.match(gateway.requests[0].body.goal_summary, /raw hook content was not retained/)
  } finally {
    await gateway.close()
  }
})

test('enforce mode blocks a covered unknown action with model-visible recovery', async () => {
  const home = await mkdtemp(resolve(tmpdir(), 'agent-coach-gate-'))
  const gateway = await createMockGateway(home, (request) => {
    assert.equal(request.url, '/v1/gates/check')
    return {
      status: 409,
      body: {
        error: {
          code: 'ACTION_REQUIRES_COACHING',
          message: 'Call coach_prepare, revise the plan, then call coach_commit_plan.',
        },
      },
    }
  })
  try {
    const result = await spawnWithInput(process.execPath, [hook, '--host', 'codex', '--mode', 'enforce'], {
      env: { ...process.env, AGENT_COACH_HOME: home },
      input: await fixture('codex-pre-tool.json'),
      timeout: 5000,
    })
    const output = JSON.parse(result.stdout)
    assert.equal(output.hookSpecificOutput.permissionDecision, 'deny')
    assert.match(output.hookSpecificOutput.permissionDecisionReason, /coach_prepare/)
    const forwarded = JSON.stringify(gateway.requests[0].body)
    assert.doesNotMatch(forwarded, /SYNTHETIC_PRIVATE_ARGUMENT/)
    assert.doesNotMatch(forwarded, /Set-Content/)
    assert.equal(gateway.requests[0].body.host_event.action_class, 'unknown')
    assert.equal(gateway.requests[0].body.host, 'codex')
    assert.equal(gateway.requests[0].body.action_name, 'Bash')
    assert.equal(gateway.requests[0].body.action_arguments.constructor, Object)
  } finally {
    await gateway.close()
  }
})

test('gateway outage is fast, fail-open, and explicitly degraded', async () => {
  const home = await mkdtemp(resolve(tmpdir(), 'agent-coach-offline-'))
  const started = performance.now()
  const result = await spawnWithInput(process.execPath, [hook, '--host', 'kimi', '--mode', 'enforce'], {
    env: { ...process.env, AGENT_COACH_HOME: home },
    input: await fixture('codex-pre-tool.json'),
    timeout: 5000,
  })
  assert.ok(performance.now() - started < 2000)
  assert.equal(result.stderr, '')
  assert.match(result.stdout, /degraded/i)
  assert.doesNotMatch(result.stdout, /SYNTHETIC_PRIVATE_ARGUMENT/)
})

test('Kimi array prompts get a fresh pseudonymous turn and PreToolUse requests active-turn resolution', async () => {
  const home = await mkdtemp(resolve(tmpdir(), 'agent-coach-kimi-wire-'))
  const gateway = await createMockGateway(home, (request) => {
    if (request.url === '/v1/gates/check') {
      return { body: { allowed: true, reason: 'Synthetic active epoch.' } }
    }
    return { body: {} }
  })
  try {
    const prompt = await spawnWithInput(process.execPath, [hook, '--host', 'kimi'], {
      env: { ...process.env, AGENT_COACH_HOME: home },
      input: await fixture('kimi-user-prompt.json'),
      timeout: 5000,
    })
    assert.match(prompt.stdout, /Agent Coach turn identity/)
    const observed = JSON.stringify(gateway.requests[0].body)
    assert.doesNotMatch(observed, /SYNTHETIC_KIMI_PROMPT_DO_NOT_FORWARD/)
    assert.equal(gateway.requests[0].body.host_event.event_type, 'UserPromptSubmit')

    await spawnWithInput(process.execPath, [hook, '--host', 'kimi', '--mode', 'enforce'], {
      env: { ...process.env, AGENT_COACH_HOME: home },
      input: await fixture('kimi-pre-tool.json'),
      timeout: 5000,
    })
    assert.equal(gateway.requests[1].url, '/v1/gates/check')
    assert.equal(gateway.requests[1].body.resolve_active_turn, true)
    assert.doesNotMatch(JSON.stringify(gateway.requests[1].body), /SYNTHETIC_KIMI_ARGUMENT/)
  } finally {
    await gateway.close()
  }
})
