import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import {
  agentToolRenderers,
  siteAssistantToolRenderers,
  ToolArgsView,
  ToolResultView,
  ToolSummary,
} from './tool-renderers'
import { getToolInlineActions } from './tool-inline-actions'

function renderToolResult(toolName: string, result: string, isError = false, entry = '/') {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[entry]}>
      <ToolResultView renderers={agentToolRenderers} toolName={toolName} result={result} isError={isError} />
    </MemoryRouter>
  )
}

const block =
  '<!--ficus:memory-provenance [{"sourceSquadId":"squad-aaaa1111","path":"/memory/a.md","title":"A","sourceType":"memory_file","sensitivity":"internal","score":0.9,"documentId":"d1","url":"https://example.com/source"}] -->'

describe('memory_search renderer', () => {
  it('summary shows the query', () => {
    const html = renderToStaticMarkup(
      <ToolSummary renderers={agentToolRenderers} toolName="memory_search" args='{"query":"refund policy"}' />
    )
    expect(html).toContain('refund policy')
  })

  it('result view hides the raw provenance comment and lists sources', () => {
    const result = `Found 1 result(s):\n\n**1. /memory/a.md** — A\n${block}`
    const html = renderToStaticMarkup(
      <ToolResultView renderers={agentToolRenderers} toolName="memory_search" result={result} isError={false} />
    )
    expect(html).not.toContain('memory-provenance')
    expect(html).toContain('squad-aa')
    expect(html.toLowerCase()).toContain('internal')
    expect(html).toContain('href="https://example.com/source"')
    expect(html).toContain('Open source')
  })
})

describe('ask_human renderer', () => {
  it('uses the shared human-wait treatment for question and success states', () => {
    const args = renderToStaticMarkup(
      <ToolArgsView
        renderers={agentToolRenderers}
        toolName="ask_human"
        args='{"questions":[{"id":"q1","question":"Approve?"}]}'
      />
    )
    const result = renderToStaticMarkup(
      <ToolResultView renderers={agentToolRenderers} toolName="ask_human" result="Answer received" isError={false} />
    )
    expect(args).toContain('border-status-human-wait-border')
    expect(args).toContain('text-status-human-wait-fg')
    expect(result).toContain('text-status-human-wait-fg')
    expect(args).not.toContain('orange')
    expect(result).not.toContain('orange')
  })
})

describe('dispatch renderer', () => {
  it('summary shows the fan-out count', () => {
    const html = renderToStaticMarkup(
      <ToolSummary
        renderers={agentToolRenderers}
        toolName="dispatch"
        args='{"subagents":[{"instructions":"a","label":"Research"},{"instructions":"b","label":"Build"}]}'
      />
    )
    expect(html).toContain('2 subagents')
  })

  it('args view lists each child by label, falling back to a positional name', () => {
    const html = renderToStaticMarkup(
      <ToolArgsView
        renderers={agentToolRenderers}
        toolName="dispatch"
        args='{"subagents":[{"instructions":"do research","label":"Research"},{"instructions":"build ui"}]}'
      />
    )
    expect(html).toContain('Research')
    expect(html).toContain('subagent 2')
    expect(html).toContain('do research')
  })

  it('args identify default, explicit, and inherited model selection', () => {
    const html = renderToStaticMarkup(
      <ToolArgsView
        renderers={agentToolRenderers}
        toolName="dispatch"
        args={JSON.stringify({
          subagents: [
            { label: 'Default', instructions: 'a' },
            { label: 'Explicit', instructions: 'b', model: 'openai:gpt-5.3-codex' },
            { label: 'Inherited', instructions: 'c', inheritModel: true },
          ],
        })}
      />
    )

    expect(html).toContain('Standard tier (default)')
    expect(html).toContain('Explicit model')
    expect(html).toContain('openai:gpt-5.3-codex')
    expect(html).toContain('Inherited parent chain')
  })

  it('result view shows one queue-cyan pill per dispatched child with its label and id from production details', () => {
    const result = JSON.stringify({
      content: [{ type: 'text', text: 'Dispatched 1 subagent(s): Research (sa-1)' }],
      details: { subagents: [{ subagentId: 'sa-1', label: 'Research' }] },
    })
    const html = renderToolResult('dispatch', result)
    expect(html).toContain('Research')
    expect(html.toLowerCase()).toContain('queued')
    expect(html).toContain('sa-1')
    expect(html).toContain('subagent=sa-1')
    expect(html).toContain('bg-status-queue-surface')
  })

  it('result links preserve the selected parent agent query param', () => {
    const result = JSON.stringify({
      content: [{ type: 'text', text: 'Dispatched 1 subagent(s): Research (sa-1)' }],
      details: { subagents: [{ subagentId: 'sa-1', label: 'Research' }] },
    })
    const html = renderToolResult('dispatch', result, false, '/squads/squad-1?agent=parent-1&view=chat')

    expect(html).toContain('agent=parent-1')
    expect(html).toContain('view=subagents')
    expect(html).toContain('subagent=sa-1')
  })

  it('result view renders errors via the error code block', () => {
    const html = renderToStaticMarkup(
      <ToolResultView
        renderers={agentToolRenderers}
        toolName="dispatch"
        result="2 slots free, requested 5"
        isError={true}
      />
    )
    expect(html).toContain('2 slots free, requested 5')
  })
})

