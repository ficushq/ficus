import yaml from 'js-yaml'
import { eq } from 'drizzle-orm'
import { join } from 'path'
import { agentTypes, db } from '../../db'
import { AGENT_TYPES_DIR } from '../../lib/paths'
import { validateModelSpecList } from '../../lib/utils/model-spec'
import { AgentType } from '../../entities/AgentType'
import { ConfigSync, type SyncResult } from './ConfigSync'
import { loadSharedPromptFiles } from './shared-prompt-sync'
import { INTEGRATION_CAPABILITIES, type AgentTypeIntegrationPolicyV1 } from '@ficus/shared'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HeartbeatYaml {
  enabled: boolean
  schedule: {
    interval?: string
    cron?: string
    adaptive?: boolean
    mode?: 'singleton' | 'broadcast'
    subject?: string
    prompt?: string
  }
  overrides: Record<string, unknown>
}

export interface AgentTypeYaml {
  systemOnly?: boolean
  id: string
  model?: string
  tier?: string
  name: string
  description?: string
  systemPrompt: string
  includes?: string[]
  skills?: string[]
  extensions?: string[]
  scopes?: string[]
  integrations?: AgentTypeIntegrationPolicyV1
  tools?: {
    allow?: string[]
    deny?: string[]
  }
  earlyMarginTokens?: number
  inFlightMarginTokens?: number
  heartbeat?: HeartbeatYaml
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

class YamlValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'YamlValidationError'
  }
}

function validateRequired(obj: Record<string, unknown>, fields: string[], context: string): void {
  for (const field of fields) {
    if (obj[field] === undefined || obj[field] === null || obj[field] === '') {
      throw new YamlValidationError(`${context}: Missing required field '${field}'`)
    }
  }
}

// ---------------------------------------------------------------------------
// AgentTypeSync
// ---------------------------------------------------------------------------

export class AgentTypeSync extends ConfigSync<AgentTypeYaml> {
  readonly name = 'agent-types'
  readonly directory = AGENT_TYPES_DIR
  readonly table = agentTypes
  readonly idColumn = agentTypes.id
  readonly yamlTemplateColumn = agentTypes.yamlTemplate
  readonly yamlFieldOverridesColumn = agentTypes.yamlFieldOverrides
  readonly updatedAtColumn = agentTypes.updatedAt
  readonly disabledColumn = agentTypes.disabled

  // -------------------------------------------------------------------------
  // Parse
  // -------------------------------------------------------------------------

