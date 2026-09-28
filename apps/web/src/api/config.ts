import type { AgentTypeIntegrationPolicyV1 } from '@ficus/shared'
import { apiFetch, authFetch } from './client'

// ============================================================================
// Shared
// ============================================================================

export interface TemplateDiff {
  hasDrift: boolean
  current: Record<string, unknown> | null
  template: Record<string, unknown> | null
  fieldOverrides: string[]
}

// ============================================================================
// Agent Types
// ============================================================================

export interface AgentTypeConfig {
  systemOnly?: boolean
  id: string
  name: string
  model: string
  tier: string | null
  resolvedChain?: string
  provenance?: string
  description: string | null
  systemPrompt: string
  includes: string[]
  /** Composed prompt (system prompt + enabled includes) — detail endpoint only. */
  resolvedSystemPrompt?: string
  skills: string[] | null
  extensions: string[] | null
  toolsAllow: string[] | null
  toolsDeny: string[] | null
  integrationCapabilities: AgentTypeIntegrationPolicyV1 | null
  disabled: boolean
  yamlFieldOverrides: string[]
  hasTemplate: boolean
  createdAt: string
  updatedAt: string
}

export async function getAgentTypes(): Promise<AgentTypeConfig[]> {
  return apiFetch<AgentTypeConfig[]>('/agent-types')
}

export async function getAgentType(id: string): Promise<AgentTypeConfig> {
  return apiFetch<AgentTypeConfig>(`/agent-types/${id}`)
}

