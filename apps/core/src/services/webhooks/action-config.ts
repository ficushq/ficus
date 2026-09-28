import yaml from 'js-yaml'
import { readFile } from 'fs/promises'
import { resolve } from 'path'
import { expandTilde } from '@ficus/shared/node'
import { MONOREPO_ROOT } from '../../lib/paths'
import type { BatchConfig, BatchEventConfig, BatcherConfig } from './batcher'
import { createLogger } from '../../lib/infra/logger'

// Old user-owned actions.yaml files survive upgrades. Retire only the bundled
// notification commands; preserve independently configured automation.
const retiredNotifications = new Set([
  'issues-assigned',
  'issues-unassigned',
  'issue-comment',
  'linear-issue-assigned',
  'pull-request-review',
  'pull-request-review-comment',
  'pull-request-review-batched',
  'pull-request-review-requested',
  'pull-request-conflict',
  'pull-request-merge',
  'workflow-run',
  'notify-ws-agents',
  'notify-on-mention-or-assigned',
])
function activeCommands(commands: WebhookActionCommand[]): WebhookActionCommand[] {
  return commands.filter((command) => {
    const match = command.run.trim().match(/^(?:bash\s+)?(?:\.?\/?|\/[^\s]*\/)config\/webhooks\/scripts\/([\w-]+)\.sh$/)
    if (!match || !retiredNotifications.has(match[1]!)) return true
    createLogger('webhook-config').info(
      `Retired bundled notification command ${match[1]}; integration events now handle routing`
    )
    return false
  })
}

/**
 * Normalize a config-file `cwd` once, at validation time, so the three spawn
 * sites (processors/github.ts, processors/linear.ts, batcher.ts — each
 * `x.cwd || MONOREPO_ROOT`) need no knowledge of it.
 *
 * `~` is expanded first: a YAML file is not a shell, so nothing else would
 * ever expand it and the command would be spawned in a directory literally
 * named `~`. What remains is then resolved against MONOREPO_ROOT, which is the
 * root the `|| MONOREPO_ROOT` fallback already uses — a relative `cwd` in a
 * repo-root config file plainly means "relative to the repo", not "relative to
 * wherever the api process happened to be started".
 */
function normalizeCwd(cwd: string): string {
  return resolve(MONOREPO_ROOT, expandTilde(cwd))
}

export interface WebhookActionCommand {
  run: string
  timeout?: number
}

export interface WebhookActionRule {
  branches: string[]
  repos?: string[] // optional repo filter, e.g., ["tauagent/tau-management"]
  cwd?: string
  env?: Record<string, string>
  commands: WebhookActionCommand[]
}

export interface WebhookProviderConfig {
  batches?: Record<string, BatchConfig>
  // Event type rules (everything except batches)
}

// Helper type for accessing event rules (excludes batches)
export type WebhookActionConfig = Record<string, WebhookProviderConfig & Record<string, WebhookActionRule[]>>

/**
 * Get rules for a specific event type (type-safe accessor)
 */
export function getEventRules(
  config: WebhookActionConfig,
  provider: string,
  eventType: string
): WebhookActionRule[] | undefined {
  const providerConfig = config[provider]
  if (!providerConfig) return undefined
  const rules = providerConfig[eventType]
  if (!rules || !Array.isArray(rules)) return undefined
  return rules
}

export class WebhookActionConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WebhookActionConfigError'
  }
}

function validateCommand(cmd: unknown, ruleIndex: number, cmdIndex: number): WebhookActionCommand {
  if (!cmd || typeof cmd !== 'object') {
    throw new WebhookActionConfigError(`Rule ${ruleIndex}, command ${cmdIndex}: must be an object`)
  }

  const c = cmd as Record<string, unknown>

  if (!c.run || typeof c.run !== 'string') {
    throw new WebhookActionConfigError(`Rule ${ruleIndex}, command ${cmdIndex}: missing required field 'run'`)
  }

  const validated: WebhookActionCommand = { run: c.run }

  if (c.timeout !== undefined) {
    if (typeof c.timeout !== 'number' || c.timeout <= 0) {
      throw new WebhookActionConfigError(`Rule ${ruleIndex}, command ${cmdIndex}: 'timeout' must be a positive number`)
    }
    validated.timeout = c.timeout
  }

  return validated
}