  parse(content: string, _filename: string): AgentTypeYaml {
    const parsed = yaml.load(content) as Record<string, unknown>

    if (!parsed || typeof parsed !== 'object') {
      throw new YamlValidationError('AgentType: Invalid YAML content - expected an object')
    }

    validateRequired(parsed, ['id', 'name', 'systemPrompt'], 'AgentType')
    if (!parsed.model && !parsed.tier) throw new YamlValidationError("AgentType: either 'model' or 'tier' is required")

    if (Object.hasOwn(parsed, 'flowPrompt'))
      throw new YamlValidationError(
        'AgentType: flowPrompt was removed; put expertise in systemPrompt and step instructions in the workflow'
      )

    if (parsed.systemOnly !== undefined && typeof parsed.systemOnly !== 'boolean')
      throw new YamlValidationError("AgentType: 'systemOnly' must be a boolean")
    const agentType: AgentTypeYaml = {
      systemOnly: (parsed.systemOnly as boolean | undefined) ?? false,
      id: parsed.id as string,
      model: (parsed.model as string | undefined) ?? '',
      tier: parsed.tier as string | undefined,
      name: parsed.name as string,
      systemPrompt: parsed.systemPrompt as string,
    }

    if (parsed.description !== undefined) {
      agentType.description = parsed.description as string
    }

    if (parsed.model !== undefined && typeof parsed.model !== 'string') {
      throw new YamlValidationError("AgentType: 'model' must be a string")
    }

    try {
      if (parsed.model) validateModelSpecList(parsed.model)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new YamlValidationError(`AgentType: Invalid value for field 'model'. ${message}`)
    }

    if (parsed.includes !== undefined && parsed.includes !== null) {
      if (!Array.isArray(parsed.includes)) {
        throw new YamlValidationError("AgentType: 'includes' must be an array of template names")
      }
      for (let i = 0; i < parsed.includes.length; i++) {
        if (typeof parsed.includes[i] !== 'string') {
          throw new YamlValidationError(`AgentType: 'includes[${i}]' must be a string`)
        }
      }
      agentType.includes = parsed.includes as string[]
    }

    if (parsed.skills !== undefined && parsed.skills !== null) {
      if (!Array.isArray(parsed.skills)) {
        throw new YamlValidationError("AgentType: 'skills' must be an array of paths")
      }
      for (let i = 0; i < parsed.skills.length; i++) {
        if (typeof parsed.skills[i] !== 'string') {
          throw new YamlValidationError(`AgentType: 'skills[${i}]' must be a string path`)
        }
      }
      agentType.skills = parsed.skills as string[]
    }

    if (parsed.extensions !== undefined && parsed.extensions !== null) {
      if (!Array.isArray(parsed.extensions)) {
        throw new YamlValidationError("AgentType: 'extensions' must be an array of paths")
      }
      for (let i = 0; i < parsed.extensions.length; i++) {
        if (typeof parsed.extensions[i] !== 'string') {
          throw new YamlValidationError(`AgentType: 'extensions[${i}]' must be a string path`)
        }
      }
      agentType.extensions = parsed.extensions as string[]
    }

    if (parsed.scopes !== undefined && parsed.scopes !== null) {
      if (!Array.isArray(parsed.scopes)) {
        throw new YamlValidationError("AgentType: 'scopes' must be an array of permission strings")
      }
      for (let i = 0; i < parsed.scopes.length; i++) {
        if (typeof parsed.scopes[i] !== 'string') {
          throw new YamlValidationError(`AgentType: 'scopes[${i}]' must be a string`)
        }
      }
      agentType.scopes = parsed.scopes as string[]
    }

    if (parsed.integrations !== undefined && parsed.integrations !== null) {
      if (typeof parsed.integrations !== 'object' || Array.isArray(parsed.integrations)) {
        throw new YamlValidationError("AgentType: 'integrations' must be an object")
      }
      const integrations = parsed.integrations as Record<string, unknown>
      if (integrations.version !== 1) {
        throw new YamlValidationError("AgentType: 'integrations.version' must be 1")
      }
      if (!integrations.allow || typeof integrations.allow !== 'object' || Array.isArray(integrations.allow)) {
        throw new YamlValidationError("AgentType: 'integrations.allow' must be an object")
      }
      const allow: AgentTypeIntegrationPolicyV1['allow'] = {}
      for (const [provider, capabilities] of Object.entries(integrations.allow)) {
        if (!/^[a-z][a-z0-9_-]{0,63}$/.test(provider)) {
          throw new YamlValidationError(`AgentType: invalid integration provider '${provider}'`)
        }
        if (!Array.isArray(capabilities)) {
          throw new YamlValidationError(`AgentType: integration '${provider}' capabilities must be an array`)
        }
        const normalized = [...new Set(capabilities)]
        for (const capability of normalized) {
          if (typeof capability !== 'string' || !(INTEGRATION_CAPABILITIES as readonly string[]).includes(capability)) {
            throw new YamlValidationError(`AgentType: unknown integration capability '${String(capability)}'`)
          }
        }
        allow[provider] = normalized as AgentTypeIntegrationPolicyV1['allow'][string]
      }
      agentType.integrations = { version: 1, allow }
    }

    if (parsed.tools !== undefined && parsed.tools !== null) {
      if (typeof parsed.tools !== 'object') {
        throw new YamlValidationError("AgentType: 'tools' must be an object")
      }

      const tools = parsed.tools as Record<string, unknown>
      agentType.tools = {}

      if (tools.allow !== undefined) {
        if (!Array.isArray(tools.allow)) {
          throw new YamlValidationError("AgentType: 'tools.allow' must be an array")
        }
        agentType.tools.allow = tools.allow as string[]
      }

      if (tools.deny !== undefined) {
        if (!Array.isArray(tools.deny)) {
          throw new YamlValidationError("AgentType: 'tools.deny' must be an array")
        }
        agentType.tools.deny = tools.deny as string[]
      }
    }

    if (parsed.earlyMarginTokens !== undefined && parsed.earlyMarginTokens !== null) {
      if (typeof parsed.earlyMarginTokens !== 'number') {
        throw new YamlValidationError("AgentType: 'earlyMarginTokens' must be a number")
      }
      agentType.earlyMarginTokens = parsed.earlyMarginTokens
    }

    if (parsed.inFlightMarginTokens !== undefined && parsed.inFlightMarginTokens !== null) {
      if (typeof parsed.inFlightMarginTokens !== 'number') {
        throw new YamlValidationError("AgentType: 'inFlightMarginTokens' must be a number")
      }
      agentType.inFlightMarginTokens = parsed.inFlightMarginTokens
    }

    if (parsed.heartbeat !== undefined) {
      if (typeof parsed.heartbeat !== 'object' || parsed.heartbeat === null) {
        throw new YamlValidationError("AgentType: 'heartbeat' must be an object")
      }

      const hb = parsed.heartbeat as Record<string, unknown>

      if (typeof hb.enabled !== 'boolean') {
        throw new YamlValidationError("AgentType: 'heartbeat.enabled' must be a boolean")
      }

      if (!hb.schedule || typeof hb.schedule !== 'object') {
        throw new YamlValidationError("AgentType: 'heartbeat.schedule' is required and must be an object")
      }

      const schedule = hb.schedule as Record<string, unknown>

      if (schedule.mode !== 'singleton' && schedule.mode !== 'broadcast') {
        throw new YamlValidationError("AgentType: 'heartbeat.schedule.mode' must be 'singleton' or 'broadcast'")
      }

      if (!schedule.interval && !schedule.cron) {
        throw new YamlValidationError("AgentType: 'heartbeat.schedule' must include at least 'interval' or 'cron'")
      }

      if (schedule.interval !== undefined && typeof schedule.interval !== 'string') {
        throw new YamlValidationError("AgentType: 'heartbeat.schedule.interval' must be a string")
      }

      if (schedule.cron !== undefined && typeof schedule.cron !== 'string') {
        throw new YamlValidationError("AgentType: 'heartbeat.schedule.cron' must be a string")
      }

      if (schedule.adaptive !== undefined && typeof schedule.adaptive !== 'boolean') {
        throw new YamlValidationError("AgentType: 'heartbeat.schedule.adaptive' must be a boolean")
      }

      const heartbeat: HeartbeatYaml = {
        enabled: hb.enabled,
        schedule,
        overrides: {},
      }

      const reservedKeys = new Set(['enabled', 'schedule'])
      for (const [key, value] of Object.entries(hb)) {
        if (!reservedKeys.has(key)) {
          heartbeat.overrides[key] = value
        }
      }

      agentType.heartbeat = heartbeat
    }

    return agentType
  }

