export { ConfigSync, type SyncResult, type TemplateDiff } from './ConfigSync'
export { AgentTypeSync, type AgentTypeYaml } from './agent-type-sync'
export { ModelTierSync, type ModelTierYaml } from './model-tier-sync'
export { ChannelSync } from './channel-sync'
export { NotificationSync } from './notification-sync'
export { RoleSync } from './role-sync'
export { SquadPresetSync, type SquadPresetYaml, type ScheduleTemplateYaml } from './squad-preset-sync'
export { WorkflowSync } from './workflow-sync'
export { SkillSync, type SkillMarkdown } from './skill-sync'
export { SharedPromptSync, type SharedPromptMarkdown } from './shared-prompt-sync'
export { PublicVoiceSync, type PublicVoiceYaml } from './public-voice-sync'

import { AgentTypeSync } from './agent-type-sync'
import { ModelTierSync } from './model-tier-sync'
import { SquadPresetSync } from './squad-preset-sync'
import { WorkflowSync } from './workflow-sync'
import { ChannelSync } from './channel-sync'
import { NotificationSync } from './notification-sync'
import { RoleSync } from './role-sync'
import { SkillSync } from './skill-sync'
import { SharedPromptSync } from './shared-prompt-sync'
import { PublicVoiceSync } from './public-voice-sync'

export const skillSync = new SkillSync()
export const sharedPromptSync = new SharedPromptSync()
export const publicVoiceSync = new PublicVoiceSync()
export const modelTierSync = new ModelTierSync()
export const agentTypeSync = new AgentTypeSync()
export const squadPresetSync = new SquadPresetSync()
export const workflowSync = new WorkflowSync()
export const channelSync = new ChannelSync()
export const notificationSync = new NotificationSync()
export const roleSync = new RoleSync()

export async function syncAllConfig(): Promise<void> {
  await roleSync.sync()
  await skillSync.sync()
  await sharedPromptSync.sync()
  await publicVoiceSync.sync()
  await modelTierSync.sync()
  await agentTypeSync.sync()
  await squadPresetSync.sync()
  await workflowSync.sync()
  await channelSync.sync()
  await notificationSync.sync()
}