function validateRule(rule: unknown, index: number): WebhookActionRule {
  if (!rule || typeof rule !== 'object') {
    throw new WebhookActionConfigError(`Rule ${index}: must be an object`)
  }

  const r = rule as Record<string, unknown>

  let branches: string[]
  if (r.branches !== undefined) {
    if (!Array.isArray(r.branches) || r.branches.length === 0) {
      throw new WebhookActionConfigError(`Rule ${index}: 'branches' must be a non-empty array if provided`)
    }
    for (let i = 0; i < r.branches.length; i++) {
      if (typeof r.branches[i] !== 'string') {
        throw new WebhookActionConfigError(`Rule ${index}: branches[${i}] must be a string`)
      }
    }
    branches = r.branches as string[]
  } else {
    branches = ['*']
  }

  if (!Array.isArray(r.commands) || r.commands.length === 0) {
    throw new WebhookActionConfigError(`Rule ${index}: missing required field 'commands' (non-empty array)`)
  }

  const commands = r.commands.map((cmd: unknown, cmdIndex: number) => validateCommand(cmd, index, cmdIndex))

  let repos: string[] | undefined
  if (r.repos !== undefined) {
    if (!Array.isArray(r.repos) || r.repos.length === 0) {
      throw new WebhookActionConfigError(`Rule ${index}: 'repos' must be a non-empty array if provided`)
    }
    for (let i = 0; i < r.repos.length; i++) {
      if (typeof r.repos[i] !== 'string') {
        throw new WebhookActionConfigError(`Rule ${index}: repos[${i}] must be a string`)
      }
    }
    repos = r.repos as string[]
  }

  const validated: WebhookActionRule = {
    branches,
    commands,
  }

  if (repos !== undefined) {
    validated.repos = repos
  }

  if (r.cwd !== undefined) {
    if (typeof r.cwd !== 'string') {
      throw new WebhookActionConfigError(`Rule ${index}: 'cwd' must be a string`)
    }
    validated.cwd = normalizeCwd(r.cwd)
  }

  if (r.env !== undefined) {
    if (typeof r.env !== 'object' || Array.isArray(r.env) || r.env === null) {
      throw new WebhookActionConfigError(`Rule ${index}: 'env' must be an object`)
    }
    validated.env = r.env as Record<string, string>
  }

  return validated
}

function validateBatchEventConfig(event: unknown, eventType: string, batchName: string): BatchEventConfig {
  if (!event || typeof event !== 'object') {
    throw new WebhookActionConfigError(`Batch '${batchName}', event '${eventType}': must be an object`)
  }

  const e = event as Record<string, unknown>

  if (!e.role || (e.role !== 'primary' && e.role !== 'collect')) {
    throw new WebhookActionConfigError(
      `Batch '${batchName}', event '${eventType}': 'role' must be 'primary' or 'collect'`
    )
  }

  if (!e.batch_key || typeof e.batch_key !== 'string') {
    throw new WebhookActionConfigError(`Batch '${batchName}', event '${eventType}': missing required field 'batch_key'`)
  }

  const validated: BatchEventConfig = {
    role: e.role as 'primary' | 'collect',
    batch_key: e.batch_key,
  }

  if (e.orphan_timeout !== undefined) {
    if (typeof e.orphan_timeout !== 'number' || e.orphan_timeout <= 0) {
      throw new WebhookActionConfigError(
        `Batch '${batchName}', event '${eventType}': 'orphan_timeout' must be a positive number`
      )
    }
    validated.orphan_timeout = e.orphan_timeout
  }

  return validated
}

