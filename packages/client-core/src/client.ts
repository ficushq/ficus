import { workStreamsResource } from './resources/workStreams'
import { workflowsResource } from './resources/workflows'
import type { Transport } from './transport'
import { authResource } from './resources/auth'
import { sessionsResource } from './resources/sessions'
import { usersResource } from './resources/users'
import { chatResource } from './resources/chat'
import { actionsResource } from './resources/actions'
import { agentQuestionsResource } from './resources/agentQuestions'
import { inboxResource } from './resources/inbox'
import { imagesResource } from './resources/images'
import { agentsResource } from './resources/agents'
import { squadsResource } from './resources/squads'
import { pushResource } from './resources/push'
import { userPreferencesResource } from './resources/userPreferences'
import { farmPreferencesResource } from './resources/farmPreferences'
import { farmChatResource } from './resources/farmChat'
import { themePresetsResource } from './resources/themePresets'
import { notificationConfigResource } from './resources/notificationConfig'
import { systemResource } from './resources/system'

/**
 * Assemble the full Ficus API client over a host-provided transport.
 * Web injects a cookie+CSRF transport; mobile injects a bearer-token transport.
 *
 * Resources cover the surface shared by web and mobile. Web-only modules
 * (terminal, secrets, monitors, deployments, schedules, grants, agent/squad presets,
 * etc.) remain in apps/web/src/api for now — see OQ-MIGRATE-REST in the design spec.
 */
export function createClient(t: Transport) {
  return {
    transport: t,
    auth: authResource(t),
    sessions: sessionsResource(t),
    users: usersResource(t),
    chat: chatResource(t),
    actions: actionsResource(t),
    agentQuestions: agentQuestionsResource(t),
    inbox: inboxResource(t),
    images: imagesResource(t),
    agents: agentsResource(t),
    squads: squadsResource(t),
    workflows: workflowsResource(t),
    workStreams: workStreamsResource(t),
    push: pushResource(t),
    notificationConfig: notificationConfigResource(t),
    userPreferences: userPreferencesResource(t),
    farmPreferences: farmPreferencesResource(t),
    farmChat: farmChatResource(t),
    themePresets: themePresetsResource(t),
    system: systemResource(t),
  }
}

export type FicusClient = ReturnType<typeof createClient>
