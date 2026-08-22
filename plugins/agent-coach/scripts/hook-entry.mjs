#!/usr/bin/env node

import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

import { classifyAction } from './action-classifier.mjs'
import {
  digestJson,
  isCoachingDenial,
  pseudonymize,
  requestGateway,
  resolveGatewayConnection,
  safeGatewayFailure,
} from './gateway-client.mjs'

const MAX_STDIN_BYTES = 1024 * 1024
const MAX_CONTEXT_CHARS = 6000

function option(argv, name, fallback) {
  const index = argv.indexOf(name)
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback
}

async function readPayload(stream = process.stdin) {
  stream.setEncoding('utf8')
  let input = ''
  for await (const chunk of stream) {
    input += chunk
    if (Buffer.byteLength(input, 'utf8') > MAX_STDIN_BYTES) throw new Error('HOOK_PAYLOAD_TOO_LARGE')
  }
  const parsed = JSON.parse(input || '{}')
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('HOOK_PAYLOAD_INVALID')
  return parsed
}

function bytes(value) {
  if (typeof value !== 'string') return 0
  return Buffer.byteLength(value, 'utf8')
}

function eventName(payload) {
  return String(payload.hook_event_name ?? payload.hookEventName ?? 'Unknown')
}

function normalizePayload(payload, { host, mode, token }) {
  const event = eventName(payload)
  const session = payload.session_id ?? payload.sessionId ?? ''
  const turn = payload.turn_id ?? payload.turnId ?? ''
  const toolUse = payload.tool_use_id ?? payload.toolUseId ?? payload.tool_call_id ?? ''
  const prompt = typeof payload.prompt === 'string' || Array.isArray(payload.prompt) ? payload.prompt : null
  const promptPresent = typeof prompt === 'string' ? prompt.length > 0 : Array.isArray(prompt) && prompt.length > 0
  const promptRef = promptPresent ? digestJson(token, `${host}:prompt`, prompt) : ''
  const lastMessage = typeof payload.last_assistant_message === 'string' ? payload.last_assistant_message : ''
  const toolName = payload.tool_name ?? payload.toolName
  const toolInput = payload.tool_input ?? payload.toolInput
  const toolResponse = payload.tool_response ?? payload.toolResponse
  const fallbackTurn = !turn && event === 'UserPromptSubmit' ? randomUUID() : ''
  const eventSeed = toolUse || turn || fallbackTurn || promptRef || lastMessage || event
  const normalized = {
    schema_version: 1,
    host,
    event,
    mode,
    session_ref: pseudonymize(token, `${host}:session`, session),
    turn_ref: turn
      ? pseudonymize(token, `${host}:turn`, `${session}\0${turn}`)
      : fallbackTurn
        ? pseudonymize(token, `${host}:turn-fallback`, `${session}\0${fallbackTurn}`)
        : null,
    event_ref: pseudonymize(token, `${host}:event`, `${session}\0${event}\0${eventSeed}`),
    project_ref: pseudonymize(token, `${host}:project`, payload.cwd ?? ''),
    prompt: promptPresent ? {
      present: true,
      bytes: Buffer.byteLength(typeof prompt === 'string' ? prompt : JSON.stringify(prompt), 'utf8'),
    } : undefined,
    assistant_output: lastMessage ? { present: true, bytes: bytes(lastMessage) } : undefined,
  }
  if (event === 'PreToolUse') {
    normalized.action = {
      tool_name: String(toolName ?? ''),
      ...classifyAction(toolName, toolInput),
      input_ref: digestJson(token, `${host}:tool-input`, toolInput),
    }
  }
  if (event === 'PostToolUse' || event === 'PostToolUseFailure') {
    normalized.outcome = {
      tool_name: String(toolName ?? ''),
      is_error: event === 'PostToolUseFailure' || Boolean(toolResponse?.isError),
      response_bytes: bytes(typeof toolResponse === 'string' ? toolResponse : JSON.stringify(toolResponse ?? null)),
    }
  }
  return Object.fromEntries(Object.entries(normalized).filter(([, value]) => value !== undefined))
}

function turnFields(normalized) {
  return {
    project_id: normalized.project_ref,
    host: normalized.host,
    session_id: normalized.session_ref,
    turn_id: normalized.turn_ref ?? normalized.event_ref,
  }
}

function observeBody(normalized) {
  const hostEvent = {
    event_type: normalized.event,
    ...(normalized.action ? {
      action_name: normalized.action.tool_name,
      action_class: normalized.action.class,
    } : {}),
    ...(normalized.outcome ? {
      outcome_status: normalized.outcome.is_error ? 'failed' : 'succeeded',
    } : {}),
  }
  return {
    ...turnFields(normalized),
    task_type: normalized.event,
    goal_summary: `Observed ${normalized.event}; raw hook content was not retained.`,
    idempotency_key: normalized.event_ref,
    ...(normalized.host === 'kimi' && normalized.turn_ref === null && normalized.event !== 'UserPromptSubmit'
      ? { resolve_active_turn: true }
      : {}),
    host_event: hostEvent,
  }
}

