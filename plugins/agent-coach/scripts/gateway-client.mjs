import { createHmac } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, relative, resolve, win32 } from 'node:path'

export const AGENT_COACH_SERVICE_ID = 'agent-coach'
export const DEFAULT_GATEWAY_TIMEOUT_MS = 800

const MAX_TOKEN_BYTES = 4096
const MAX_RESPONSE_BYTES = 1024 * 1024

export class GatewayUnavailableError extends Error {
  constructor(code = 'GATEWAY_UNAVAILABLE') {
    super('Agent Coach gateway is unavailable.')
    this.name = 'GatewayUnavailableError'
    this.code = code
  }
}

export class GatewayResponseError extends Error {
  constructor(status, code, message) {
    super(message || `Agent Coach gateway returned HTTP ${status}.`)
    this.name = 'GatewayResponseError'
    this.status = status
    this.code = code || 'GATEWAY_ERROR'
  }
}

const COACHING_DENIAL_CODES = new Set([
  'ACTION_REQUIRES_COACHING',
  'TICKET_INVALID',
  'TICKET_REDEEMED',
  'EPOCH_STALE',
  'PACKET_STALE',
  'INVALID_STATE',
])

export function defaultAgentCoachHome(env = process.env, platform = process.platform) {
  if (env.AGENT_COACH_HOME) return resolve(env.AGENT_COACH_HOME)
  if (platform === 'win32') {
    const localData = env.LOCALAPPDATA || win32.join(homedir(), 'AppData', 'Local')
    return win32.join(localData, 'AgentCoach')
  }
  if (platform === 'darwin') return resolve(homedir(), 'Library', 'Application Support', 'AgentCoach')
  return resolve(env.XDG_STATE_HOME || resolve(homedir(), '.local', 'state'), 'agent-coach')
}

export function validateLoopbackOrigin(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new GatewayUnavailableError('GATEWAY_DISCOVERY_INVALID')
  }
  if (
    url.protocol !== 'http:'
    || url.hostname !== '127.0.0.1'
    || url.port.length === 0
    || url.username.length > 0
    || url.password.length > 0
    || url.pathname !== '/'
    || url.search.length > 0
    || url.hash.length > 0
  ) {
    throw new GatewayUnavailableError('GATEWAY_DISCOVERY_INVALID')
  }
  return url.origin
}

function containedPath(parent, candidate) {
  const rel = relative(parent, candidate)
  return rel.length > 0 && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rel)
}

function parseManifest(value) {
  if (!value || typeof value !== 'object') throw new GatewayUnavailableError('GATEWAY_DISCOVERY_INVALID')
  const service = value.service ?? value.service_id
  const schemaVersion = value.schema_version ?? value.schemaVersion
  const current = value.protocol_version === 'agent-coach/gateway-v1'
  const legacy = service === AGENT_COACH_SERVICE_ID && schemaVersion === 1
  if (!current && !legacy) {
    throw new GatewayUnavailableError('GATEWAY_DISCOVERY_INVALID')
  }
  return value
}

export async function resolveGatewayConnection(options = {}) {
  const env = options.env ?? process.env
  const home = resolve(options.home ?? defaultAgentCoachHome(env, options.platform))

  if (env.AGENT_COACH_GATEWAY_ORIGIN && env.AGENT_COACH_GATEWAY_TOKEN) {
    return {
      origin: validateLoopbackOrigin(env.AGENT_COACH_GATEWAY_ORIGIN),
      token: validateToken(env.AGENT_COACH_GATEWAY_TOKEN),
      instanceId: 'environment',
    }
  }

  let manifest
  try {
    manifest = parseManifest(JSON.parse(await readFile(resolve(home, 'gateway.json'), 'utf8')))
  } catch (error) {
    if (error instanceof GatewayUnavailableError) throw error
    throw new GatewayUnavailableError('GATEWAY_DISCOVERY_MISSING')
  }

  const tokenReference = manifest.token_file ?? manifest.tokenFile ?? manifest.secret_file ?? 'gateway.token'
  if (typeof tokenReference !== 'string' || tokenReference.length === 0 || isAbsolute(tokenReference)) {
    throw new GatewayUnavailableError('GATEWAY_DISCOVERY_INVALID')
  }
  const tokenPath = resolve(home, tokenReference)
  if (!containedPath(home, tokenPath)) throw new GatewayUnavailableError('GATEWAY_DISCOVERY_INVALID')

  let token
  try {
    token = validateToken((await readFile(tokenPath, 'utf8')).trim())
  } catch (error) {
    if (error instanceof GatewayUnavailableError) throw error
    throw new GatewayUnavailableError('GATEWAY_CREDENTIAL_MISSING')
  }

  return {
    origin: validateLoopbackOrigin(manifest.origin),
    token,
    instanceId: String(manifest.instance_id ?? manifest.instanceId ?? ''),
  }
}

