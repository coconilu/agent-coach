#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const defaultRepoRoot = resolve(scriptDir, '..', '..')

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1)
  return value >>> 0
})

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function uint16(value) {
  const buffer = Buffer.allocUnsafe(2)
  buffer.writeUInt16LE(value)
  return buffer
}

function uint32(value) {
  const buffer = Buffer.allocUnsafe(4)
  buffer.writeUInt32LE(value >>> 0)
  return buffer
}

async function collectFiles(root, prefix) {
  const entries = []
  const walk = async (directory) => {
    const children = await readdir(directory, { withFileTypes: true })
    children.sort((left, right) => left.name.localeCompare(right.name))
    for (const child of children) {
      const fullPath = resolve(directory, child.name)
      if (child.isDirectory()) await walk(fullPath)
      else if (child.isFile()) {
        const path = `${prefix}/${relative(root, fullPath).split(sep).join('/')}`
        entries.push({ path, data: await readFile(fullPath) })
      }
    }
  }
  await walk(root)
  return entries
}

function createStoredZip(entries) {
  const localChunks = []
  const centralChunks = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.path, 'utf8')
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data)
    const crc = crc32(data)
    const local = Buffer.concat([
      Buffer.from('504b0304', 'hex'),
      uint16(20),
      uint16(0x0800),
      uint16(0),
      uint16(0),
      uint16(0x0021),
      uint32(crc),
      uint32(data.length),
      uint32(data.length),
      uint16(name.length),
      uint16(0),
      name,
      data,
    ])
    localChunks.push(local)

    const central = Buffer.concat([
      Buffer.from('504b0102', 'hex'),
      uint16(0x0314),
      uint16(20),
      uint16(0x0800),
      uint16(0),
      uint16(0),
      uint16(0x0021),
      uint32(crc),
      uint32(data.length),
      uint32(data.length),
      uint16(name.length),
      uint16(0),
      uint16(0),
      uint16(0),
      uint16(0),
      uint32(0x81a40000),
      uint32(offset),
      name,
    ])
    centralChunks.push(central)
    offset += local.length
  }
  const central = Buffer.concat(centralChunks)
  const end = Buffer.concat([
    Buffer.from('504b0506', 'hex'),
    uint16(0),
    uint16(0),
    uint16(entries.length),
    uint16(entries.length),
    uint32(central.length),
    uint32(offset),
    uint16(0),
  ])
  return Buffer.concat([...localChunks, central, end])
}

function releaseManifest(source) {
  return {
    ...source,
    skills: './skills/',
    systemPromptPath: './SYSTEM.md',
    mcpServers: {
      agent_coach: {
        command: 'node',
        args: ['./scripts/mcp-entry.mjs'],
        cwd: './',
      },
    },
    hooks: source.hooks.map((hook) => ({
      ...hook,
      command: 'node ./scripts/hook-entry.mjs --host kimi',
    })),
  }
}

export async function buildKimiPlugin(options = {}) {
  const repoRoot = resolve(options.repoRoot ?? defaultRepoRoot)
  const outputPath = resolve(options.outputPath ?? resolve(repoRoot, 'integrations', 'dist', 'agent-coach-kimi.zip'))
  const pluginRoot = resolve(repoRoot, 'plugins', 'agent-coach')
  const sourceManifest = JSON.parse(await readFile(resolve(repoRoot, '.kimi-plugin', 'plugin.json'), 'utf8'))
  const manifest = Buffer.from(`${JSON.stringify(releaseManifest(sourceManifest), null, 2)}\n`)
  const entries = [
    { path: 'kimi.plugin.json', data: manifest },
    { path: 'SYSTEM.md', data: await readFile(resolve(pluginRoot, 'SYSTEM.md')) },
    ...await collectFiles(resolve(pluginRoot, 'skills'), 'skills'),
    ...await collectFiles(resolve(pluginRoot, 'scripts'), 'scripts'),
  ].sort((left, right) => left.path.localeCompare(right.path))
  const archive = createStoredZip(entries)
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, archive)
  return {
    outputPath,
    entries: entries.map((entry) => entry.path),
    sha256: createHash('sha256').update(archive).digest('hex'),
  }
}

function cliOption(argv, name) {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : undefined
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await buildKimiPlugin({ outputPath: cliOption(process.argv.slice(2), '--output') })
  process.stdout.write(`${JSON.stringify({
    status: 'built',
    output: basename(result.outputPath),
    entries: result.entries,
    sha256: result.sha256,
  })}\n`)
}
