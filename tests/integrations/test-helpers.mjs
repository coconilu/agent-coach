import { execFile, spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { promisify } from 'node:util'
import { resolve } from 'node:path'

export const execFileAsync = promisify(execFile)

export function spawnWithInput(command, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const timeout = setTimeout(() => {
      child.kill()
      reject(new Error(`Process timeout: ${command}`))
    }, options.timeout ?? 5000)
    child.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timeout)
      if (code !== 0) {
        reject(Object.assign(new Error(`Process exited ${code ?? signal}: ${command}`), { code, signal, stdout, stderr }))
        return
      }
      resolveRun({ stdout, stderr, code })
    })
    child.stdin.end(options.input ?? '')
  })
}

export async function createMockGateway(home, responder) {
  const token = 'synthetic-agent-coach-token-1234567890'
  const requests = []
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    const record = {
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      body: body ? JSON.parse(body) : null,
    }
    requests.push(record)
    if (record.authorization !== `Bearer ${token}`) {
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized.' } }))
      return
    }
    const result = await responder(record)
    response.writeHead(result.status ?? 200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(result.body ?? {}))
  })
  await new Promise((resolveReady) => server.listen(0, '127.0.0.1', resolveReady))
  const address = server.address()
  await mkdir(home, { recursive: true })
  await writeFile(resolve(home, 'gateway.token'), `${token}\n`)
  await writeFile(resolve(home, 'gateway.json'), `${JSON.stringify({
    protocol_version: 'agent-coach/gateway-v1',
    origin: `http://127.0.0.1:${address.port}`,
    instance_id: 'synthetic-instance',
    token_file: 'gateway.token',
  })}\n`)
  return {
    requests,
    close: () => new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose())),
  }
}
