import assert from 'node:assert/strict'
import test from 'node:test'

import { CLASSIFIER_VERSION, classifyAction } from '../../plugins/agent-coach/scripts/action-classifier.mjs'

test('classifier allows only conservative read-only shell commands', () => {
  assert.deepEqual(classifyAction('Bash', { command: 'rg --files' }), {
    class: 'read',
    classifier_version: CLASSIFIER_VERSION,
    reason: 'Conservative read-only shell allowlist matched rg.',
    coverage: 'covered',
  })
  assert.equal(classifyAction('Bash', { command: 'rg token | Set-Content out.txt' }).class, 'unknown')
  assert.equal(classifyAction('Bash', { command: 'git status --short' }).class, 'read')
  assert.equal(classifyAction('Bash', { command: 'git push origin main' }).class, 'unknown')
})

test('classifier distinguishes control, write, and unknown tools', () => {
  assert.equal(classifyAction('mcp__agent_coach__coach_prepare', {}).class, 'read')
  assert.equal(classifyAction('apply_patch', {}).class, 'write')
  assert.equal(classifyAction('mcp__foreign__future_tool', {}).class, 'unknown')
})