describe('check_subagents renderer', () => {
  it('summary is a read-only label', () => {
    const html = renderToStaticMarkup(
      <ToolSummary renderers={agentToolRenderers} toolName="check_subagents" args="{}" />
    )
    expect(html.toLowerCase()).toContain('check')
  })

  it('result view shows a status pill per child (running, done, failed) from production details', () => {
    const result = JSON.stringify({
      content: [{ type: 'text', text: 'Found 3 subagent(s)' }],
      details: {
        subagents: [
          { subagentId: 'sa-1', label: 'Research', status: 'running', lastActivityAt: null, resultStatus: null },
          {
            subagentId: 'sa-2',
            label: 'Build',
            status: 'terminated',
            lastActivityAt: null,
            resultStatus: 'completed',
          },
          { subagentId: 'sa-3', label: 'Lint', status: 'terminated', lastActivityAt: null, resultStatus: 'failed' },
        ],
      },
    })
    const html = renderToolResult('check_subagents', result)
    expect(html).toContain('Research')
    expect(html.toLowerCase()).toContain('running')
    expect(html.toLowerCase()).toContain('done')
    expect(html.toLowerCase()).toContain('failed')
    expect(html).toContain('subagent=sa-1')
  })

  it('uses the shared neutral treatment for stopped children', () => {
    const result = JSON.stringify({
      content: [{ type: 'text', text: 'Found 1 subagent' }],
      details: {
        subagents: [
          { subagentId: 'sa-1', label: 'Stopped', status: 'terminated', lastActivityAt: null, resultStatus: 'stopped' },
        ],
      },
    })
    const html = renderToolResult('check_subagents', result)
    expect(html).toContain('bg-status-neutral-surface')
    expect(html).not.toContain('yellow')
  })

  it('result view handles no children', () => {
    const result = JSON.stringify({ content: [{ type: 'text', text: 'No subagents' }], details: { subagents: [] } })
    const html = renderToolResult('check_subagents', result)
    expect(html.toLowerCase()).toContain('no subagents')
  })
})

describe('stop_subagent renderer', () => {
  it('summary shows the target id', () => {
    const html = renderToStaticMarkup(
      <ToolSummary renderers={agentToolRenderers} toolName="stop_subagent" args='{"subagentId":"sa-9"}' />
    )
    expect(html).toContain('sa-9')
  })

  it('result view reflects stopped vs already-terminated from production details', () => {
    const stopped = JSON.stringify({
      content: [{ type: 'text', text: 'Stopped subagent sa-9' }],
      details: { status: 'stopped' },
    })
    const already = JSON.stringify({
      content: [{ type: 'text', text: 'Subagent already terminated' }],
      details: { status: 'already-terminated' },
    })
    const stoppedHtml = renderToStaticMarkup(
      <ToolResultView renderers={agentToolRenderers} toolName="stop_subagent" result={stopped} isError={false} />
    )
    expect(stoppedHtml).toContain('Stopped')
    expect(stoppedHtml).toContain('text-status-neutral-fg')
    expect(stoppedHtml).not.toContain('yellow')
    expect(
      renderToStaticMarkup(
        <ToolResultView renderers={agentToolRenderers} toolName="stop_subagent" result={already} isError={false} />
      )
    ).toContain('Already terminated')
  })
})