  // -------------------------------------------------------------------------
  // Includes
  // -------------------------------------------------------------------------

  /** Agent types no longer bake include text into systemPrompt; they carry the list and the runtime composes. */
  async loadFromDir(): Promise<AgentTypeYaml[]> {
    const results = await super.loadFromDir()
    await this.validateIncludes(results, await loadSharedPromptFiles(this.sharedPromptsDir))
    return results
  }

  async validateIncludes(types: AgentTypeYaml[], files: Map<string, string>): Promise<void> {
    for (const agentType of types) {
      const seen = new Set<string>()
      for (const name of agentType.includes ?? []) {
        if (!files.has(name))
          throw new YamlValidationError(
            `AgentType '${agentType.id}': Include '${name}' not found in config/agent-types/shared/`
          )
        // The API rejects duplicates too: composing the same block twice is
        // always a mistake, and order-sensitive edits get ambiguous.
        if (seen.has(name))
          throw new YamlValidationError(`AgentType '${agentType.id}': Include '${name}' is listed twice`)
        seen.add(name)
      }
    }
  }

  private get sharedPromptsDir(): string {
    return join(this.directory, 'shared')
  }

  // -------------------------------------------------------------------------
  // Sync
  // -------------------------------------------------------------------------

  async sync(): Promise<SyncResult> {
    // Read the legacy markers before the base sync fills `includes` from the
    // template — afterwards every row looks migrated.
    const legacyIds = await this.findLegacyMergedIds()
    const result = await super.sync()
    await this.splitLegacyMergedPrompts(legacyIds)
    return result
  }

