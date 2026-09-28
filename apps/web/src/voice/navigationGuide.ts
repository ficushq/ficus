import { visibleNavItems } from '../components/navModel'
import { ALL_SECTIONS } from '../components/settings/settingsSections'
import { PRIMARY_SQUAD_TABS, SQUAD_TABS, SQUAD_SETTINGS_SECTIONS } from '../lib/squadNavigation'

/** Derived from the same definitions that render navigation; never scrape screen copy. */
export function buildVoiceNavigationGuide(): string {
  return [
    '## Navigation',
    'Use navigate with an app-relative path. Only navigate when the destination differs from the current screen.',
    ...visibleNavItems.map((item) => `- ${item.label}: ${item.to}`),
    'Squad primary tabs:',
    ...SQUAD_TABS.filter((tab) => PRIMARY_SQUAD_TABS.has(tab.path)).map(
      (tab) => `- ${tab.label}: /squads/:squadId/${tab.path}`
    ),
    'Squad More menu:',
    ...SQUAD_TABS.filter((tab) => !PRIMARY_SQUAD_TABS.has(tab.path)).map(
      (tab) => `- ${tab.label}: /squads/:squadId/${tab.path}`
    ),
    'The bare /squads/:squadId route also opens Home. Chats is labeled Chats but its route segment is agents, not chats. Use path segments, not legacy ?tab= links.',
    'Open a squad agent conversation: /squads/:squadId/agents?agent=:agentId. Open a work stream: /squads/:squadId/work?ws=:workStreamId.',
    'Squad settings sections (runtime-dependent sections may be hidden):',
    ...SQUAD_SETTINGS_SECTIONS.map((section) => `- ${section.label}: /squads/:squadId/settings?section=${section.id}`),
    "App settings sections (subject to the user's permissions and enabled features):",
    ...ALL_SECTIONS.map((section) => `- ${section.label}: /settings?section=${section.id} — ${section.description}`),
    'The navigation map describes destinations, not live values. search_ficus locates entities and pages only; get_work, read_thread, read_inbox, and read_activity read live state; delegate_task reads or changes anything else. Never claim to see unsupplied fields or settings values.',
    'Assistant is one saved conversation for typed messages and live voice, opened with the sparkles button or Cmd/Ctrl+K. The microphone toggles live voice.',
    'To open a saved Assistant conversation, preserve the current pathname and add ?chat=open&assistantConversation=:conversationId (merge with existing query parameters). Legacy system-manager and standalone agent threads use /chat/:agentId.',
    'Replace placeholders with the full IDs provided in session context or tool results. Do not invent IDs or settings sections. Home shows a coordinator row, not an open manager conversation.',
  ].join('\n')
}
