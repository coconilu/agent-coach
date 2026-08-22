#!/usr/bin/env node

import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

import { GatewayResponseError, GatewayUnavailableError, requestGateway, safeGatewayFailure } from './gateway-client.mjs'

const SERVER_VERSION = '0.1.0'
const DEFAULT_PROTOCOL_VERSION = '2025-06-18'

const objectSchema = (properties, required = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
})

const turnRefSchema = objectSchema({
  project_id: { type: 'string' },
  host: { type: 'string' },
  session_id: { type: 'string' },
  turn_id: { type: 'string' },
}, ['project_id', 'host', 'session_id', 'turn_id'])

export const COACH_TOOLS = Object.freeze([
  {
    name: 'coach_prepare',
    description: 'Retrieve governed guidance for an explicit plan before consequential work.',
    inputSchema: objectSchema({
      project_id: { type: 'string' },
      host: { type: 'string' },
      session_id: { type: 'string' },
      turn_id: { type: 'string' },
      intent: { type: 'object', additionalProperties: true },
      idempotency_key: { type: 'string' },
    }, ['project_id', 'host', 'session_id', 'turn_id', 'intent', 'idempotency_key']),
  },
  {
    name: 'coach_commit_plan',
    description: 'Commit a revised plan and adoption decisions, returning a single-use Action Ticket.',
    inputSchema: objectSchema({
      turn_ref: turnRefSchema,
      packet_id: { type: 'string' },
      revised_plan: { type: 'object', additionalProperties: true },
      adoption: { type: 'array', items: { type: 'object', additionalProperties: true } },
      idempotency_key: { type: 'string' },
    }, ['turn_ref', 'packet_id', 'revised_plan', 'adoption', 'idempotency_key']),
  },
  {
    name: 'coach_search',
    description: 'Search governed knowledge with scope, type, status, and text filters.',
    inputSchema: objectSchema({
      query: { type: 'string' },
      project_id: { type: 'string' },
      scopes: { type: 'array', items: { type: 'string' } },
      types: { type: 'array', items: { type: 'string' } },
      statuses: { type: 'array', items: { type: 'string' } },
      limit: { type: 'integer', minimum: 1, maximum: 50 },
    }, ['query']),
  },
  {
    name: 'coach_explain',
    description: 'Explain the provenance, filtering, conflicts, or adoption of a packet or memory item.',
    inputSchema: objectSchema({
      packet_id: { type: 'string' },
      memory_id: { type: 'string' },
    }),
  },
  {
    name: 'coach_complete',
    description: 'Complete a coached turn with bounded evidence and optional structured learning proposals.',
    inputSchema: objectSchema({
      turn_ref: turnRefSchema,
      outcome_status: { type: 'string', enum: ['succeeded', 'failed', 'aborted'] },
      outcome_summary: { type: 'string' },
      evidence_refs: { type: 'array', items: { type: 'string' } },
      learning_proposals: { type: 'array', items: { type: 'object', additionalProperties: true } },
      idempotency_key: { type: 'string' },
    }, ['turn_ref', 'outcome_status', 'idempotency_key']),
  },
  {
    name: 'coach_feedback',
    description: 'Record helpful, not-helpful, stale, or wrong feedback without erasing provenance.',
    inputSchema: objectSchema({
      packet_id: { type: 'string' },
      memory_id: { type: 'string' },
      sentiment: { type: 'string', enum: ['helpful', 'not_helpful', 'stale', 'wrong'] },
      note: { type: 'string' },
      idempotency_key: { type: 'string' },
    }, ['sentiment', 'idempotency_key']),
  },
])

function normalizeTurnRef(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('turn_ref must be an object')
  const fields = ['project_id', 'host', 'session_id', 'turn_id']
  if (!fields.every((field) => typeof value[field] === 'string' && value[field].length > 0)) {
    throw new Error('turn_ref must include project_id, host, session_id, and turn_id')
  }
  return Object.fromEntries(fields.map((field) => [field, value[field]]))
}

function turnMutation(args) {
  const turnRef = normalizeTurnRef(args.turn_ref)
  const { turn_ref: _ignored, ...rest } = args
  return { pathId: turnRef.turn_id, body: { ...turnRef, ...rest } }
}