  /**
   * A row edited before includes were split out carries the include text inside
   * its systemPrompt override and has no stored include list.
   */
  private async findLegacyMergedIds(): Promise<string[]> {
    // One narrow query decides the whole thing: with no systemPrompt override
    // anywhere — the normal case — there is nothing to repair and the sync does
    // no per-row work at all.
    const rows = await db
      .select({ id: agentTypes.id, overrides: agentTypes.yamlFieldOverrides, includes: agentTypes.includes })
      .from(agentTypes)
    return rows
      .filter((row) => {
        const overrides = (row.overrides as string[] | null) ?? []
        if (!overrides.includes('systemPrompt')) return false
        // An `includes` override is a post-split admin decision, not a
        // pre-split merge: leave it exactly as the admin left it, silently.
        if (overrides.includes('includes')) return false
        return (row.includes ?? []).length === 0
      })
      .map((row) => row.id)
  }

  /**
   * One-time repair for rows edited before includes were split out: their
   * systemPrompt override contains the include text verbatim. Strip it and
   * adopt the template's include list. A hand-modified merge cannot be split
   * safely, so it keeps its text and gets an empty include list — the composed
   * prompt stays exactly what the admin wrote instead of gaining a second copy.
   */
  private async splitLegacyMergedPrompts(legacyIds: string[]): Promise<void> {
    if (legacyIds.length === 0) return
    const files = await loadSharedPromptFiles(this.sharedPromptsDir)
    for (const id of legacyIds) {
      const [row] = await db.select().from(agentTypes).where(eq(agentTypes.id, id))
      const template = row?.yamlTemplate as { systemPrompt?: string; includes?: string[] } | null | undefined
      const wanted = template?.includes ?? []
      if (!row || !template || wanted.length === 0) continue

      const stripped = stripLegacyIncludeSuffix(
        row.systemPrompt,
        wanted.map((name) => files.get(name) ?? '')
      )
      if (stripped === null) {
        this.log.warn(
          `agent type '${id}': systemPrompt override could not be split against the current include files; left as-is with no includes. Revert the type to its template to resume receiving shared blocks.`
        )
        // Drop the list the base sync just copied from the template, or the
        // runtime would append a second copy of text this prompt already has.
        if ((row.includes ?? []).length === 0) continue
        await db.update(agentTypes).set({ includes: [], updatedAt: new Date() }).where(eq(agentTypes.id, id))
        await this.recomputeFieldOverrides(id)
        continue
      }

      await db
        .update(agentTypes)
        .set({ systemPrompt: stripped, includes: wanted, updatedAt: new Date() })
        .where(eq(agentTypes.id, id))
      await this.recomputeFieldOverrides(id)
      this.log.info(`agent type '${id}': split legacy merged prompt into systemPrompt + includes`)
    }
    AgentType.invalidateCache()
  }

  // -------------------------------------------------------------------------
  // Record mapping
  // -------------------------------------------------------------------------

  getId(parsed: AgentTypeYaml): string {
    return parsed.id
  }

  toRecord(parsed: AgentTypeYaml): Record<string, unknown> {
    return {
      systemOnly: parsed.systemOnly ?? false,
      id: parsed.id,
      name: parsed.name,
      model: parsed.model ?? '',
      tier: parsed.tier ?? null,
      description: parsed.description ?? null,
      systemPrompt: parsed.systemPrompt,
      includes: parsed.includes ?? [],
      skills: parsed.skills ?? null,
      extensions: parsed.extensions ?? null,
      toolsAllow: parsed.tools?.allow ?? null,
      toolsDeny: parsed.tools?.deny ?? null,
      extraScopes: parsed.scopes ?? null,
      integrationCapabilities: parsed.integrations ?? null,
      earlyMarginTokens: parsed.earlyMarginTokens ?? null,
      inFlightMarginTokens: parsed.inFlightMarginTokens ?? null,
    }
  }

