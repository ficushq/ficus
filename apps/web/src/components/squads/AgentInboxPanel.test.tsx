import { expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Agent } from '@ficus/shared'
import { queries } from '../../queryOptions'
import { WebSocketProvider } from '../../providers/WebSocketProvider'
import { AgentInboxPanel } from './AgentInboxPanel'

test('inbox badge uses a flat participant name and retains remote and voice fallbacks', () => {
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false } } })
  const base = {
    recipientType: 'agent',
    recipientId: 'recipient',
    content: 'Exact content',
    createdAt: new Date().toISOString(),
    readAt: null,
  }
  client.setQueryData(queries.inbox.messages('recipient', true).queryKey, [
    {
      ...base,
      id: 'm1',
      senderType: 'agent',
      senderId: 'agent-123456789',
      metadata: {},
      senderAgent: {
        id: 'agent-123456789',
        name: 'Summary Name',
        agentTypeId: 'engineer',
        squadId: null,
        ownerUserId: null,
      },
    },
    {
      ...base,
      id: 'm2',
      senderType: 'remote',
      senderId: 'remote-id',
      metadata: { sender: { name: 'Remote Peer' } },
      senderAgent: null,
    },
    {
      ...base,
      id: 'm3',
      senderType: 'voice_assistant',
      senderId: 'workspace:synthetic-user',
      metadata: {},
      senderAgent: null,
    },
  ])
  try {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <WebSocketProvider>
          <AgentInboxPanel
            agent={{ id: 'recipient', metadata: { name: 'Recipient' }, agentTypeId: 'manager' } as Agent}
            onClose={() => {}}
          />
        </WebSocketProvider>
      </QueryClientProvider>
    )
    expect(html).toContain('Summary Name [agent-12]')
    expect(html).toContain('Remote Peer [remote-i]')
    expect(html).toContain('Voice Workspace Agent (voice_assistant) [workspace:synthetic-user]')
  } finally {
    client.clear()
  }
})
