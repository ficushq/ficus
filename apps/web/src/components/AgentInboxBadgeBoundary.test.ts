import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const componentSource = (relativePath: string) => readFileSync(join(import.meta.dir, relativePath), 'utf8')

const chatPageSource = componentSource('ChatPage.tsx')
const threadsSource = componentSource('squads/SquadAgentThreads.tsx')
const visualizationSource = componentSource('squads/AgentVisualization.tsx')
const inboxPanelSource = componentSource('squads/AgentInboxPanel.tsx')
const viewTabsSource = componentSource('AgentViewTabs.tsx')
const appNavSource = componentSource('AppNav.tsx')
const appSource = componentSource('../App.tsx')
const queryOptionsSource = componentSource('../queryOptions.ts')
const invalidationSource = componentSource('../hooks/useAgentInboxInvalidation.ts')

describe('agent inbox badge boundary', () => {
  test('agent chat surfaces do not query or render unread counts', () => {
    expect(chatPageSource).not.toContain('queries.inbox.unreadCount')
    expect(chatPageSource).not.toMatch(/value: 'inbox',[\s\S]{0,120}badgeCount/)

    expect(threadsSource).not.toContain('queries.inbox.unreadCount')
    expect(threadsSource).not.toContain('unreadCounts')
    expect(threadsSource).not.toContain('useAgentInboxInvalidationHook')
  })

  test('agent graph nodes do not subscribe, query, or carry unread presentation data', () => {
    expect(visualizationSource).not.toContain('useAgentInboxInvalidation')
    expect(visualizationSource).not.toContain('queries.inbox.unreadCount')
    expect(visualizationSource).not.toContain('unreadCount')
  })

  test('shared agent tabs retain active indicators without an unread badge API', () => {
    expect(viewTabsSource).not.toContain('badgeCount')
    expect(viewTabsSource).toContain('activeCount')
  })

  test('an open agent inbox still subscribes to message content without an unread-count path', () => {
    expect(inboxPanelSource).toContain('useAgentInboxInvalidation(agentIds, { includeMessages: true })')
    expect(inboxPanelSource).toContain('queries.inbox.messages(agent.id, true)')
    expect(invalidationSource).toContain('queryKeys.inbox.messagesPrefix(agentId)')
    expect(queryOptionsSource).not.toContain('unreadCount: (agentId: string)')
    expect(invalidationSource).not.toContain('queryKeys.inbox.unreadCount')
  })

  test('personal and system inbox navigation counts and popup remain intact', () => {
    expect(appNavSource).toContain('queries.inbox.mineCount()')
    expect(appNavSource).toContain('queries.inbox.systemCount()')
    expect(appNavSource).toContain('showInboxBadge')
    // The nav's Inbox button drives the popup through the shared provider (hover opens, a click toggles or pins).
    expect(appNavSource).toContain('{...inboxPopup.hover.triggerProps}')
    expect(appSource).toContain("import { InboxPopup } from './components/InboxPopup'")
    expect(appSource).toContain('<InboxPopupProvider>')
    expect(appSource).toContain('<InboxPopup />')
  })
})