function gateBody(normalized) {
  return {
    ...turnFields(normalized),
    action_name: normalized.action.tool_name,
    action_arguments: {},
    mode: normalized.mode,
    gateway_healthy: true,
    ...(normalized.host === 'kimi' && normalized.turn_ref === null ? { resolve_active_turn: true } : {}),
    idempotency_key: normalized.event_ref,
    host_classification: normalized.action,
    host_event: {
      event_type: normalized.event,
      action_name: normalized.action.tool_name,
      action_class: normalized.action.class,
    },
  }
}

function boundedContext(value) {
  return typeof value === 'string' ? value.slice(0, MAX_CONTEXT_CHARS) : ''
}

function denyOutput(host, reason) {
  const message = boundedContext(reason) || 'Agent Coach requires coach_prepare and coach_commit_plan before this covered action.'
  if (host === 'codex') {
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: message,
      },
    })
  }
  return JSON.stringify({
    hookSpecificOutput: {
      permissionDecision: 'deny',
      permissionDecisionReason: message,
    },
  })
}

function contextOutput(host, event, context) {
  const message = boundedContext(context)
  if (!message) return ''
  if (host === 'kimi') return message
  if (event === 'UserPromptSubmit' || event === 'PreToolUse') {
    return JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: message } })
  }
  return JSON.stringify({ systemMessage: message })
}

function bootstrapContext(normalized) {
  const identity = turnFields(normalized)
  return [
    'Agent Coach turn identity (safe pseudonymous values):',
    `project_id=${identity.project_id}`,
    `host=${identity.host}`,
    `session_id=${identity.session_id}`,
    `turn_id=${identity.turn_id}`,
    'Use these exact values in coach_prepare. Reuse GuidancePacket.turn_ref for coach_commit_plan and coach_complete.',
  ].join('\n')
}

function stopOutput(reason) {
  return JSON.stringify({ decision: 'block', reason: boundedContext(reason) })
}

function degradedOutput(host, event, failure) {
  if (event !== 'UserPromptSubmit' && event !== 'PreToolUse') return ''
  const detail = safeGatewayFailure(failure)
  return contextOutput(host, event, `[Agent Coach degraded: ${detail.code}] Gateway unavailable; continuing fail-open under the host's normal permissions.`)
}

async function dispatchHook(payload, options) {
  const event = eventName(payload)
  let connection
  try {
    connection = await resolveGatewayConnection()
  } catch (error) {
    return degradedOutput(options.host, event, error)
  }
  const normalized = normalizePayload(payload, { ...options, token: connection.token })
  let response
  try {
    if (event === 'PreToolUse' && normalized.action?.class !== 'read') {
      response = await requestGateway('/v1/gates/check', {
        method: 'POST',
        body: gateBody(normalized),
      }, { connection, clientName: `${options.host}-hook` })
    } else {
      response = await requestGateway('/v1/turns/observe', {
        method: 'POST',
        body: observeBody(normalized),
      }, { connection, clientName: `${options.host}-hook` })
    }
  } catch (error) {
    if (event === 'PreToolUse' && options.mode === 'enforce' && isCoachingDenial(error)) {
      return denyOutput(options.host, `${boundedContext(error.message)}\n\n${bootstrapContext(normalized)}`)
    }
    return degradedOutput(options.host, event, error)
  }

  const decision = String(response?.decision ?? '').toLowerCase()
  const reason = response?.reason ?? response?.message
  if (event === 'PreToolUse' && (decision === 'deny' || response?.allowed === false)) {
    if (options.mode === 'enforce') return denyOutput(options.host, `${boundedContext(reason)}\n\n${bootstrapContext(normalized)}`)
    return contextOutput(options.host, event, reason || 'Agent Coach recommends completing the coaching handshake before this action.')
  }
  if (event === 'Stop' && response?.continue === true) return stopOutput(reason || 'Complete the Agent Coach turn record before stopping.')
  const context = [
    event === 'UserPromptSubmit' ? bootstrapContext(normalized) : '',
    boundedContext(response?.additional_context),
  ].filter(Boolean).join('\n\n')
  return contextOutput(options.host, event, context)
}

export async function runHook(argv = process.argv.slice(2), streams = {}) {
  const host = option(argv, '--host', process.env.AGENT_COACH_HOST || 'codex').toLowerCase()
  const requestedMode = option(argv, '--mode', process.env.AGENT_COACH_MODE || 'advisory').toLowerCase()
  const mode = requestedMode === 'enforce' ? 'enforce' : 'advisory'
  let output = ''
  try {
    const payload = await readPayload(streams.stdin ?? process.stdin)
    output = await dispatchHook(payload, { host, mode })
  } catch (error) {
    output = degradedOutput(host, 'UserPromptSubmit', error)
  }
  if (output) (streams.stdout ?? process.stdout).write(`${output}\n`)
  return 0
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ''
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  runHook().then((code) => { process.exitCode = code })
}

export { normalizePayload }
