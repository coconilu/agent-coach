import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'

import { buildDshBundle } from '../../integrations/scripts/build-dsh-bundle.mjs'
import { buildKimiPlugin } from '../../integrations/scripts/build-kimi-plugin.mjs'

const repoRoot = resolve(import.meta.dirname, '..', '..')
const readJson = async (...parts) => JSON.parse(await readFile(resolve(repoRoot, ...parts), 'utf8'))

test('Codex repo marketplace and plugin use public identities', async () => {
  const marketplace = await readJson('.agents', 'plugins', 'marketplace.json')
  const plugin = await readJson('plugins', 'agent-coach', '.codex-plugin', 'plugin.json')
  assert.equal(marketplace.name, 'agent-coach')
  assert.equal(marketplace.plugins[0].source.path, './plugins/agent-coach')
  assert.equal(plugin.name, 'agent-coach')
  assert.equal(plugin.author.name, 'coconilu')
  assert.equal(plugin.interface.developerName, 'coconilu')
  assert.equal(plugin.mcpServers, './.mcp.json')
})

test('Codex and Kimi declare all five lifecycle events', async () => {
  const codex = await readJson('plugins', 'agent-coach', 'hooks', 'hooks.json')
  const kimi = await readJson('.kimi-plugin', 'plugin.json')
  const expected = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionEnd']
  assert.deepEqual(Object.keys(codex.hooks), expected)
  assert.deepEqual(kimi.hooks.map((hook) => hook.event), expected)
  assert.equal(kimi.sessionStart.skill, 'agent-coach')
})

test('DSH bundle pins rc.7 and carries a self-contained fast MCP runtime', async () => {
  const manifest = await readJson('integrations', 'dsh', 'package.json')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.dependencies['@deepseek-ai/dsh-mcp-client'], '0.1.0-rc.7')
  assert.equal(manifest.dependencies['@deepseek-ai/dsh-llm'], '0.1.0-rc.7')
  const built = await buildDshBundle()
  assert.deepEqual(built.files.sort(), ['action-classifier.mjs', 'gateway-client.mjs', 'mcp-entry.mjs'].sort())
  for (const file of built.files) {
    assert.deepEqual(
      await readFile(resolve(repoRoot, 'integrations', 'dsh', 'runtime', file)),
      await readFile(resolve(repoRoot, 'plugins', 'agent-coach', 'scripts', file)),
    )
  }
})

test('Kimi release ZIP is deterministic in structure and places its manifest at root', async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), 'agent-coach-kimi-zip-'))
  const outputPath = resolve(temporary, 'agent-coach-kimi.zip')
  const first = await buildKimiPlugin({ repoRoot, outputPath })
  const firstBytes = await readFile(outputPath)
  const second = await buildKimiPlugin({ repoRoot, outputPath })
  assert.equal(first.sha256, second.sha256)
  assert.equal(firstBytes.subarray(0, 4).toString('hex'), '504b0304')
  assert.ok(first.entries.includes('kimi.plugin.json'))
  assert.ok(first.entries.includes('scripts/mcp-entry.mjs'))
  assert.ok(first.entries.includes('scripts/hook-entry.mjs'))
  assert.ok(first.entries.includes('skills/agent-coach/SKILL.md'))
})
