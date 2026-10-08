import { ToolRenderersContext } from '../lib/ToolRenderersContext'
import { SingleToolCallSection } from './MessageContent'
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { MessageMetadata } from '@ficus/shared'

const { AssistantMessageContent, HumanMessageContent } = await import('./MessageContent')

describe('HumanMessageContent', () => {
  const framedInbox = (subject: string, body: string) =>
    `You have 1 unread message(s) in your inbox. Process them and take any required action.

### Message m1

**From:** Nova (General Purpose Agent) [5f0eec16]

**Sent at:** 6/24/2026, 4:48:00 PM

**Subject:** ${subject}

${body}

**Mark one or more messages as read after processing:**
\`\`\`
ficus inbox read m1
\`\`\``

  test('renders an inbox delivery as subject + markdown body + View work stream, without the old Full prompt dropdown', () => {
    const metadata = {
      source: 'inbox',
      inboxDeliveryMode: 'steer',
      inboxMessageIds: ['m1'],
      inboxMessageSummaries: [
        {
          id: 'm1',
          senderType: 'agent',
          senderId: 'agent-1',
          subject: 'Launch',
          preview: 'Check this **bold** item',
          senderDisplay: 'Nova (General Purpose Agent) [5f0eec16]',
          workStreamId: 'ws-1',
          squadId: 'squad-1',
        },
      ],
    } satisfies MessageMetadata

    const html = renderToStaticMarkup(
      <HumanMessageContent content={framedInbox('Launch', 'Check this **bold** item')} metadata={metadata} />
    )

    expect(html).toContain('aria-label="Inbox message"')
    expect(html).toContain('Inbox message from Nova (General Purpose Agent) [5f0eec16]')
    expect(html).toContain('Launch')
    expect(html).toContain('Interrupt')
    // The body is the MESSAGE, rendered as markdown — not the agent-facing framing.
    expect(html).toContain('<strong>bold</strong>')
    expect(html).not.toContain('Mark one or more messages as read')
    expect(html).not.toContain('Full prompt')
    expect(html).toContain('View work stream')
    // Short body: no toggle.
    expect(html).not.toContain('Show more')
  })

  test('truncates a long inbox body behind Show more', () => {
    const longBody = `${'word '.repeat(120)}THE_TAIL_SHOULD_BE_HIDDEN`
    const metadata = {
      source: 'inbox',
      inboxMessageIds: ['m1'],
      inboxMessageSummaries: [
        { id: 'm1', senderType: 'agent', senderId: 'agent-1', subject: 'Long one', preview: 'word word' },
      ],
    } satisfies MessageMetadata

    const html = renderToStaticMarkup(
      <HumanMessageContent content={framedInbox('Long one', longBody)} metadata={metadata} />
    )
    expect(html).toContain('Show more')
    expect(html).not.toContain('THE_TAIL_SHOULD_BE_HIDDEN')
    expect(html).not.toContain('View work stream')
  })

  test('renders a monitor line batch as a compact row with expandable lines', () => {
    const metadata = {
      source: 'monitor',
      monitor: { id: 'abc12345-0000', label: 'build-watch', kind: 'lines', lineCount: 2 },
    } satisfies MessageMetadata

    const html = renderToStaticMarkup(
      <HumanMessageContent
        content={'Monitor "build-watch" (abc12345) — 2 new line(s):\n> FAIL a\n> FAIL b'}
        metadata={metadata}
      />
    )

    expect(html).toContain('aria-label="Monitor"')
    expect(html).toContain('Monitor &quot;build-watch&quot;')
    expect(html).toContain('2 new lines')
    expect(html).toContain('FAIL a')
    expect(html).not.toContain('bg-status-progress-600')
  })

  test('renders a monitor overload terminal event as a red row', () => {
    const metadata = {
      source: 'monitor',
      monitor: { id: 'abc12345-0000', label: 'log-tail', kind: 'overload', exitCode: null },
    } satisfies MessageMetadata

    const html = renderToStaticMarkup(
      <HumanMessageContent
        content={'Monitor "log-tail" (abc12345) stopped — output exceeded the limit (500+ lines dropped).'}
        metadata={metadata}
      />
    )

    expect(html).toContain('stopped — output exceeded the limit')
    expect(html).toContain('text-status-danger-700')
  })

  test('renders a monitor exited event with a non-zero exit code as an amber row', () => {
    const metadata = {
      source: 'monitor',
      monitor: { id: 'abc12345-0000', label: 'build-watch', kind: 'exited', exitCode: 2 },
    } satisfies MessageMetadata

    const html = renderToStaticMarkup(
      <HumanMessageContent content={'Monitor "build-watch" (abc12345) exited (exit_code=2).'} metadata={metadata} />
    )

    expect(html).toContain('exit_code=2')
    expect(html).toContain('text-status-attention-700')
    expect(html).toContain('✗')
  })
})

