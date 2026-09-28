import { agentToolRenderers, siteAssistantToolRenderers } from '../lib/tool-renderers'
import { pageEditorToolRenderers } from '../components/pageEditorToolRenderers'
import { expect, test } from 'bun:test'
import { acquireDomHarness } from '../test/domHarness'
import { VoiceTranscriptInspector } from './VoiceTranscriptInspector'

test('editor tool arguments use their own renderer and failed edits keep full details expandable', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/' })
  const { root } = dom.createRoot()
  const issues = [{ code: 'invalid_literal', expected: 1, path: ['schemaVersion'], message: 'Expected 1' }]
  const history = [
    {
      role: 'tool' as const,
      text: '',
      final: true,
      toolName: 'edit',
      toolArgs: JSON.stringify({
        baseRevision: 3,
        summary: 'Build a marketing flow',
        documentJson: '{"name":"Marketing"}',
      }),
      toolResult: JSON.stringify({ error: `API error: 400: ${JSON.stringify(issues)}` }),
    },
  ]
  try {
    await dom.act(async () =>
      root.render(<VoiceTranscriptInspector history={history} toolRenderers={pageEditorToolRenderers} />)
    )
    expect(document.body.textContent).toContain('The edit could not be applied')
    expect(document.body.textContent).not.toContain('invalid_literal')
    expect(document.querySelector('[aria-label="Tool failed"]')).not.toBeNull()
    await dom.act(async () => (document.querySelector('button') as HTMLButtonElement).click())
    expect(document.body.textContent).toContain('baseRevision')
    expect(document.body.textContent).toContain('invalid_literal')
    expect(document.body.textContent).toContain('schemaVersion')
    expect(document.body.textContent).not.toContain('unknown')
    // Ordinary filesystem tools still render file paths.
    await dom.act(async () =>
      root.render(
        <VoiceTranscriptInspector
          history={[{ ...history[0], toolName: 'read', toolArgs: '{"path":"/tmp/example.ts"}', toolResult: 'content' }]}
          toolRenderers={agentToolRenderers}
          defaultToolExpanded
        />
      )
    )
    expect(document.body.textContent).toContain('/tmp/example.ts')
  } finally {
    await dom.cleanup()
  }
})

test('rendered tool entries keep a label: the summary or text when present, the raw name otherwise', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/' })
  const { root } = dom.createRoot()
  try {
    // (a) a rendered tool with toolArgs shows the summary, not the raw tool name.
    await dom.act(async () =>
      root.render(
        <VoiceTranscriptInspector
          history={[
            {
              role: 'tool' as const,
              text: '',
              final: true,
              toolName: 'delegate_task',
              toolArgs: JSON.stringify({ label: 'Check enabled schedules', request: 'x' }),
            },
          ]}
          toolRenderers={siteAssistantToolRenderers}
        />
      )
    )
    expect(document.body.textContent).toContain('Background task: Check enabled schedules')
    expect(document.body.textContent).not.toContain('delegate_task')

    // (b) an un-rendered tool still shows its raw name.
    await dom.act(async () =>
      root.render(
        <VoiceTranscriptInspector
          history={[{ role: 'tool' as const, text: '', final: true, toolName: 'get_work', toolArgs: '{}' }]}
          toolRenderers={siteAssistantToolRenderers}
        />
      )
    )
    expect(document.body.textContent).toContain('get_work')

    // (c) a rendered tool with no toolArgs but text keeps the text label, hides the raw name.
    await dom.act(async () =>
      root.render(
        <VoiceTranscriptInspector
          history={[{ role: 'tool' as const, text: 'Task update', final: true, toolName: 'assistant_inbox' }]}
          toolRenderers={siteAssistantToolRenderers}
        />
      )
    )
    expect(document.body.textContent).toContain('Task update')
    expect(document.body.textContent).not.toContain('assistant_inbox')

    // (d) a rendered tool with neither toolArgs nor text falls back to the raw name.
    await dom.act(async () =>
      root.render(
        <VoiceTranscriptInspector
          history={[{ role: 'tool' as const, text: '', final: true, toolName: 'search_ficus' }]}
          toolRenderers={siteAssistantToolRenderers}
        />
      )
    )
    expect(document.body.textContent).toContain('search_ficus')
  } finally {
    await dom.cleanup()
  }
})
