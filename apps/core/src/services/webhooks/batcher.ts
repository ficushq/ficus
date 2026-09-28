/**
 * Webhook Event Batcher
 *
 * Batches related webhook events together based on declarative YAML config.
 * Supports primary + collected event patterns with configurable timeouts.
 */

import { withLegacyEnvAliases } from '@ficus/shared/legacy-env'
import { exec } from 'child_process'
import { promisify } from 'util'
import { MONOREPO_ROOT } from '../../lib/paths'
import { createLogger } from '../../lib/infra/logger'
import { githubWebhookEnvironment } from '../integrations/github/webhook-environment'
import { webhookScriptAuthEnv } from '../auth/system-tokens'

const execAsync = promisify(exec)
const log = createLogger('batcher')

// --- Types ---

export interface BatchEventConfig {
  role: 'primary' | 'collect'
  batch_key: string // Template string like '{{ payload.review.id }}'
  orphan_timeout?: number // ms to wait for primary if this arrives first
}

export interface BatchConfig {
  timeout: number // ms to wait after primary before flushing
  events: Record<string, BatchEventConfig>
  env?: Record<string, string>
  commands?: { run: string; timeout?: number }[]
  cwd?: string
}

export interface BatcherConfig {
  batches?: Record<string, BatchConfig>
}

export interface PendingBatch {
  key: string
  configName: string
  provider: string
  primary: Record<string, unknown> | null
  collected: Array<Record<string, unknown>>
  timer: ReturnType<typeof setTimeout> | null
  createdAt: number
  isOrphan: boolean // True if created by collect event before primary
}

export interface BatchContext {
  key: string
  primary: Record<string, unknown> | null
  collected: Array<Record<string, unknown>>
}

// --- Template Resolution ---

/**
 * Resolve a simple template string against a context object.
 * Supports: {{ path.to.value }}, {{ value | tojson }}, {{ value | length }}
 */
export function resolveTemplate(template: string, context: Record<string, unknown>): string {
  return template.replace(/\{\{\s*(.+?)\s*\}\}/g, (_, expr: string) => {
    // Check for filters (pipe syntax)
    const [pathPart, ...filters] = expr.split('|').map((s) => s.trim())

    // Resolve the path
    let value: unknown = context
    for (const part of pathPart.split('.')) {
      if (value === null || value === undefined) break
      value = (value as Record<string, unknown>)[part]
    }

    // Apply filters
    for (const filter of filters) {
      if (filter === 'tojson') {
        value = JSON.stringify(value ?? null)
      } else if (filter === 'length') {
        value = Array.isArray(value) ? value.length : 0
      }
    }

    // Convert to string
    if (value === null || value === undefined) return ''
    if (typeof value === 'object') return JSON.stringify(value)
    return String(value)
  })
}

/**
 * Resolve all template strings in an env object
 */
export function resolveEnvTemplates(
  env: Record<string, string>,
  context: Record<string, unknown>
): Record<string, string> {
  const resolved: Record<string, string> = {}
  for (const [key, template] of Object.entries(env)) {
    resolved[key] = resolveTemplate(template, context)
  }
  return resolved
}

// --- Batcher Class ---

export class WebhookBatcher {
  private configs: Record<string, Record<string, BatchConfig>> = {} // provider -> batches
  private batches = new Map<string, PendingBatch>()
  private onFlush?: (batch: PendingBatch, config: BatchConfig) => Promise<void>

  /**
   * Load batch configurations for a provider
   */
  loadConfig(provider: string, config: BatcherConfig): void {
    if (config.batches) {
      this.configs[provider] = config.batches
    }
  }

  /**
   * Set custom flush handler (for testing or custom execution)
   */
  setFlushHandler(handler: (batch: PendingBatch, config: BatchConfig) => Promise<void>): void {
    this.onFlush = handler
  }

  /**
   * Find matching batch config for an event
   */
  findMatchingBatch(
    provider: string,
    eventType: string
  ): { name: string; config: BatchConfig; eventConfig: BatchEventConfig; hasPrimaryRole: boolean } | null {
    const providerConfigs = this.configs[provider]
    if (!providerConfigs) return null

    for (const [name, config] of Object.entries(providerConfigs)) {
      const eventConfig = config.events[eventType]
      if (eventConfig) {
        // Check if this batch has any primary role defined
        const hasPrimaryRole = Object.values(config.events).some((e) => e.role === 'primary')
        return { name, config, eventConfig, hasPrimaryRole }
      }
    }
    return null
  }

  /**
   * Handle an incoming webhook event.
   * Returns true if event was batched, false if should process normally.
   */
  handleEvent(provider: string, eventType: string, payload: Record<string, unknown>): boolean {
    const match = this.findMatchingBatch(provider, eventType)
    if (!match) return false

    const { name, config, eventConfig, hasPrimaryRole } = match

    // Resolve the batch key from template
    const key = resolveTemplate(eventConfig.batch_key, { payload })
    if (!key) {
      log.warn(`Empty batch key for ${provider}:${eventType}, skipping batch`)
      return false
    }

    const batchId = `${provider}:${name}:${key}`

    if (eventConfig.role === 'primary') {
      this.handlePrimaryEvent(batchId, provider, name, key, config, payload)
    } else {
      // For collect-only batches (no primary role), treat first event as the trigger
      this.handleCollectEvent(batchId, provider, name, key, config, eventConfig, payload, !hasPrimaryRole)
    }

    return true
  }

