import { fileURLToPath } from 'node:url'

import { createUserMessage } from '@deepseek-ai/dsh-llm'

import { classifyAction } from './runtime/action-classifier.mjs'
import {
  digestJson,
  isCoachingDenial,
  pseudonymize,
  requestGateway,
  resolveGatewayConnection,
  safeGatewayFailure,
} from './runtime/gateway-client.mjs'

export const name = 'agent-coach'

const SERVER_NAME = 'agent_coach'
const warnedFailures = new Set()

function normalizedMode(value) {
  return String(value ?? '').toLowerCase() === 'enforce' ? 'enforce' : 'advisory'
}

function boundedReason(value) {
  return typeof value === 'string' && value.length > 0
    ? value.slice(0, 2000)
    : 'Agent Coach requires coach_prepare and coach_commit_plan before this covered action.'
}

function warnOnce(logger, error) {
  const failure = safeGatewayFailure(error)
  if (warnedFailures.has(failure.code)) return
  warnedFailures.add(failure.code)
  logger?.warn?.(`[Agent Coach degraded: ${failure.code}] Gateway unavailable; DSH continues fail-open.`)
}

function agentIdentity(agent) {
  return agent?.id === undefined ? '' : String(agent.id)
}

function eventIdentity(connection, agent, turn, event, seed) {
  const session = agentIdentity(agent)
  const sessionRef = pseudonymize(connection.token, 'dsh:session', session)
  const turnRef = pseudonymize(connection.token, 'dsh:turn', `${session}\0${turn ?? ''}`)
  const project = agent?.session?.header?.cwd ?? ''
  return {
    project_ref: pseudonymize(connection.token, 'dsh:project', project),
    session_ref: sessionRef,
    turn_ref: turnRef,
    event_ref: pseudonymize(connection.token, 'dsh:event', `${session}\0${turn ?? ''}\0${event}\0${seed ?? ''}`),
  }
}

function bootstrapText(identity) {
  return [
    'Agent Coach turn identity (safe pseudonymous values):',
    `project_id=${identity.project_ref}`,
    'host=dsh',
    `session_id=${identity.session_ref}`,
    `turn_id=${identity.turn_ref}`,
    'Use these exact values in coach_prepare. Reuse GuidancePacket.turn_ref for coach_commit_plan and coach_complete.',
  ].join('\n')
}

async function observe(connection, hostEvent, signal) {
  return requestGateway('/v1/turns/observe', {
    method: 'POST',
    body: {
      project_id: hostEvent.project_ref,
      host: hostEvent.host,
      session_id: hostEvent.session_ref,
      turn_id: hostEvent.turn_ref,
      task_type: hostEvent.event,
      goal_summary: `Observed ${hostEvent.event}; raw DSH payload was not retained.`,
      idempotency_key: hostEvent.event_ref,
      host_event: {
        event_type: hostEvent.event,
        ...(hostEvent.action ? {
          action_name: hostEvent.action.tool_name,
          action_class: hostEvent.action.class,
        } : {}),
        ...(hostEvent.outcome ? {
          outcome_status: hostEvent.outcome.is_error ? 'failed' : 'succeeded',
        } : {}),
      },
    },
    signal,
  }, { connection, clientName: 'dsh-native' })
}