function validateBatchConfig(batch: unknown, name: string): BatchConfig {
  if (!batch || typeof batch !== 'object') {
    throw new WebhookActionConfigError(`Batch '${name}': must be an object`)
  }

  const b = batch as Record<string, unknown>

  if (!b.timeout || typeof b.timeout !== 'number' || b.timeout <= 0) {
    throw new WebhookActionConfigError(`Batch '${name}': 'timeout' must be a positive number`)
  }

  if (!b.events || typeof b.events !== 'object' || Array.isArray(b.events)) {
    throw new WebhookActionConfigError(`Batch '${name}': 'events' must be an object`)
  }

  const events: Record<string, BatchEventConfig> = {}
  for (const [eventType, eventConfig] of Object.entries(b.events as Record<string, unknown>)) {
    events[eventType] = validateBatchEventConfig(eventConfig, eventType, name)
  }

  const validated: BatchConfig = {
    timeout: b.timeout,
    events,
  }

  if (b.env !== undefined) {
    if (typeof b.env !== 'object' || Array.isArray(b.env) || b.env === null) {
      throw new WebhookActionConfigError(`Batch '${name}': 'env' must be an object`)
    }
    validated.env = b.env as Record<string, string>
  }

  if (b.commands !== undefined) {
    if (!Array.isArray(b.commands)) {
      throw new WebhookActionConfigError(`Batch '${name}': 'commands' must be an array`)
    }
    validated.commands = b.commands.map((cmd: unknown, i: number) => validateCommand(cmd, 0, i))
  }

  if (b.cwd !== undefined) {
    if (typeof b.cwd !== 'string') {
      throw new WebhookActionConfigError(`Batch '${name}': 'cwd' must be a string`)
    }
    validated.cwd = normalizeCwd(b.cwd)
  }

  return validated
}

export async function loadWebhookActionConfig(configPath: string): Promise<WebhookActionConfig> {
  const content = await readFile(configPath, 'utf-8')
  const parsed = yaml.load(content)

  if (!parsed || typeof parsed !== 'object') {
    throw new WebhookActionConfigError('Invalid YAML - expected an object')
  }

  const config: WebhookActionConfig = {}

  for (const [provider, events] of Object.entries(parsed as Record<string, unknown>)) {
    if (!events || typeof events !== 'object') {
      throw new WebhookActionConfigError(`Provider '${provider}': expected an object of event types`)
    }

    config[provider] = {}

    for (const [eventType, rules] of Object.entries(events as Record<string, unknown>)) {
      // Handle batches section specially
      if (eventType === 'batches') {
        if (!rules || typeof rules !== 'object' || Array.isArray(rules)) {
          throw new WebhookActionConfigError(`Provider '${provider}': 'batches' must be an object`)
        }
        config[provider].batches = {}
        for (const [batchName, batchConfig] of Object.entries(rules as Record<string, unknown>)) {
          const batch = validateBatchConfig(batchConfig, batchName)
          if (batch.commands?.length) {
            batch.commands = activeCommands(batch.commands)
            if (!batch.commands.length) continue
          }
          config[provider].batches![batchName] = batch
        }
        continue
      }

      if (!Array.isArray(rules)) {
        throw new WebhookActionConfigError(`Provider '${provider}', event '${eventType}': expected an array of rules`)
      }

      config[provider][eventType] = rules
        .map((rule, index) => {
          const validated = validateRule(rule, index)
          return { ...validated, commands: activeCommands(validated.commands) }
        })
        .filter((rule) => rule.commands.length)
    }
  }

  return config
}

/**
 * Extract batch configs from a provider's config for use with WebhookBatcher
 */
export function getBatcherConfig(config: WebhookActionConfig | null, provider: string): BatcherConfig {
  if (!config) return {}
  const providerConfig = config[provider]
  if (!providerConfig?.batches) {
    return {}
  }
  return { batches: providerConfig.batches }
}

export function matchesBranch(ref: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (pattern === '*') {
      return true
    }
    if (pattern.includes('*')) {
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$')
      if (regex.test(ref)) {
        return true
      }
    } else if (ref === pattern) {
      return true
    }
  }
  return false
}

export function matchesRepo(repoFullName: string, patterns: string[]): boolean {
  // Empty or undefined patterns = match all repos
  if (!patterns || patterns.length === 0) {
    return true
  }

  for (const pattern of patterns) {
    if (pattern === '*') {
      return true
    }
    if (pattern.includes('*')) {
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$')
      if (regex.test(repoFullName)) {
        return true
      }
    } else if (repoFullName === pattern) {
      return true
    }
  }
  return false
}