  private handlePrimaryEvent(
    batchId: string,
    provider: string,
    configName: string,
    key: string,
    config: BatchConfig,
    payload: Record<string, unknown>
  ): void {
    const existing = this.batches.get(batchId)

    if (existing) {
      // Claim orphan batch
      if (existing.timer) clearTimeout(existing.timer)
      existing.primary = payload
      existing.isOrphan = false
      existing.timer = setTimeout(() => this.flush(batchId), config.timeout)
      log.info(`Primary claimed orphan batch ${batchId} with ${existing.collected.length} events`)
    } else {
      // Create new batch
      const batch: PendingBatch = {
        key,
        configName,
        provider,
        primary: payload,
        collected: [],
        timer: setTimeout(() => this.flush(batchId), config.timeout),
        createdAt: Date.now(),
        isOrphan: false,
      }
      this.batches.set(batchId, batch)
      log.info(`Created batch ${batchId}, timeout ${config.timeout}ms`)
    }
  }

  private handleCollectEvent(
    batchId: string,
    provider: string,
    configName: string,
    key: string,
    config: BatchConfig,
    eventConfig: BatchEventConfig,
    payload: Record<string, unknown>,
    collectOnly: boolean = false
  ): void {
    const existing = this.batches.get(batchId)

    if (existing) {
      // Add to existing batch, reset timer
      existing.collected.push(payload)
      if (existing.timer) clearTimeout(existing.timer)

      // For collect-only or claimed batches, use main timeout; for orphans waiting for primary, use orphan timeout
      const timeout =
        collectOnly || !existing.isOrphan ? config.timeout : (eventConfig.orphan_timeout ?? config.timeout)

      existing.timer = setTimeout(() => this.flush(batchId), timeout)
      log.info(`Added to batch ${batchId}, now ${existing.collected.length} collected`)
    } else {
      // Create new batch
      // For collect-only batches, use main timeout and don't mark as orphan
      // For batches with a primary role, use orphan timeout and mark as orphan
      const isOrphan = !collectOnly
      const timeout = collectOnly ? config.timeout : (eventConfig.orphan_timeout ?? config.timeout)
      const batch: PendingBatch = {
        key,
        configName,
        provider,
        primary: null,
        collected: [payload],
        timer: setTimeout(() => this.flush(batchId), timeout),
        createdAt: Date.now(),
        isOrphan,
      }
      this.batches.set(batchId, batch)
      const batchType = collectOnly ? 'collect-only' : 'orphan'
      log.info(`Created ${batchType} batch ${batchId}, timeout ${timeout}ms`)
    }
  }

  /**
   * Flush a batch - resolve templates and execute commands
   */
  private async flush(batchId: string): Promise<void> {
    const batch = this.batches.get(batchId)
    if (!batch) return

    this.batches.delete(batchId)
    if (batch.timer) clearTimeout(batch.timer)

    const config = this.configs[batch.provider]?.[batch.configName]
    if (!config) {
      log.error(`No config found for ${batch.provider}:${batch.configName}`)
      return
    }

    log.info(`Flushing batch ${batchId}: primary=${!!batch.primary}, collected=${batch.collected.length}`)

    if (this.onFlush) {
      await this.onFlush(batch, config)
      return
    }

    // Default execution: resolve env and run commands
    await this.executeCommands(batch, config)
  }

  private async executeCommands(batch: PendingBatch, config: BatchConfig): Promise<void> {
    if (!config.commands || config.commands.length === 0) return

    const context: Record<string, unknown> = {
      batch: {
        key: batch.key,
        primary: batch.primary,
        collected: batch.collected,
      },
    }

    const cwd = config.cwd || MONOREPO_ROOT
    const secretEnv = { ...(await githubWebhookEnvironment()), ...(await webhookScriptAuthEnv()) }
    const resolvedEnv = config.env ? { ...secretEnv, ...resolveEnvTemplates(config.env, context) } : { ...secretEnv }

    for (const command of config.commands) {
      log.info(`Running: ${command.run}`)
      try {
        const opts: { cwd: string; timeout?: number; env: Record<string, string> } = {
          cwd,
          // One release (Ficus rename): webhook scripts may still read the TAU_* names.
          env: withLegacyEnvAliases(resolvedEnv),
        }
        if (command.timeout) opts.timeout = command.timeout

        const result = await execAsync(command.run, opts)
        if (result.stdout) log.info(`stdout:`, result.stdout.trim().slice(0, 500))
        if (result.stderr) log.info(`stderr:`, result.stderr.trim().slice(0, 500))
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        log.error(`Command failed: ${msg}`)
      }
    }
  }

  /**
   * Force flush all pending batches (for shutdown)
   */
  async flushAll(): Promise<void> {
    const batchIds = Array.from(this.batches.keys())
    for (const batchId of batchIds) {
      await this.flush(batchId)
    }
  }

  /**
   * Get count of pending batches (for testing)
   */
  getPendingCount(): number {
    return this.batches.size
  }

  /**
   * Get a pending batch by ID (for testing)
   */
  getPendingBatch(batchId: string): PendingBatch | undefined {
    return this.batches.get(batchId)
  }

  /**
   * Clear all batches and configs (for testing)
   */
  clear(): void {
    for (const batch of this.batches.values()) {
      if (batch.timer) clearTimeout(batch.timer)
    }
    this.batches.clear()
    this.configs = {}
  }
}

// Singleton instance
export const webhookBatcher = new WebhookBatcher()