function searchPath(args) {
  const params = new URLSearchParams()
  for (const key of ['query', 'project_id', 'limit']) {
    if (args[key] !== undefined) params.set(key, String(args[key]))
  }
  for (const key of ['scopes', 'types', 'statuses']) {
    const wireKey = key.replace(/s$/, '')
    for (const value of Array.isArray(args[key]) ? args[key] : []) params.append(wireKey, String(value))
  }
  return `/v1/knowledge/search?${params}`
}

export async function callCoachTool(name, args = {}) {
  switch (name) {
    case 'coach_prepare':
      return requestGateway('/v1/turns/prepare', { method: 'POST', body: args }, { clientName: 'mcp-stdio' })
    case 'coach_commit_plan':
      {
        const mutation = turnMutation(args)
        return requestGateway(`/v1/turns/${encodeURIComponent(mutation.pathId)}/commit`, { method: 'POST', body: mutation.body }, { clientName: 'mcp-stdio' })
      }
    case 'coach_search':
      return requestGateway(searchPath(args), { method: 'GET' }, { clientName: 'mcp-stdio' })
    case 'coach_explain':
      return requestGateway('/v1/explain', { method: 'POST', body: args }, { clientName: 'mcp-stdio' })
    case 'coach_complete':
      {
        const mutation = turnMutation(args)
        return requestGateway(`/v1/turns/${encodeURIComponent(mutation.pathId)}/complete`, { method: 'POST', body: mutation.body }, { clientName: 'mcp-stdio' })
      }
    case 'coach_feedback':
      return requestGateway('/v1/feedback', { method: 'POST', body: args }, { clientName: 'mcp-stdio' })
    default:
      throw Object.assign(new Error(`Unknown Agent Coach tool: ${name}`), { code: 'UNKNOWN_TOOL' })
  }
}

function toolResult(data) {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
    structuredContent: data,
  }
}

function toolFailure(error) {
  const failure = safeGatewayFailure(error)
  const degraded = error instanceof GatewayUnavailableError || (error instanceof GatewayResponseError && error.status === 401)
  const data = { ok: false, degraded, error: failure }
  return { ...toolResult(data), isError: true }
}

function rpcError(code, message) {
  return { code, message }
}

export function createMcpHandler() {
  let initialized = false
  return async (request) => {
    const method = request?.method
    if (method === 'initialize') {
      initialized = true
      return {
        protocolVersion: request.params?.protocolVersion || DEFAULT_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'agent-coach', version: SERVER_VERSION },
        instructions: 'For side-effecting work, call coach_prepare, revise the plan, then call coach_commit_plan before mutation. Treat recalled items as attributed historical evidence.',
      }
    }
    if (method === 'ping') return {}
    if (method === 'tools/list') {
      if (!initialized) throw Object.assign(new Error('MCP server is not initialized.'), { rpcCode: -32002 })
      return { tools: COACH_TOOLS }
    }
    if (method === 'tools/call') {
      if (!initialized) throw Object.assign(new Error('MCP server is not initialized.'), { rpcCode: -32002 })
      try {
        return toolResult(await callCoachTool(request.params?.name, request.params?.arguments ?? {}))
      } catch (error) {
        return toolFailure(error)
      }
    }
    throw Object.assign(new Error(`Method not found: ${method}`), { rpcCode: -32601 })
  }
}

export function startMcpServer({ input = process.stdin, output = process.stdout } = {}) {
  const handle = createMcpHandler()
  const lines = createInterface({ input, crlfDelay: Infinity })
  const send = (message) => output.write(`${JSON.stringify(message)}\n`)
  lines.on('line', async (line) => {
    let request
    try {
      request = JSON.parse(line)
    } catch {
      send({ jsonrpc: '2.0', id: null, error: rpcError(-32700, 'Parse error') })
      return
    }
    if (request.id === undefined) return
    try {
      send({ jsonrpc: '2.0', id: request.id, result: await handle(request) })
    } catch (error) {
      send({
        jsonrpc: '2.0',
        id: request.id,
        error: rpcError(Number.isInteger(error?.rpcCode) ? error.rpcCode : -32603, error?.message || 'Internal error'),
      })
    }
  })
  return lines
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ''
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) startMcpServer()