export function getMatchingRule(
  config: WebhookActionConfig,
  provider: string,
  eventType: string,
  ref: string,
  repo?: string
): WebhookActionRule | null {
  const providerConfig = config[provider]
  if (!providerConfig) return null

  const rules = providerConfig[eventType]
  if (!rules) return null

  for (const rule of rules) {
    if (matchesBranch(ref, rule.branches)) {
      // If repo is provided and rule has repos filter, check it
      if (repo !== undefined && rule.repos !== undefined) {
        if (!matchesRepo(repo, rule.repos)) {
          continue
        }
      }
      return rule
    }
  }

  return null
}

// Matches {{ payload.path }} or {{ payload.path | filter | filter }}
const TEMPLATE_PATTERN = /\{\{\s*payload\.([^\s|}]+)(\s*\|[^}]+)?\s*\}\}/

/**
 * Apply a chain of filters to a value.
 * Supported filters:
 *   - tojson: JSON.stringify the value
 *   - map(.field): extract field from each array element
 *   - join(sep): join array with separator (default ",")
 */
function applyFilters(value: unknown, filterChain: string): unknown {
  if (!filterChain) return value

  // Split on | but not inside quotes or parentheses
  const filters: string[] = []
  let buf = ''
  let inQuotes = false
  let quoteChar = ''
  let parenDepth = 0

  for (const char of filterChain) {
    if ((char === '"' || char === "'") && parenDepth > 0) {
      if (!inQuotes) {
        inQuotes = true
        quoteChar = char
      } else if (char === quoteChar) {
        inQuotes = false
      }
      buf += char
    } else if (char === '(' && !inQuotes) {
      parenDepth++
      buf += char
    } else if (char === ')' && !inQuotes) {
      parenDepth--
      buf += char
    } else if (char === '|' && !inQuotes && parenDepth === 0) {
      if (buf.trim()) filters.push(buf.trim())
      buf = ''
    } else {
      buf += char
    }
  }
  if (buf.trim()) filters.push(buf.trim())

  let current = value
  for (const filter of filters) {
    if (filter === 'truthy') {
      current = current ? 'true' : 'false'
    } else if (filter === 'tojson') {
      current = JSON.stringify(current)
    } else if (filter.startsWith('map(') && filter.endsWith(')')) {
      // map(.fieldName) - extract field from each array element
      const fieldMatch = filter.match(/map\(\.(\w+)\)/)
      if (fieldMatch && Array.isArray(current)) {
        const field = fieldMatch[1]
        current = current.map((item) =>
          item && typeof item === 'object' ? (item as Record<string, unknown>)[field] : undefined
        )
      }
    } else if (filter.startsWith('join(') && filter.endsWith(')')) {
      // join(",") or join(", ")
      const sepMatch = filter.match(/join\(["']?([^"')]+)["']?\)/)
      const sep = sepMatch ? sepMatch[1] : ','
      if (Array.isArray(current)) {
        current = current.join(sep)
      }
    } else if (filter === 'join') {
      // join without args defaults to comma
      if (Array.isArray(current)) {
        current = current.join(',')
      }
    }
  }

  return current
}

export function resolveEnvTemplates(
  env: Record<string, string>,
  payload: Record<string, unknown>
): Record<string, string> {
  const resolved: Record<string, string> = {}

  for (const [key, value] of Object.entries(env)) {
    const match = TEMPLATE_PATTERN.exec(value)
    if (match) {
      const path = match[1]
      const filterChain = match[2] || ''

      // Resolve the path
      const keys = path.split('.')
      let current: unknown = payload
      for (const k of keys) {
        if (current == null || typeof current !== 'object') {
          current = undefined
          break
        }
        current = (current as Record<string, unknown>)[k]
      }

      // Apply filters (some filters like truthy handle null/undefined)
      if (filterChain) {
        current = applyFilters(current, filterChain)
      }

      resolved[key] = current != null && current !== undefined ? String(current) : ''
    } else {
      resolved[key] = value
    }
  }

  return resolved
}