function validateToken(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') < 24 || Buffer.byteLength(value, 'utf8') > MAX_TOKEN_BYTES) {
    throw new GatewayUnavailableError('GATEWAY_CREDENTIAL_INVALID')
  }
  return value
}

export async function requestGateway(pathname, init = {}, options = {}) {
  const connection = options.connection ?? await resolveGatewayConnection(options)
  if (typeof pathname !== 'string' || !pathname.startsWith('/v1/')) {
    throw new TypeError('Agent Coach internal paths must start with /v1/.')
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_GATEWAY_TIMEOUT_MS
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const signal = init.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal
  const headers = new Headers(init.headers)
  headers.set('authorization', `Bearer ${connection.token}`)
  headers.set('accept', 'application/json')
  headers.set('x-agent-coach-client', options.clientName ?? 'host-integration')
  let body = init.body
  if (body !== undefined && typeof body !== 'string') {
    headers.set('content-type', 'application/json')
    body = JSON.stringify(body)
  }

  let response
  try {
    response = await fetch(new URL(pathname, connection.origin), {
      ...init,
      body,
      headers,
      signal,
    })
  } catch {
    throw new GatewayUnavailableError()
  }

  let text
  try {
    text = await response.text()
  } catch {
    throw new GatewayUnavailableError('GATEWAY_RESPONSE_INVALID')
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
    throw new GatewayUnavailableError('GATEWAY_RESPONSE_TOO_LARGE')
  }
  let data = {}
  if (text.length > 0) {
    try {
      data = JSON.parse(text)
    } catch {
      throw new GatewayUnavailableError('GATEWAY_RESPONSE_INVALID')
    }
  }
  if (!response.ok) {
    throw new GatewayResponseError(
      response.status,
      typeof data?.error?.code === 'string' ? data.error.code : undefined,
      typeof data?.error?.message === 'string' ? data.error.message : undefined,
    )
  }
  return data
}

export function pseudonymize(secret, namespace, value) {
  const input = value === undefined || value === null ? '' : String(value)
  return createHmac('sha256', secret).update(`${namespace}\0${input}`, 'utf8').digest('hex').slice(0, 32)
}

export function digestJson(secret, namespace, value) {
  return pseudonymize(secret, namespace, stableStringify(value))
}

export function stableStringify(value) {
  const seen = new WeakSet()
  const normalize = (candidate) => {
    if (candidate === null || typeof candidate !== 'object') return candidate
    if (seen.has(candidate)) return '[circular]'
    seen.add(candidate)
    if (Array.isArray(candidate)) return candidate.map(normalize)
    const result = {}
    for (const key of Object.keys(candidate).sort()) result[key] = normalize(candidate[key])
    return result
  }
  try {
    return JSON.stringify(normalize(value))
  } catch {
    return '"[unserializable]"'
  }
}

export function safeGatewayFailure(error) {
  return {
    code: typeof error?.code === 'string' ? error.code : 'GATEWAY_UNAVAILABLE',
    message: error instanceof GatewayResponseError
      ? error.message
      : typeof error?.message === 'string' && typeof error?.code === 'string'
        ? error.message
        : 'Agent Coach gateway is unavailable; the host continues in degraded mode.',
  }
}

export function isCoachingDenial(error) {
  return error instanceof GatewayResponseError && COACHING_DENIAL_CODES.has(error.code)
}