describe('agent file reference rendering', () => {
  const reference = '@/private/chat-attachments/6f7e72d8-1aa6-4cec-8d24-80c8ca80ef4d/report.pdf'

  test('renders exact references as authenticated file links', () => {
    const html = renderToStaticMarkup(<HumanMessageContent content={`Read ${reference}.`} agentId="agent-1" />)
    expect(html).toContain('/api/agents/agent-1/files/6f7e72d8-1aa6-4cec-8d24-80c8ca80ef4d')
    expect(html).toContain('data-agent-file-id="6f7e72d8-1aa6-4cec-8d24-80c8ca80ef4d"')
  })

  test('keeps the original reference in raw mode', () => {
    const html = renderToStaticMarkup(<HumanMessageContent content={reference} agentId="agent-1" showRaw />)
    expect(html).toContain(reference)
    expect(html).not.toContain('/api/agents/agent-1/files/')
  })
})

test('persisted tool rows use the active Assistant or editor renderer', () => {
  const html = renderToStaticMarkup(
    <ToolRenderersContext.Provider
      value={{ edit: { summary: () => 'Editor proposal', ArgsView: () => null, ResultView: () => null } }}
    >
      <SingleToolCallSection
        toolCall={{ toolCallId: 'edit-1', toolName: 'edit', args: '{}', result: '{}', isError: false }}
      />
    </ToolRenderersContext.Provider>
  )
  expect(html).toContain('Editor proposal')
})

describe('tool result firewall badge', () => {
  const fetched = (details: Record<string, unknown>) =>
    JSON.stringify({ content: [{ type: 'text', text: 'page' }], details: { url: 'https://evil.example', ...details } })
  const row = (result: string) =>
    renderToStaticMarkup(
      <SingleToolCallSection
        toolCall={{
          toolCallId: 'fetch-1',
          toolName: 'webfetch',
          args: '{"url":"https://evil.example"}',
          result,
          isError: false,
        }}
      />
    )

  test('a flagged tool result shows a warning badge with what was found', () => {
    const html = row(
      fetched({ firewall: { flagged: true, severity: 'high', instructsAgent: 0.94, intent: 'malicious' } })
    )
    expect(html).toContain('Possible injection')
    expect(html).toContain('bg-status-danger-badge-surface')
    expect(html).toContain('94% likely, intent: malicious')
  })

  test('a withheld result says the agent never saw it', () => {
    const html = row(
      fetched({
        firewall: { flagged: true, severity: 'high', instructsAgent: 0.94, intent: 'malicious', withheld: true },
      })
    )
    expect(html).toContain('Withheld: likely injection')
    expect(html).toContain('bg-status-danger-badge-surface')
    expect(html).toContain('so it was withheld from the agent.')
  })

  test('medium severity uses the attention color and says when only part was screened', () => {
    const html = row(fetched({ firewall: { flagged: true, severity: 'medium', instructsAgent: 0.6, partial: true } }))
    expect(html).toContain('bg-status-attention-badge-surface')
    expect(html).toContain('60% likely)')
    expect(html).toContain('Only part of it was screened.')
  })

  test('an unflagged or malformed result shows no badge', () => {
    expect(row(fetched({}))).not.toContain('Possible injection')
    expect(row(fetched({ firewall: { flagged: 'yes' } }))).not.toContain('Possible injection')
    expect(row('not json')).not.toContain('Possible injection')
  })

  test('a collapsed group of tool calls shows the badge too', () => {
    const toolBlock = (id: string, result: string) => ({
      type: 'tool_use' as const,
      id,
      toolCall: { toolCallId: id, toolName: 'webfetch', args: '{}', result, isError: false },
    })
    const metadata = {
      content: [
        toolBlock('a', fetched({})),
        toolBlock('b', fetched({ firewall: { flagged: true, severity: 'high', instructsAgent: 0.9 } })),
      ],
    } satisfies MessageMetadata
    const html = renderToStaticMarkup(<AssistantMessageContent content="" metadata={metadata} />)
    expect(html).toContain('2 tools')
    expect(html).toContain('Possible injection')
  })
})
