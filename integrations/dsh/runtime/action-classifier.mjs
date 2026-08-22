export const CLASSIFIER_VERSION = 'host-actions-v1'

const COACH_CONTROL = /(?:^|__)coach_(?:prepare|commit_plan|search|explain|complete|feedback)$/i

const READ_TOOLS = new Set([
  'read',
  'read_file',
  'read_image',
  'view_image',
  'grep',
  'glob',
  'find',
  'list',
  'list_files',
  'search',
  'web_search',
  'web_fetch',
  'get',
  'get_goal',
  'status',
  'inspect',
  'update_plan',
  'request_user_input',
  'list_agents',
  'wait_agent',
  'read_mcp_resource',
  'list_mcp_resources',
  'list_mcp_resource_templates',
])

const WRITE_TOOLS = new Set([
  'apply_patch',
  'edit',
  'write',
  'write_file',
  'delete',
  'remove',
  'move',
  'rename',
  'create_file',
  'create_thread',
  'send_message',
  'send_message_to_thread',
])

const SAFE_COMMANDS = new Set([
  'dir',
  'ls',
  'pwd',
  'type',
  'where',
  'rg',
  'grep',
  'findstr',
  'get-content',
  'get-childitem',
  'get-item',
  'get-command',
  'get-location',
  'select-string',
  'test-path',
  'resolve-path',
])

const SAFE_GIT_SUBCOMMANDS = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'ls-tree'])
const VERSION_COMMANDS = new Set(['node', 'npm', 'pnpm', 'yarn', 'python', 'python3', 'py', 'git'])
const SHELL_META = /(?:\r|\n|[|;&<>`]|\$\(|>\(|<\()/

function result(actionClass, reason, coverage = 'covered') {
  return Object.freeze({
    class: actionClass,
    classifier_version: CLASSIFIER_VERSION,
    reason,
    coverage,
  })
}

function shellCommand(toolInput) {
  if (typeof toolInput === 'string') return toolInput
  if (!toolInput || typeof toolInput !== 'object') return ''
  return typeof toolInput.command === 'string'
    ? toolInput.command
    : typeof toolInput.cmd === 'string'
      ? toolInput.cmd
      : ''
}

export function classifyShell(command) {
  const trimmed = String(command ?? '').trim()
  if (!trimmed || SHELL_META.test(trimmed)) {
    return result('unknown', 'Shell input is empty, compound, redirected, or otherwise not provably read-only.')
  }
  const tokens = trimmed.split(/\s+/)
  const executable = tokens[0].replace(/^['"]|['"]$/g, '').toLowerCase()
  if (SAFE_COMMANDS.has(executable)) return result('read', `Conservative read-only shell allowlist matched ${executable}.`)
  if (executable === 'git') {
    const subcommand = tokens[1]?.toLowerCase()
    return SAFE_GIT_SUBCOMMANDS.has(subcommand)
      ? result('read', `Conservative read-only git allowlist matched git ${subcommand}.`)
      : result('unknown', 'Git subcommand is not on the conservative read-only allowlist.')
  }
  if (VERSION_COMMANDS.has(executable) && tokens.length === 2 && ['--version', '-v', '-version'].includes(tokens[1].toLowerCase())) {
    return result('read', `Version probe for ${executable} is read-only.`)
  }
  return result('unknown', 'Shell command is not on the conservative read-only allowlist.')
}

export function classifyAction(toolName, toolInput) {
  const name = typeof toolName === 'string' ? toolName.trim() : ''
  const lower = name.toLowerCase()
  if (!name) return result('unknown', 'Tool name is absent.')
  if (COACH_CONTROL.test(name)) return result('read', 'Agent Coach control-plane handshake tools are allowed before the execution epoch.')
  if (lower === 'bash' || lower === 'exec_command' || lower === 'shell') return classifyShell(shellCommand(toolInput))
  if (READ_TOOLS.has(lower)) return result('read', `Known read-only or host-control tool: ${name}.`)
  if (WRITE_TOOLS.has(lower)) return result('write', `Known side-effecting tool: ${name}.`)
  return result('unknown', `No proven read-only classification exists for ${name}.`)
}

export function unsupportedAction(reason) {
  return result('unknown', reason, 'unsupported')
}
