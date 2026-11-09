import * as yaml from 'js-yaml'
import { eq } from 'drizzle-orm'
import { ConfigSync } from './ConfigSync'
import { db } from '../../db'
import { notificationConfig } from '../../db/schema'
import { NOTIFICATIONS_DIR } from '../../lib/paths'
import type { NotificationRule } from '../notifications/types'
import { notificationService } from '../notifications/service'

interface NotificationYaml {
  id: string
  rules: NotificationRule[]
  channels: Record<string, { enabled: boolean }>
}

export class NotificationSync extends ConfigSync<NotificationYaml> {
  readonly name = 'notification-config'
  readonly directory = NOTIFICATIONS_DIR
  readonly table = notificationConfig
  readonly idColumn = notificationConfig.id
  readonly yamlTemplateColumn = notificationConfig.yamlTemplate
  readonly yamlFieldOverridesColumn = notificationConfig.yamlFieldOverrides
  readonly updatedAtColumn = notificationConfig.updatedAt
  readonly disabledColumn = notificationConfig.disabled

  parse(content: string, filename: string): NotificationYaml {
    const parsed = yaml.load(content) as Record<string, unknown>

    if (!parsed || typeof parsed !== 'object') {
      throw new Error(`${filename}: Invalid YAML - expected an object`)
    }

    if (!parsed.rules || !Array.isArray(parsed.rules)) {
      throw new Error(`${filename}: Missing required field 'rules' array`)
    }

    const rules = parsed.rules.map((rule: unknown, index: number) => {
      if (!rule || typeof rule !== 'object') {
        throw new Error(`${filename}: Rule ${index}: must be an object`)
      }

      const r = rule as Record<string, unknown>

      if (!r.channels || !Array.isArray(r.channels)) {
        throw new Error(`${filename}: Rule ${index}: missing required field 'channels' (must be an array)`)
      }

      if (r.channels.length === 0) {
        throw new Error(`${filename}: Rule ${index}: 'channels' array cannot be empty`)
      }

      if (!r.channels.every((c: unknown) => typeof c === 'string')) {
        throw new Error(`${filename}: Rule ${index}: all 'channels' entries must be strings`)
      }

      const validated: NotificationRule = {
        channels: r.channels as string[],
      }

      if (r.id !== undefined) {
        if (typeof r.id !== 'string' || !r.id.trim()) {
          throw new Error(`${filename}: Rule ${index}: 'id' must be a non-empty string`)
        }
        validated.id = r.id
      }

      if (r.event !== undefined) {
        if (typeof r.event !== 'string') {
          throw new Error(`${filename}: Rule ${index}: 'event' must be a string`)
        }
        validated.event = r.event
      }

      if (r.match !== undefined) {
        if (typeof r.match !== 'object' || Array.isArray(r.match)) {
          throw new Error(`${filename}: Rule ${index}: 'match' must be an object`)
        }
        validated.match = r.match as Record<string, unknown>
      }

      return validated
    })

    const explicitIds = new Set<string>()
    const routeIdentities = new Set<string>()
    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i]
      if (rule.id) {
        if (explicitIds.has(rule.id)) throw new Error(`${filename}: Rule ${i}: duplicate rule id '${rule.id}'`)
        explicitIds.add(rule.id)
      }
      const identity = this.routeIdentity(rule)
      if (routeIdentities.has(identity)) {
        throw new Error(`${filename}: Rule ${i}: duplicate rule identity for event '${rule.event ?? '*'}'`)
      }
      routeIdentities.add(identity)
    }

    const channels: Record<string, { enabled: boolean }> = {}
    if (parsed.channels && typeof parsed.channels === 'object') {
      for (const [name, config] of Object.entries(parsed.channels as Record<string, unknown>)) {
        if (config && typeof config === 'object') {
          const c = config as Record<string, unknown>
          channels[name] = {
            enabled: c.enabled === true,
          }
        }
      }
    }

    return { id: 'default', rules, channels }
  }

  getId(_parsed: NotificationYaml): string {
    return 'default'
  }

  toRecord(parsed: NotificationYaml): Record<string, unknown> {
    return {
      id: 'default',
      rules: parsed.rules,
      channels: parsed.channels,
    }
  }

  toComparable(row: Record<string, unknown>): Record<string, unknown> {
    return {
      id: row.id,
      rules: row.rules,
      channels: row.channels,
    }
  }

  toYaml(row: Record<string, unknown>): string {
    const obj: Record<string, unknown> = {}
    if (row.rules) obj.rules = row.rules
    if (row.channels) obj.channels = row.channels

    return yaml.dump(obj, { lineWidth: 120, noRefs: true })
  }

  protected override isValidTemplateKey(field: string, template: Record<string, unknown>): boolean {
    if (super.isValidTemplateKey(field, template)) return true
    if (field.startsWith('channels.')) return true
    if (!field.startsWith('rules.')) return false
    const ruleKey = field.slice('rules.'.length)
    return this.rulesByKey((template.rules as NotificationRule[]) ?? []).has(ruleKey)
  }

  protected override diffOverrideKeys(current: Record<string, unknown>, template: Record<string, unknown>): string[] {
    const keys: string[] = []

    const currentChannels = (current.channels as Record<string, unknown>) ?? {}
    const templateChannels = (template.channels as Record<string, unknown>) ?? {}
    for (const channel of Object.keys({ ...templateChannels, ...currentChannels }).sort()) {
      if (!this.deepEqual(currentChannels[channel], templateChannels[channel])) keys.push(`channels.${channel}`)
    }

    const currentRules = this.rulesByKey((current.rules as NotificationRule[]) ?? [])
    const templateRules = this.rulesByKey((template.rules as NotificationRule[]) ?? [])
    for (const ruleKey of [...new Set([...templateRules.keys(), ...currentRules.keys()])].sort()) {
      if (!this.deepEqual(currentRules.get(ruleKey), templateRules.get(ruleKey))) keys.push(`rules.${ruleKey}`)
    }

    return keys
  }

  protected override applyOverrideKeys(
    record: Record<string, unknown>,
    current: Record<string, unknown>,
    fieldOverrides: string[]
  ): Record<string, unknown> {
    return this.applyNotificationKeys(record, current, fieldOverrides, current)
  }

  protected override applyTemplateKeys(
    current: Record<string, unknown>,
    template: Record<string, unknown>,
    fields: string[]
  ): Record<string, unknown> {
    return this.applyNotificationKeys(current, template, fields, template)
  }

  private applyNotificationKeys(
    base: Record<string, unknown>,
    _current: Record<string, unknown>,
    fields: string[],
    source: Record<string, unknown>
  ): Record<string, unknown> {
    const next: Record<string, unknown> = { ...base }

    const channelKeys = fields
      .filter((field) => field.startsWith('channels.'))
      .map((field) => field.slice('channels.'.length))
    if (channelKeys.length > 0) {
      const nextChannels = { ...((base.channels as Record<string, unknown>) ?? {}) }
      const sourceChannels = (source.channels as Record<string, unknown>) ?? {}
      for (const channel of channelKeys) {
        if (Object.hasOwn(sourceChannels, channel)) nextChannels[channel] = sourceChannels[channel]
        else delete nextChannels[channel]
      }
      next.channels = nextChannels
    }

    const ruleKeys = fields.filter((field) => field.startsWith('rules.')).map((field) => field.slice('rules.'.length))
    if (ruleKeys.length > 0) {
      const sourceRules = this.rulesByKey((source.rules as NotificationRule[]) ?? [])
      next.rules = this.mergeRulesByKey((base.rules as NotificationRule[]) ?? [], sourceRules, ruleKeys)
    }

    if (fields.includes('channels')) next.channels = source.channels
    if (fields.includes('rules')) next.rules = source.rules

    return next
  }

  private mergeRulesByKey(
    baseRules: NotificationRule[],
    sourceRules: Map<string, NotificationRule>,
    ruleKeys: string[]
  ): NotificationRule[] {
    const remainingKeys = new Set(ruleKeys)
    const result: NotificationRule[] = []

    for (const rule of baseRules) {
      const key = this.ruleKey(rule)
      if (!remainingKeys.has(key)) {
        result.push(rule)
        continue
      }
      remainingKeys.delete(key)
      const sourceRule = sourceRules.get(key)
      if (sourceRule) result.push(sourceRule)
    }

    for (const key of remainingKeys) {
      const sourceRule = sourceRules.get(key)
      if (sourceRule) result.push(sourceRule)
    }

    return result
  }

  private rulesByKey(rules: NotificationRule[]): Map<string, NotificationRule> {
    return new Map(rules.map((rule) => [this.ruleKey(rule), rule]))
  }

  private ruleKey(rule: NotificationRule): string {
    return rule.id ?? this.routeIdentity(rule)
  }

  private routeIdentity(rule: NotificationRule): string {
    return `${rule.event ?? '*'}:${this.canonicalValue(rule.match ?? {})}`
  }

  private canonicalValue(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map((item) => this.canonicalValue(item)).join(',')}]`
    if (value !== null && typeof value === 'object') {
      const prototype = Object.getPrototypeOf(value)
      if (prototype !== Object.prototype && prototype !== null)
        throw new Error('Unsupported notification rule match value')
      const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0
      )
      return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${this.canonicalValue(item)}`).join(',')}}`
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new Error('Unsupported notification rule match value')
    }
    const primitive = JSON.stringify(value)
    if (primitive === undefined) throw new Error('Unsupported notification rule match value')
    return primitive
  }

  async afterSync(_id: string): Promise<void> {
    const rows = await db.select().from(notificationConfig).where(eq(notificationConfig.id, 'default'))
    const row = rows[0]
    if (row) {
      notificationService.setConfig({
        rules: row.rules as NotificationRule[],
        channels: row.channels as Record<string, { enabled: boolean }>,
      })
    }
  }
}