describe('tool inline actions', () => {
  const call = (overrides: Record<string, unknown> = {}) => ({
    toolCallId: 'tc-1',
    toolName: 'monitor',
    args: '{"action":"create"}',
    result: JSON.stringify({ details: { success: true, monitorId: 'monitor-1' } }),
    isError: false,
    ...overrides,
  })

  it('extracts a completed monitor create action', () => {
    expect(getToolInlineActions({ toolCall: call(), completed: true })).toEqual([
      { kind: 'monitor', key: 'monitor:monitor-1', monitorId: 'monitor-1', label: 'Open monitor' },
    ])
  })

  it('extracts valid unique dispatch children in order with label fallbacks', () => {
    const toolCall = call({
      toolName: 'dispatch',
      args: '{}',
      result: JSON.stringify({
        details: {
          subagents: [
            { subagentId: 'child-1', label: 'Research' },
            { subagentId: 'child-2', label: '  ' },
            { subagentId: 'child-1', label: 'Duplicate' },
            { subagentId: '', label: 'Bad' },
            null,
          ],
        },
      }),
    })
    expect(getToolInlineActions({ toolCall, completed: true })).toEqual([
      { kind: 'subagent', key: 'subagent:child-1', subagentId: 'child-1', label: 'Research' },
      { kind: 'subagent', key: 'subagent:child-2', subagentId: 'child-2', label: 'child-2' },
    ])
  })

  it('suppresses incomplete, failed, malformed, and invalid monitor actions', () => {
    expect(getToolInlineActions({ toolCall: call(), completed: false })).toEqual([])
    expect(getToolInlineActions({ toolCall: call({ isError: true }), completed: true })).toEqual([])
    expect(getToolInlineActions({ toolCall: call({ args: 'bad' }), completed: true })).toEqual([])
    expect(getToolInlineActions({ toolCall: call({ result: 'bad' }), completed: true })).toEqual([])
    expect(getToolInlineActions({ toolCall: call({ args: '{"action":"list"}' }), completed: true })).toEqual([])
    expect(
      getToolInlineActions({
        toolCall: call({ result: JSON.stringify({ details: { monitorId: ' ' } }) }),
        completed: true,
      })
    ).toEqual([])
    expect(
      getToolInlineActions({
        toolCall: call({ result: JSON.stringify({ details: { success: false, monitorId: 'm' } }) }),
        completed: true,
      })
    ).toEqual([])
  })
})

describe('site assistant task renderers', () => {
  it('delegate_task summarizes by label and shows the request, not the tool name', () => {
    const args = JSON.stringify({ label: 'Check enabled schedules', request: 'Which schedules are enabled?' })
    expect(
      renderToStaticMarkup(<ToolSummary renderers={siteAssistantToolRenderers} toolName="delegate_task" args={args} />)
    ).toContain('Background task: Check enabled schedules')
    const html = renderToStaticMarkup(
      <ToolArgsView renderers={siteAssistantToolRenderers} toolName="delegate_task" args={args} />
    )
    expect(html).toContain('Which schedules are enabled?')
    expect(html).not.toContain('delegate_task')
  })

  it('delegate_task with a squad names the squad from the receipt', () => {
    const args = JSON.stringify({ label: 'Pause deploy stream', request: 'Pause it', squadId: 'tau' })
    const result = JSON.stringify({
      id: 'm',
      agentId: 'a',
      delivered: true,
      kind: 'squad',
      squadId: 'tau',
      conversation: { agentId: 'a', label: 'Pause deploy stream', kind: 'squad' },
    })
    expect(
      renderToStaticMarkup(
        <ToolResultView
          renderers={siteAssistantToolRenderers}
          toolName="delegate_task"
          result={result}
          isError={false}
        />
      )
    ).toContain('Running in the background')
    expect(
      renderToStaticMarkup(<ToolSummary renderers={siteAssistantToolRenderers} toolName="delegate_task" args={args} />)
    ).toContain('Background task: Pause deploy stream')
  })

  it('assistant_inbox renders as a task update with the content only', () => {
    const result = JSON.stringify({
      id: 'u',
      senderId: 'a',
      senderName: 'Assistant task',
      content: 'Three schedules are enabled.',
      subject: null,
      replyTo: 'm',
      createdAt: '2026-01-01',
    })
    const html = renderToStaticMarkup(
      <ToolResultView
        renderers={siteAssistantToolRenderers}
        toolName="assistant_inbox"
        result={result}
        isError={false}
      />
    )
    expect(html).toContain('Three schedules are enabled.')
    expect(html).not.toContain('senderName')
    expect(
      renderToStaticMarkup(<ToolSummary renderers={siteAssistantToolRenderers} toolName="assistant_inbox" args="{}" />)
    ).toContain('Task update')
  })

  it('search_tau summarizes the query', () => {
    expect(
      renderToStaticMarkup(
        <ToolSummary renderers={siteAssistantToolRenderers} toolName="search_tau" args='{"query":"schedules"}' />
      )
    ).toContain('Searched Ficus for “schedules”')
  })
})