export async function apply(ctx, config = {}) {
  const McpClient = await import('@deepseek-ai/dsh-mcp-client')
  const entry = fileURLToPath(new URL('./runtime/mcp-entry.mjs', import.meta.url))
  const mode = normalizedMode(config.mode ?? process.env.AGENT_COACH_MODE)
  const activeTurns = new WeakMap()
  const logger = typeof ctx.logger === 'function' ? ctx.logger('agent-coach') : console

  ctx.plugin(McpClient, {
    serverName: SERVER_NAME,
    transport: 'stdio',
    command: process.execPath,
    args: [entry],
    failOnStartupError: false,
  })

  ctx.on('agent/pre-step', async (payload, next) => {
    activeTurns.set(payload.agent, payload.turn)
    if (payload.step !== 1) return next()
    let identity
    try {
      const connection = await resolveGatewayConnection()
      identity = eventIdentity(connection, payload.agent, payload.turn, 'UserPromptSubmit', payload.step)
      await observe(connection, {
        schema_version: 1,
        host: 'dsh',
        event: 'UserPromptSubmit',
        mode,
        ...identity,
        prompt: { present: payload.messages.length > 0, count: payload.messages.length },
      }, payload.signal)
    } catch (error) {
      warnOnce(logger, error)
    }
    const decision = await next()
    if (!identity || decision.kind === 'reject' || payload.signal.aborted) return decision
    const text = bootstrapText(identity)
    return {
      kind: 'enter',
      messages: [
        ...decision.messages,
        createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'plugin', plugin: name, form: 'snapshot', sections: [{ name, text }] },
        }),
      ],
    }
  })

  ctx.on('tools/pre-execute', async (exec, next) => {
    const classification = classifyAction(exec.name, exec.arguments)
    if (classification.class === 'read') return next()
    let identity
    try {
      const connection = await resolveGatewayConnection()
      const turn = exec.agent ? activeTurns.get(exec.agent) : undefined
      identity = eventIdentity(connection, exec.agent, turn, 'PreToolUse', exec.callId)
      const hostEvent = {
        schema_version: 1,
        host: 'dsh',
        event: 'PreToolUse',
        mode,
        ...identity,
        action: {
          tool_name: exec.name,
          ...classification,
          input_ref: digestJson(connection.token, 'dsh:tool-input', exec.arguments),
        },
      }
      const response = await requestGateway('/v1/gates/check', {
        method: 'POST',
        body: {
          project_id: hostEvent.project_ref,
          host: hostEvent.host,
          session_id: hostEvent.session_ref,
          turn_id: hostEvent.turn_ref,
          action_name: hostEvent.action.tool_name,
          action_arguments: {},
          mode,
          gateway_healthy: true,
          idempotency_key: hostEvent.event_ref,
          host_classification: hostEvent.action,
          host_event: {
            event_type: hostEvent.event,
            action_name: hostEvent.action.tool_name,
            action_class: hostEvent.action.class,
          },
        },
        signal: exec.signal,
      }, { connection, clientName: 'dsh-native' })
      if (mode === 'enforce' && (String(response?.decision).toLowerCase() === 'deny' || response?.allowed === false)) {
        return { kind: 'deny', reason: `${boundedReason(response.reason ?? response.message)}\n\n${bootstrapText(identity)}` }
      }
    } catch (error) {
      if (mode === 'enforce' && isCoachingDenial(error)) {
        return { kind: 'deny', reason: identity
          ? `${boundedReason(error.message)}\n\n${bootstrapText(identity)}`
          : boundedReason(error.message) }
      }
      warnOnce(logger, error)
    }
    return next()
  })

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    try {
      const connection = await resolveGatewayConnection()
      const turn = exec.agent ? activeTurns.get(exec.agent) : undefined
      const identity = eventIdentity(connection, exec.agent, turn, 'PostToolUse', exec.callId)
      await observe(connection, {
        schema_version: 1,
        host: 'dsh',
        event: 'PostToolUse',
        mode,
        ...identity,
        outcome: { tool_name: exec.name, is_error: Boolean(result.isError) },
      }, exec.signal)
    } catch (error) {
      warnOnce(logger, error)
    }
    return decision
  })

  ctx.on('agent/turn-stopping', async (payload) => {
    try {
      const connection = await resolveGatewayConnection()
      const identity = eventIdentity(connection, payload.agent, payload.turn, 'Stop', payload.turn)
      await observe(connection, {
        schema_version: 1,
        host: 'dsh',
        event: 'Stop',
        mode,
        ...identity,
      }, payload.signal)
    } catch (error) {
      warnOnce(logger, error)
    }
  })
}