  toComparable(row: Record<string, unknown>): Record<string, unknown> {
    return {
      systemOnly: row.systemOnly ?? false,
      id: row.id as string,
      name: row.name as string,
      model: row.model as string,
      tier: (row.tier as string) ?? null,
      description: (row.description as string) ?? null,
      systemPrompt: row.systemPrompt as string,
      includes: (row.includes as string[]) ?? [],
      skills: (row.skills as string[]) ?? null,
      extensions: (row.extensions as string[]) ?? null,
      toolsAllow: (row.toolsAllow as string[]) ?? null,
      toolsDeny: (row.toolsDeny as string[]) ?? null,
      extraScopes: (row.extraScopes as string[]) ?? null,
      integrationCapabilities: (row.integrationCapabilities as AgentTypeIntegrationPolicyV1) ?? null,
      earlyMarginTokens: (row.earlyMarginTokens as number | null) ?? null,
      inFlightMarginTokens: (row.inFlightMarginTokens as number | null) ?? null,
    }
  }

  // -------------------------------------------------------------------------
  // YAML Export
  // -------------------------------------------------------------------------

  toYaml(row: Record<string, unknown>): string {
    const obj: Record<string, unknown> = {
      id: row.id,
      name: row.name,
      model: row.model,
    }
    if (row.systemOnly) obj.systemOnly = true
    if (row.tier) obj.tier = row.tier
    if (row.description) obj.description = row.description
    obj.systemPrompt = row.systemPrompt
    const includes = row.includes as string[] | null
    if (includes && includes.length > 0) obj.includes = includes
    if (row.skills) obj.skills = row.skills
    if (row.extensions) obj.extensions = row.extensions
    const earlyMarginTokens = row.earlyMarginTokens as number | null
    if (earlyMarginTokens != null) obj.earlyMarginTokens = earlyMarginTokens
    const inFlightMarginTokens = row.inFlightMarginTokens as number | null
    if (inFlightMarginTokens != null) obj.inFlightMarginTokens = inFlightMarginTokens

    const integrationCapabilities = row.integrationCapabilities as AgentTypeIntegrationPolicyV1 | null
    if (integrationCapabilities) obj.integrations = integrationCapabilities

    const extraScopes = row.extraScopes as string[] | null
    if (extraScopes && extraScopes.length > 0) obj.scopes = extraScopes

    // Convert flat toolsAllow/toolsDeny back to nested tools: { allow, deny }
    const toolsAllow = row.toolsAllow as string[] | null
    const toolsDeny = row.toolsDeny as string[] | null
    if (toolsAllow || toolsDeny) {
      const tools: Record<string, unknown> = {}
      if (toolsAllow) tools.allow = toolsAllow
      if (toolsDeny) tools.deny = toolsDeny
      obj.tools = tools
    }

    return yaml.dump(obj, { lineWidth: 120, noRefs: true })
  }

  // -------------------------------------------------------------------------
  // Hooks
  // -------------------------------------------------------------------------

  async afterSync(_id: string): Promise<void> {
    AgentType.invalidateCache()
  }
}

// ---------------------------------------------------------------------------
// Prompt composition helpers
// ---------------------------------------------------------------------------

/** The legacy merge, kept only for tests and the one-time migration strip. */
export function composeFromYaml(parsed: AgentTypeYaml, files: Map<string, string>): string {
  const parts = (parsed.includes ?? []).map((id) => files.get(id)).filter((t): t is string => typeof t === 'string')
  return [parsed.systemPrompt, ...parts].join('\n\n')
}

/**
 * Pre-includes databases stored systemPrompt = own + '\n\n' + include texts.
 * If a stored prompt still ends with exactly that suffix, return the own part;
 * otherwise null (leave it alone — re-appending at runtime would duplicate).
 */
export function stripLegacyIncludeSuffix(prompt: string, includeTexts: string[]): string | null {
  if (includeTexts.length === 0) return prompt
  const suffix = '\n\n' + includeTexts.join('\n\n')
  return prompt.endsWith(suffix) ? prompt.slice(0, -suffix.length) : null
}
