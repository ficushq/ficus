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
import { getBlocksInlineActions, getToolInlineActions, normalizeMemoryNotePath } from './tool-inline-actions'

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

describe('write renderer', () => {
  it('renders long content in full inside the scroll box without truncation', () => {
    const content = `${'a'.repeat(600)}END_OF_CONTENT`
    const html = renderToStaticMarkup(
      <ToolArgsView
        renderers={agentToolRenderers}
        toolName="write"
        args={JSON.stringify({ path: '/tmp/long.txt', content })}
      />
    )
    expect(html).toContain(content)
    expect(html).not.toContain(`${'a'.repeat(500)}...`)
    expect(html).toContain('max-h-24 overflow-y-auto')
    expect(html).toContain('data-follow-scroll')
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
      { kind: 'monitor', key: 'monitor:monitor-1', label: 'Open monitor', monitorId: 'monitor-1' },
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
      {
        kind: 'subagent',
        key: 'subagent:child-1',
        label: 'Open Research chat',
        subagentId: 'child-1',
        subagentLabel: 'Research',
      },
      {
        kind: 'subagent',
        key: 'subagent:child-2',
        label: 'Open child-2 chat',
        subagentId: 'child-2',
        subagentLabel: 'child-2',
      },
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

describe('new tool inline action kinds', () => {
  const SQUAD = '4ea8b934-a90a-42d1-b6fe-483a2ab9a18b'
  const OTHER_SQUAD = '0b6f1a52-3e2d-4f6a-9c1b-2a7d8e9f0a1b'
  const call = (toolName: string, args: unknown, details: unknown, overrides: Record<string, unknown> = {}) => ({
    toolCallId: `tc-${toolName}`,
    toolName,
    args: JSON.stringify(args),
    result: JSON.stringify(details === undefined ? { content: [] } : { details }),
    isError: false,
    ...overrides,
  })
  const actions = (toolCall: ReturnType<typeof call>, completed = true) => getToolInlineActions({ toolCall, completed })
  const failureCases = (toolCall: ReturnType<typeof call>) => [
    actions(toolCall, false),
    actions({ ...toolCall, isError: true }),
    actions({ ...toolCall, result: undefined }),
    actions({ ...toolCall, result: 'not json' }),
  ]

  it('ask_human offers its question, needing the chat’s agent', () => {
    const toolCall = call('ask_human', { questions: [] }, { questionId: 'q-1', async: true, blocking: true })
    expect(actions(toolCall)).toEqual([
      { kind: 'question', key: 'question:q-1', label: 'View question', questionId: 'q-1', access: { needs: 'agent' } },
    ])
    for (const result of failureCases(toolCall)) expect(result).toEqual([])
    expect(actions(call('ask_human', {}, { error: 'No recipients' }))).toEqual([])
    expect(actions(call('ask_human', {}, { questionId: ' ' }))).toEqual([])
  })

  it('notify_contact offers the work stream it routed to', () => {
    const toolCall = call('notify_contact', { title: 't' }, { success: true, routedTo: 'owner', workStreamId: 'ws-1' })
    expect(actions(toolCall)).toEqual([
      {
        kind: 'work_stream',
        key: 'work_stream:ws-1',
        label: 'Open work stream',
        workStreamRef: 'ws-1',
        access: { permission: 'workstreams:read' },
      },
    ])
    for (const result of failureCases(toolCall)) expect(result).toEqual([])
    expect(actions(call('notify_contact', {}, { success: true, routedTo: 'manager' }))).toEqual([])
    expect(actions(call('notify_contact', {}, { success: false, workStreamId: 'ws-1' }))).toEqual([])
  })

  it('artifact_publish offers the artifact, by its id or its manifest’s', () => {
    const toolCall = call(
      'artifact_publish',
      { artifactId: 'deck' },
      { success: true, artifactId: 'deck', manifest: { id: 'deck', title: 'Q3 deck' } }
    )
    const access = { permission: 'artifacts:read', needs: 'agent' }
    expect(actions(toolCall)).toEqual([
      { kind: 'artifact', key: 'artifact:deck', label: 'Open artifact', artifactId: 'deck', title: 'Q3 deck', access },
    ])
    expect(actions(call('artifact_publish', {}, { success: true, manifest: { id: 'notes' } }))).toEqual([
      { kind: 'artifact', key: 'artifact:notes', label: 'Open artifact', artifactId: 'notes', access },
    ])
    for (const result of failureCases(toolCall)) expect(result).toEqual([])
    expect(actions(call('artifact_publish', {}, { success: false, artifactId: 'deck', errors: ['x'] }))).toEqual([])
    expect(actions(call('artifact_publish', {}, { success: true }))).toEqual([])
  })

  it('browser_open offers a local app it opened, not a plain URL', () => {
    const toolCall = call('browser_open', { localDeploymentId: 'ld-1' }, undefined)
    const expected = [
      {
        kind: 'local_app',
        key: 'local_app:ld-1',
        label: 'Open app',
        localDeploymentId: 'ld-1',
        access: { permission: 'deployments:read' },
      },
    ]
    expect(actions(toolCall)).toEqual(expected)
    expect(actions(call('browser_open', { localDeploymentId: 'ld-1' }, {}))).toEqual(expected)
    for (const result of failureCases(toolCall)) expect(result).toEqual([])
    expect(
      actions(call('browser_open', { localDeploymentId: 'ld-1' }, { error: 'Local deployment unavailable' }))
    ).toEqual([])
    expect(actions(call('browser_open', { url: 'https://example.com' }, {}))).toEqual([])
  })

  it('memory writes offer the note in the memory viewer’s form, with the target squad for cross-squad writes', () => {
    const note = (path: string, squadId?: string) => ({
      kind: 'memory_note',
      key: `memory_note:${squadId ?? ''}:${path}`,
      label: 'Open note',
      path,
      ...(squadId ? { squadId } : {}),
      access: { permission: 'memory:read', needs: 'squad', ...(squadId ? { squadId } : {}) },
    })
    expect(actions(call('memory_write', { path: 'decisions/auth.md', content: 'x' }, { success: true }))).toEqual([
      note('/memory/decisions/auth.md'),
    ])
    expect(
      actions(
        call(
          'memory_patch',
          { path: '/home/box_1/memory/patterns/a.md', match: 'a', replacement: 'b' },
          { success: true }
        )
      )
    ).toEqual([note('/memory/patterns/a.md')])
    expect(
      actions(
        call(
          'memory_append',
          { path: `/memory/${SQUAD}/work-log/x.md`, content: 'x', targetSquadId: OTHER_SQUAD },
          { success: true, targetSquadId: OTHER_SQUAD }
        )
      )
    ).toEqual([note('/memory/work-log/x.md', OTHER_SQUAD)])
    expect(actions(call('memory_write', { path: 'a.md', content: 'x', squad: SQUAD }, { success: true }))).toEqual([
      note('/memory/a.md', SQUAD),
    ])
    // Core's resolved path stands in when the args lack one.
    expect(actions(call('memory_write', { content: 'x' }, { success: true, path: '/home/box_1/memory/b.md' }))).toEqual(
      [note('/memory/b.md')]
    )
  })

  it('memory writes offer nothing for deletes, failures, or unusable paths', () => {
    const write = call('memory_write', { path: 'a.md', content: 'x' }, { success: true })
    for (const result of failureCases(write)) expect(result).toEqual([])
    expect(actions(call('memory_write', { path: 'a.md', content: null }, { success: true, deleted: true }))).toEqual([])
    expect(actions(call('memory_write', { path: 'a.md', content: null }, { success: true }))).toEqual([])
    expect(
      actions(call('memory_write', { path: 'a.md', content: 'x' }, { error: { code: 'E', message: 'm' } }))
    ).toEqual([])
    expect(actions(call('memory_write', { path: '/etc/passwd', content: 'x' }, { success: true }))).toEqual([])
    expect(actions(call('memory_write', { path: '../a.md', content: 'x' }, { success: true }))).toEqual([])
  })

  it('normalizes memory paths from either root and rejects escapes', () => {
    expect(normalizeMemoryNotePath('decisions/auth.md')).toBe('/memory/decisions/auth.md')
    expect(normalizeMemoryNotePath('./decisions//auth.md')).toBe('/memory/decisions/auth.md')
    expect(normalizeMemoryNotePath(`/memory/${SQUAD}/decisions/auth.md`)).toBe('/memory/decisions/auth.md')
    expect(normalizeMemoryNotePath('/home/box_e49af02f8b45/memory/decisions/auth.md')).toBe('/memory/decisions/auth.md')
    expect(normalizeMemoryNotePath('/memory/decisions/auth.md')).toBe('/memory/decisions/auth.md')
    expect(normalizeMemoryNotePath('/home/box/memory/')).toBeNull()
    expect(normalizeMemoryNotePath('/workspace/docs/a.md')).toBeNull()
    expect(normalizeMemoryNotePath('notes/../../secret')).toBeNull()
    expect(normalizeMemoryNotePath('  ')).toBeNull()
  })

  it('shell calls offer the PRs and work streams Core recognized, each once', () => {
    const toolCall = call(
      'squad_bash',
      { command: 'ficus ws create -t x && gh pr create --fill' },
      {
        createdLinks: [
          { kind: 'work_stream', number: 829 },
          { kind: 'pull_request', url: 'https://github.com/ficushq/ficus/pull/684', number: 684 },
          { kind: 'pull_request', url: 'https://github.com/ficushq/ficus/pull/684', number: 684 },
          { kind: 'work_stream', id: 'ws-uuid' },
          { kind: 'pull_request', url: 'javascript:alert(1)//pull/1', number: 1 },
          { kind: 'pull_request', url: 'https://github.com/ficushq/ficus/pull/9' },
          { kind: 'work_stream' },
          { kind: 'issue', url: 'https://github.com/ficushq/ficus/issues/3', number: 3 },
          null,
        ],
      }
    )
    const workStreamAccess = { permission: 'workstreams:read' }
    expect(actions(toolCall)).toEqual([
      {
        kind: 'work_stream',
        key: 'work_stream:829',
        label: 'Open work stream #829',
        workStreamRef: '829',
        access: workStreamAccess,
      },
      {
        kind: 'pull_request',
        key: 'pull_request:https://github.com/ficushq/ficus/pull/684',
        label: 'Open PR #684',
        url: 'https://github.com/ficushq/ficus/pull/684',
        number: 684,
      },
      {
        kind: 'work_stream',
        key: 'work_stream:ws-uuid',
        label: 'Open work stream',
        workStreamRef: 'ws-uuid',
        access: workStreamAccess,
      },
    ])
    expect(actions({ ...toolCall, toolName: 'bash' })).toHaveLength(3)
    for (const result of failureCases(toolCall)) expect(result).toEqual([])
    // Without Core's structured links, a PR URL in the output is not an action.
    expect(
      actions(
        call(
          'bash',
          { command: 'gh pr view 684' },
          {},
          {
            result: JSON.stringify({ content: [{ type: 'text', text: 'https://github.com/ficushq/ficus/pull/684' }] }),
          }
        )
      )
    ).toEqual([])
  })

  it('a collapsed group lists every new kind once each, in call order', () => {
    const tool = (toolCall: ReturnType<typeof call>) => ({ type: 'tool_use', id: toolCall.toolCallId, toolCall })
    const memory = call('memory_write', { path: 'a.md', content: 'x' }, { success: true })
    const blocks = [
      tool(call('ask_human', {}, { questionId: 'q-1' })),
      tool(memory),
      tool({ ...memory, toolCallId: 'tc-memory-again', toolName: 'memory_append' }),
      tool(call('notify_contact', {}, { success: true, workStreamId: 'ws-1' })),
      tool(
        call(
          'squad_bash',
          {},
          { createdLinks: [{ kind: 'pull_request', url: 'https://github.com/o/r/pull/5', number: 5 }] }
        )
      ),
    ]
    expect(getBlocksInlineActions(blocks).map((action) => action.label)).toEqual([
      'View question',
      'Open note',
      'Open work stream',
      'Open PR #5',
    ])
  })
})

describe('group inline actions', () => {
  const monitor = (id: string, monitorId: string, overrides: Record<string, unknown> = {}) => ({
    toolCallId: id,
    toolName: 'monitor',
    args: '{"action":"create"}',
    result: JSON.stringify({ details: { success: true, monitorId } }),
    isError: false,
    ...overrides,
  })
  const dispatch = (id: string, children: Array<{ subagentId: string; label: string }>) => ({
    toolCallId: id,
    toolName: 'dispatch',
    args: '{}',
    result: JSON.stringify({ details: { subagents: children } }),
    isError: false,
  })
  const tool = (toolCall: ReturnType<typeof monitor>, extra: { _done?: boolean } = {}) => ({
    type: 'tool_use',
    id: toolCall.toolCallId,
    toolCall,
    ...extra,
  })
  const keys = (actions: Array<{ key: string }>) => actions.map((action) => action.key)

  it('collects every completed call’s actions in call order, each target once', () => {
    const blocks = [
      { type: 'thinking', id: 'th', content: 'plan' },
      tool(monitor('m1', 'monitor-1')),
      tool(
        dispatch('d1', [
          { subagentId: 'child-1', label: 'Research' },
          { subagentId: 'child-2', label: 'Build' },
        ])
      ),
      tool(monitor('m1-again', 'monitor-1')),
      tool(
        dispatch('d2', [
          { subagentId: 'child-2', label: 'Build again' },
          { subagentId: 'child-3', label: 'Review' },
        ])
      ),
      { type: 'tool_use', id: 'read', toolCall: { ...monitor('r', 'x'), toolName: 'read' } },
    ]
    const actions = getBlocksInlineActions(blocks)
    expect(keys(actions)).toEqual(['monitor:monitor-1', 'subagent:child-1', 'subagent:child-2', 'subagent:child-3'])
    // The first call to offer a target wins, so its label is the one shown.
    expect(actions.map((action) => action.label)).toEqual([
      'Open monitor',
      'Open Research chat',
      'Open Build chat',
      'Open Review chat',
    ])
  })

  it('leaves out errored and unfinished calls', () => {
    const saved = [
      tool(monitor('err', 'monitor-err', { isError: true })),
      tool(monitor('running', 'monitor-running', { result: undefined })),
      tool(monitor('ok', 'monitor-ok')),
    ]
    expect(keys(getBlocksInlineActions(saved))).toEqual(['monitor:monitor-ok'])
    expect(getBlocksInlineActions([])).toEqual([])
  })

  it('counts a live call as completed only once it is marked done', () => {
    const blocks = [
      tool(monitor('done', 'monitor-done'), { _done: true }),
      tool(monitor('streaming', 'monitor-streaming'), { _done: false }),
      tool(monitor('unmarked', 'monitor-unmarked')),
    ]
    expect(keys(getBlocksInlineActions(blocks, { live: true }))).toEqual(['monitor:monitor-done'])
  })
})

describe('site assistant task renderers', () => {
  it('delegate_task summarizes by label alone and shows the request, not the tool name', () => {
    const args = JSON.stringify({ label: 'Check enabled schedules', request: 'Which schedules are enabled?' })
    // The row already names the tool, so the summary is just the task name with no "Background task:" prefix.
    expect(
      renderToStaticMarkup(<ToolSummary renderers={siteAssistantToolRenderers} toolName="delegate_task" args={args} />)
    ).toContain('>Check enabled schedules<')
    const html = renderToStaticMarkup(
      <ToolArgsView renderers={siteAssistantToolRenderers} toolName="delegate_task" args={args} />
    )
    expect(html).toContain('Which schedules are enabled?')
    expect(html).not.toContain('delegate_task')
  })

  it('delegate_task without a label names the task by the first line of its request', () => {
    const summary = (args: object) =>
      renderToStaticMarkup(
        <ToolSummary renderers={siteAssistantToolRenderers} toolName="delegate_task" args={JSON.stringify(args)} />
      )
    expect(summary({ request: '\n  Check which schedules are enabled  \nThen pause the nightly one.' })).toContain(
      '>Check which schedules are enabled<'
    )
    expect(summary({ label: '   ', request: 'Rotate the deploy key' })).toContain('Rotate the deploy key')
    const long = 'Investigate why the nightly deploy keeps failing on the staging cluster since Tuesday'
    expect(summary({ request: `${long}\nmore detail` })).toContain(`${long.slice(0, 60)}...`)
  })

  it('delegate_task with neither label nor request reads as a generic background task', () => {
    const summary = (args: object) =>
      renderToStaticMarkup(
        <ToolSummary renderers={siteAssistantToolRenderers} toolName="delegate_task" args={JSON.stringify(args)} />
      )
    for (const args of [{}, { request: '  \n ' }]) {
      const html = summary(args)
      expect(html).toContain('>Background task<')
      expect(html).not.toContain('background task')
    }
  })

  it('delegate_task with a squad names the squad from the receipt', () => {
    const args = JSON.stringify({ label: 'Pause deploy stream', request: 'Pause it', squadId: 'ficus' })
    const result = JSON.stringify({
      id: 'm',
      agentId: 'a',
      delivered: true,
      kind: 'squad',
      squadId: 'ficus',
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
    ).toContain('Pause deploy stream')
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

  it('search_ficus summarizes the query', () => {
    expect(
      renderToStaticMarkup(
        <ToolSummary renderers={siteAssistantToolRenderers} toolName="search_ficus" args='{"query":"schedules"}' />
      )
    ).toContain('Searched Ficus for “schedules”')
  })
})