export async function createAgentType(data: Partial<AgentTypeConfig> & { id: string }): Promise<AgentTypeConfig> {
  return apiFetch<AgentTypeConfig>('/agent-types', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function updateAgentType(id: string, data: Partial<AgentTypeConfig>): Promise<AgentTypeConfig> {
  return apiFetch<AgentTypeConfig>(`/agent-types/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  })
}

export async function deleteAgentType(id: string): Promise<void> {
  return apiFetch<void>(`/agent-types/${id}`, { method: 'DELETE' })
}

export async function getAgentTypeTemplateDiff(id: string): Promise<TemplateDiff> {
  return apiFetch<TemplateDiff>(`/agent-types/${id}/template-diff`)
}

export async function revertAgentType(id: string): Promise<void> {
  return apiFetch<void>(`/agent-types/${id}/revert-to-template`, { method: 'POST' })
}

export async function revertAgentTypeFields(id: string, fields: string[]): Promise<void> {
  return apiFetch<void>(`/agent-types/${id}/revert-template-fields`, {
    method: 'POST',
    body: JSON.stringify({ fields }),
  })
}

export async function disableAgentType(id: string): Promise<void> {
  await apiFetch<void>(`/agent-types/${id}/disable`, { method: 'POST' })
}

export async function enableAgentType(id: string): Promise<void> {
  await apiFetch<void>(`/agent-types/${id}/enable`, { method: 'POST' })
}

export async function exportAgentTypeYaml(id: string): Promise<string> {
  const response = await authFetch(`/agent-types/${id}/export`)
  if (!response.ok) throw new Error(`API error: ${response.status}`)
  return response.text()
}

// ============================================================================
// Squad Presets
// ============================================================================

export interface SquadPresetConfig {
  workflows?: import('@ficus/shared').SquadPresetWorkflows | null
  id: string
  name: string
  description: string | null
  purpose: string | null
  defaultAgents: string[]
  managerInstructions: string | null
  scheduleTemplates: unknown[]
  disabled: boolean
  yamlFieldOverrides: string[]
  hasTemplate: boolean
  createdAt: string
  updatedAt: string
}

export async function getSquadPresets(): Promise<SquadPresetConfig[]> {
  return apiFetch<SquadPresetConfig[]>('/squad-presets')
}

export async function getSquadPreset(id: string): Promise<SquadPresetConfig> {
  return apiFetch<SquadPresetConfig>(`/squad-presets/${id}`)
}

export async function createSquadPreset(data: Partial<SquadPresetConfig> & { id: string }): Promise<SquadPresetConfig> {
  return apiFetch<SquadPresetConfig>('/squad-presets', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function updateSquadPreset(id: string, data: Partial<SquadPresetConfig>): Promise<SquadPresetConfig> {
  return apiFetch<SquadPresetConfig>(`/squad-presets/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  })
}

export async function deleteSquadPreset(id: string): Promise<void> {
  return apiFetch<void>(`/squad-presets/${id}`, { method: 'DELETE' })
}

export async function getSquadPresetTemplateDiff(id: string): Promise<TemplateDiff> {
  return apiFetch<TemplateDiff>(`/squad-presets/${id}/template-diff`)
}

export async function revertSquadPreset(id: string): Promise<void> {
  return apiFetch<void>(`/squad-presets/${id}/revert-to-template`, { method: 'POST' })
}

export async function revertSquadPresetFields(id: string, fields: string[]): Promise<void> {
  return apiFetch<void>(`/squad-presets/${id}/revert-template-fields`, {
    method: 'POST',
    body: JSON.stringify({ fields }),
  })
}

export async function disableSquadPreset(id: string): Promise<void> {
  await apiFetch<void>(`/squad-presets/${id}/disable`, { method: 'POST' })
}

export async function enableSquadPreset(id: string): Promise<void> {
  await apiFetch<void>(`/squad-presets/${id}/enable`, { method: 'POST' })
}

export async function exportSquadPresetYaml(id: string): Promise<string> {
  const response = await authFetch(`/squad-presets/${id}/export`)
  if (!response.ok) throw new Error(`API error: ${response.status}`)
  return response.text()
}

// ============================================================================
// Channel Instances
// ============================================================================

export interface ChannelInstanceConfig {
  trustedChannelIds?: string[]
  allowedChannelIds?: string[]
  deniedChannelIds?: string[]
  allowPrivateChats?: boolean
  id: string
  name: string
  provider: string
  providerConfig: Record<string, unknown>
  channelSquadMap: Record<string, string>
  defaultSquadId: string | null
  disabled: boolean
  yamlFieldOverrides: string[]
  hasTemplate: boolean
  createdAt: string
  updatedAt: string
}

export async function getChannelInstances(): Promise<ChannelInstanceConfig[]> {
  return apiFetch<ChannelInstanceConfig[]>('/channel-instances')
}

export async function getChannelInstance(id: string): Promise<ChannelInstanceConfig> {
  return apiFetch<ChannelInstanceConfig>(`/channel-instances/${id}`)
}

export async function createChannelInstance(
  data: Partial<ChannelInstanceConfig> & { id: string; name: string; provider: string }
): Promise<ChannelInstanceConfig> {
  return apiFetch<ChannelInstanceConfig>('/channel-instances', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function updateChannelInstance(
  id: string,
  data: Partial<ChannelInstanceConfig>
): Promise<ChannelInstanceConfig> {
  return apiFetch<ChannelInstanceConfig>(`/channel-instances/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  })
}

export async function deleteChannelInstance(id: string): Promise<void> {
  return apiFetch<void>(`/channel-instances/${id}`, { method: 'DELETE' })
}

export async function getChannelInstanceTemplateDiff(id: string): Promise<TemplateDiff> {
  return apiFetch<TemplateDiff>(`/channel-instances/${id}/template-diff`)
}

export async function revertChannelInstance(id: string): Promise<void> {
  return apiFetch<void>(`/channel-instances/${id}/revert-to-template`, { method: 'POST' })
}

export async function revertChannelInstanceFields(id: string, fields: string[]): Promise<void> {
  return apiFetch<void>(`/channel-instances/${id}/revert-template-fields`, {
    method: 'POST',
    body: JSON.stringify({ fields }),
  })
}

export async function disableChannelInstance(id: string): Promise<void> {
  await apiFetch<void>(`/channel-instances/${id}/disable`, { method: 'POST' })
}

export async function enableChannelInstance(id: string): Promise<void> {
  await apiFetch<void>(`/channel-instances/${id}/enable`, { method: 'POST' })
}

export async function exportChannelInstanceYaml(id: string): Promise<string> {
  const response = await authFetch(`/channel-instances/${id}/export`)
  if (!response.ok) throw new Error(`API error: ${response.status}`)
  return response.text()
}

// ============================================================================
// Notification Config
// ============================================================================

export interface NotificationConfigData {
  id: string
  rules: unknown[]
  channels: Record<string, unknown>
  disabled: boolean
  yamlFieldOverrides: string[]
  hasTemplate: boolean
  createdAt: string
  updatedAt: string
}

export async function getNotificationConfig(): Promise<NotificationConfigData> {
  return apiFetch<NotificationConfigData>('/notification-config')
}

// Per-user notification preferences (self-service).
export interface MyNotificationPrefs {
  showPreviews?: boolean
  pushEnabled: boolean
  mutedEvents: string[]
  /** Mutable push category ids (see PUSH_CATEGORIES in @ficus/shared); each gets a toggle in the UI. */
  pushEvents: string[]
}

export async function getMyNotificationPrefs(): Promise<MyNotificationPrefs> {
  return apiFetch<MyNotificationPrefs>('/notification-config/me')
}

export async function updateMyNotificationPrefs(input: {
  showPreviews?: boolean
  pushEnabled?: boolean
  mutedEvents?: string[]
}): Promise<MyNotificationPrefs> {
  return apiFetch<MyNotificationPrefs>('/notification-config/me', {
    method: 'PUT',
    body: JSON.stringify(input),
  })
}

export async function updateNotificationConfig(data: Partial<NotificationConfigData>): Promise<NotificationConfigData> {
  return apiFetch<NotificationConfigData>('/notification-config', {
    method: 'PUT',
    body: JSON.stringify(data),
  })
}

export async function getNotificationConfigTemplateDiff(): Promise<TemplateDiff> {
  return apiFetch<TemplateDiff>('/notification-config/template-diff')
}

export async function revertNotificationConfig(): Promise<void> {
  return apiFetch<void>('/notification-config/revert-to-template', { method: 'POST' })
}

export async function revertNotificationConfigFields(fields: string[]): Promise<void> {
  return apiFetch<void>('/notification-config/revert-template-fields', {
    method: 'POST',
    body: JSON.stringify({ fields }),
  })
}

export async function disableNotificationConfig(): Promise<void> {
  await apiFetch<void>('/notification-config/disable', { method: 'POST' })
}

export async function enableNotificationConfig(): Promise<void> {
  await apiFetch<void>('/notification-config/enable', { method: 'POST' })
}

export async function exportNotificationConfigYaml(): Promise<string> {
  const response = await authFetch(`/notification-config/export`)
  if (!response.ok) throw new Error(`API error: ${response.status}`)
  return response.text()
}

// ============================================================================
// Shared Prompts
// ============================================================================

export interface SharedPromptConfig {
  id: string
  name: string
  description: string | null
  content: string
  yamlFieldOverrides: string[]
  hasTemplate: boolean
  disabled: boolean
  createdAt: string
  updatedAt: string
}

export async function getSharedPrompts(): Promise<SharedPromptConfig[]> {
  return apiFetch<SharedPromptConfig[]>('/shared-prompts')
}

export async function getSharedPrompt(id: string): Promise<SharedPromptConfig> {
  return apiFetch<SharedPromptConfig>(`/shared-prompts/${id}`)
}

export async function createSharedPrompt(data: {
  id: string
  name: string
  content: string
  description?: string | null
}): Promise<SharedPromptConfig> {
  return apiFetch<SharedPromptConfig>('/shared-prompts', { method: 'POST', body: JSON.stringify(data) })
}

export async function updateSharedPrompt(
  id: string,
  data: { content: string; name?: string; description?: string | null }
): Promise<SharedPromptConfig> {
  return apiFetch<SharedPromptConfig>(`/shared-prompts/${id}`, { method: 'PUT', body: JSON.stringify(data) })
}

export async function deleteSharedPrompt(id: string): Promise<void> {
  await apiFetch<void>(`/shared-prompts/${id}`, { method: 'DELETE' })
}

export async function disableSharedPrompt(id: string): Promise<void> {
  await apiFetch<void>(`/shared-prompts/${id}/disable`, { method: 'POST' })
}

export async function enableSharedPrompt(id: string): Promise<void> {
  await apiFetch<void>(`/shared-prompts/${id}/enable`, { method: 'POST' })
}

export async function getSharedPromptTemplateDiff(id: string): Promise<TemplateDiff> {
  return apiFetch<TemplateDiff>(`/shared-prompts/${id}/template-diff`)
}

export async function revertSharedPrompt(id: string): Promise<void> {
  await apiFetch<void>(`/shared-prompts/${id}/revert-to-template`, { method: 'POST' })
}

export async function revertSharedPromptFields(id: string, fields: string[]): Promise<void> {
  await apiFetch<void>(`/shared-prompts/${id}/revert-template-fields`, {
    method: 'POST',
    body: JSON.stringify({ fields }),
  })
}

// ============================================================================
// Skills
// ============================================================================

export interface SkillConfig {
  id: string
  name: string
  description: string | null
  content: string
  supportFiles: Record<string, string>
  disabled: boolean
  yamlFieldOverrides: string[]
  hasTemplate: boolean
  createdAt: string
  updatedAt: string
}

export async function getSkills(): Promise<SkillConfig[]> {
  return apiFetch<SkillConfig[]>('/skills')
}

export async function getSkill(id: string): Promise<SkillConfig> {
  return apiFetch<SkillConfig>(`/skills/${id}`)
}

export async function createSkill(data: Partial<SkillConfig> & { id: string; content: string }): Promise<SkillConfig> {
  return apiFetch<SkillConfig>('/skills', { method: 'POST', body: JSON.stringify(data) })
}

export async function importSkill(data: { id?: string; content: string }): Promise<SkillConfig> {
  return apiFetch<SkillConfig>('/skills/import', { method: 'POST', body: JSON.stringify(data) })
}

export async function updateSkill(id: string, data: Partial<SkillConfig>): Promise<SkillConfig> {
  return apiFetch<SkillConfig>(`/skills/${id}`, { method: 'PUT', body: JSON.stringify(data) })
}

export async function deleteSkill(id: string): Promise<void> {
  return apiFetch<void>(`/skills/${id}`, { method: 'DELETE' })
}

export async function getSkillTemplateDiff(id: string): Promise<TemplateDiff> {
  return apiFetch<TemplateDiff>(`/skills/${id}/template-diff`)
}

export async function revertSkill(id: string): Promise<void> {
  return apiFetch<void>(`/skills/${id}/revert-to-template`, { method: 'POST' })
}

export async function revertSkillFields(id: string, fields: string[]): Promise<void> {
  return apiFetch<void>(`/skills/${id}/revert-template-fields`, {
    method: 'POST',
    body: JSON.stringify({ fields }),
  })
}

export async function disableSkill(id: string): Promise<void> {
  return apiFetch<void>(`/skills/${id}/disable`, { method: 'POST' })
}

export async function enableSkill(id: string): Promise<void> {
  return apiFetch<void>(`/skills/${id}/enable`, { method: 'POST' })
}

export async function exportSkillMarkdown(id: string): Promise<string> {
  const response = await authFetch(`/skills/${id}/export`)
  if (!response.ok) throw new Error(`API error: ${response.status}`)
  return response.text()
}

export interface ModelTierConfig {
  disabled?: boolean
  slug: string
  label: string
  description: string | null
  chain: string
  sortOrder: number
  usedByCount: number
  derivedOpenRouterFallbacks?: string[]
}
export async function getModelTiers(): Promise<ModelTierConfig[]> {
  return apiFetch('/model-tiers')
}
export async function updateModelTier(tier: ModelTierConfig): Promise<ModelTierConfig> {
  return apiFetch(`/model-tiers/${tier.slug}`, { method: 'PUT', body: JSON.stringify(tier) })
}
export async function deleteModelTier(slug: string): Promise<void> {
  await apiFetch(`/model-tiers/${slug}`, { method: 'DELETE' })
}
