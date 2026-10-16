import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { acquireDomHarness } from '../test/domHarness'
import {
  agentToolRenderers,
  siteAssistantToolRenderers,
  ToolArgsView,
  ToolSummary,
  type ToolRenderers,
} from './tool-renderers'

function argsHtml(toolName: string, args: string, follow: boolean, renderers: ToolRenderers = agentToolRenderers) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <ToolArgsView renderers={renderers} toolName={toolName} args={args} follow={follow} />
    </MemoryRouter>
  )
}

function summaryHtml(toolName: string, args: string, inProgress: boolean, renderers = agentToolRenderers) {
  return renderToStaticMarkup(
    <ToolSummary renderers={renderers} toolName={toolName} args={args} inProgress={inProgress} />
  )
}

/** The markup of the raw-JSON fallback for these args. */
function rawFallback(args: string) {
  return renderToStaticMarkup(<pre>{args}</pre>).slice('<pre>'.length, -'</pre>'.length)
}

let consoleError: ReturnType<typeof spyOn>
beforeEach(() => {
  consoleError = spyOn(console, 'error')
})
afterEach(() => {
  // No React key or prop warnings while rendering any partial shape.
  expect(consoleError).not.toHaveBeenCalled()
  consoleError.mockRestore()
})

describe('streaming bash args', () => {
  const partial = '{"command":"cd /repo && echo \\"hi\\"\\nls -la'

  it('shows a partial command with real newlines and quotes', () => {
    const html = argsHtml('bash', partial, true)
    expect(html).toContain('cd /repo &amp;&amp; echo &quot;hi&quot;\nls -la')
    expect(html).not.toContain('\\n')
    expect(html).not.toContain('\\&quot;')
    expect(argsHtml('squad_bash', partial, true)).toContain('echo &quot;hi&quot;\nls -la')
  })

  it('fills in the header summary while streaming', () => {
    expect(summaryHtml('bash', partial, true)).toContain('cd /repo &amp;&amp; echo')
    expect(summaryHtml('squad_bash', partial, true)).toContain('cd /repo &amp;&amp; echo')
    // A finished call with incomplete JSON keeps today's behavior: no summary.
    expect(summaryHtml('bash', partial, false)).toBe('')
  })

  it('drops an escape sequence cut off at the end of the chunk', () => {
    for (const args of ['{"command":"ls\\', '{"command":"ls\\u00', '{"command":"ls\\u', '{"command":"ls\\u00e']) {
      const html = argsHtml('bash', args, true)
      expect(html).toContain('$ </span>ls</div>')
      expect(summaryHtml('bash', args, true)).toContain('>ls</span>')
    }
    // A complete escape is kept.
    expect(argsHtml('bash', '{"command":"ls \\u00e9', true)).toContain('ls é')
    expect(argsHtml('bash', '{"command":"a\\\\', true)).toContain('a\\</div>')
  })

  it('handles empty and just-started args', () => {
    expect(argsHtml('bash', '', true)).toContain('></pre>')
    for (const args of ['{', '{"comm', '{"command":', '{"command":"']) {
      expect(argsHtml('bash', args, true)).toContain('$ </span></div>')
      expect(summaryHtml('bash', args, true)).toBe('')
    }
    expect(summaryHtml('bash', '', true)).toBe('')
  })

  it('a completed call with invalid JSON still falls back to the raw args', () => {
    expect(argsHtml('bash', partial, false)).toContain(rawFallback(partial))
  })
})

describe('streaming write args', () => {
  it('shows fields as they arrive, then switches to the complete args', () => {
    const streaming = argsHtml('write', '{"content":"line 1\\nline', true)
    expect(streaming).toContain('line 1\nline')
    // The path has not streamed yet: no "unknown" placeholder.
    expect(streaming).not.toContain('unknown')
    expect(summaryHtml('write', '{"content":"x', true)).toBe('')

    const complete = JSON.stringify({ content: 'line 1\nline 2', path: '/repo/src/app.ts' })
    const done = argsHtml('write', complete, false)
    expect(done).toContain('/repo/src/app.ts')
    expect(done).toContain('line 1\nline 2')
    expect(summaryHtml('write', complete, false)).toContain('app.ts')
    expect(summaryHtml('write', '{"path":"/repo/src/ap', true)).toContain('>ap</span>')
  })
})

describe('unflagged renderers while streaming', () => {
  it('keep the raw fallback until the args are complete', () => {
    const read = '{"path":"/repo/src/a'
    expect(argsHtml('read', read, true)).toContain(rawFallback(read))
    expect(summaryHtml('read', read, true)).toBe('')

    // A half-streamed navigate path must never render as a link.
    const navigate = '{"path":"/squads/ab'
    const html = argsHtml('navigate', navigate, true)
    expect(html).toContain(rawFallback(navigate))
    expect(html).not.toContain('href')

    expect(argsHtml('read', '{"path":"/repo/src/a.ts"}', true)).toContain('<code')
  })
})

describe('edit renderer', () => {
  const twoEdits = JSON.stringify({
    path: '/repo/src/app.ts',
    edits: [
      { oldText: 'const a = 1', newText: 'const a = 2' },
      { oldText: 'old line\nnext', newText: 'new line\nnext' },
    ],
  })

  it('renders every pair of an edits array', () => {
    const html = argsHtml('edit', twoEdits, false)
    for (const text of [
      'const a = 1',
      'const a = 2',
      'old line\nnext',
      'new line\nnext',
      'Edit 1 of 2',
      'Edit 2 of 2',
    ]) {
      expect(html).toContain(text)
    }
    expect(html.match(/>Old</g)).toHaveLength(2)
    expect(html.match(/>New</g)).toHaveLength(2)
    expect(summaryHtml('edit', twoEdits, false)).toContain('app.ts (2 edits)')
  })

  it('reads edits sent as a JSON string', () => {
    const args = JSON.stringify({
      path: '/repo/a.ts',
      edits: JSON.stringify([
        { oldText: 'x1', newText: 'y1' },
        { oldText: 'x2', newText: 'y2' },
      ]),
    })
    const html = argsHtml('edit', args, false)
    for (const text of ['x1', 'y1', 'x2', 'y2']) expect(html).toContain(text)
  })

  it('still renders the legacy top-level oldText/newText', () => {
    const args = JSON.stringify({ path: '/repo/a.ts', oldText: 'before', newText: 'after' })
    const html = argsHtml('edit', args, false)
    expect(html).toContain('before')
    expect(html).toContain('after')
    expect(html).not.toContain('Edit 1 of')
    expect(summaryHtml('edit', args, false)).toContain('>a.ts</span>')
  })

  it('renders a streaming edits array with a half-built last entry', () => {
    const html = argsHtml(
      'edit',
      '{"path":"/repo/a.ts","edits":[{"oldText":"one","newText":"uno"},{"oldText":"tw',
      true
    )
    expect(html).toContain('uno')
    expect(html).toContain('>tw</pre>')
    expect(html).toContain('Edit 2 of 2')
    expect(argsHtml('edit', '{"path":"/repo/a.ts","edits":[{', true)).toContain('/repo/a.ts')
  })
})

describe('generic view for tools without a renderer', () => {
  const complete = JSON.stringify({
    url: 'https://example.com',
    script: 'line one\nline "two"',
    timeoutMs: 3000,
    fullPage: true,
    viewport: { width: 1280, height: 720 },
    selector: null,
  })

  it('shows each top-level field with strings verbatim and other values as JSON', () => {
    const html = argsHtml('browser_open', complete, false)
    expect(html).toContain('>url</div>')
    expect(html).toContain('>timeout ms</div>')
    expect(html).toContain('>full page</div>')
    expect(html).toContain('https://example.com')
    expect(html).toContain('line one\nline &quot;two&quot;')
    expect(html).toContain('>3000</code>')
    expect(html).toContain('>true</code>')
    expect(html).toContain('>null</code>')
    expect(html).toContain('&quot;width&quot;: 1280')
    expect(html).not.toContain(rawFallback(complete))
  })

  it('shows partial args while streaming', () => {
    const html = argsHtml('webfetch', '{"url":"https://example.com","prompt":"first line\\nsecond', true)
    expect(html).toContain('https://example.com')
    expect(html).toContain('first line\nsecond')
  })

  it('keeps the raw text when nothing can be read yet, or when the finished args are invalid', () => {
    expect(argsHtml('webfetch', '{"ur', true)).toContain(rawFallback('{"ur'))
    expect(argsHtml('webfetch', '{"url":"https://exa', false)).toContain(rawFallback('{"url":"https://exa'))
    expect(argsHtml('webfetch', 'not json', true)).toContain('not json')
    expect(argsHtml('webfetch', '[1,2]', false)).toContain('[1,2]')
    expect(argsHtml('webfetch', '{}', false)).toContain('No arguments')
  })
})

describe('partial ask_human and dispatch shapes', () => {
  it('ask_human renders half-built questions and options', () => {
    const shapes = [
      '{"questions":[',
      '{"questions":[{}',
      '{"questions":[{"id":"deploy","question":"Ship?","options":[{"label":"Yes","value":"yes"},{"label":"N',
      '{"questions":[{"id":"deploy","question":"Ship?"},{"id":"deploy',
      '{"questions":[{"id":"q","options":[{},{"value":"a"},{"value":"a"}',
    ]
    for (const args of shapes) argsHtml('ask_human', args, true)
    const html = argsHtml('ask_human', shapes[2], true)
    expect(html).toContain('Ship?')
    expect(html).toContain('>Yes</span>')
    expect(html).toContain('>N</span>')
    expect(argsHtml('ask_human', shapes[0], true)).not.toContain('No questions')
    expect(summaryHtml('ask_human', shapes[3], true)).toContain('2 questions')
  })

  it('dispatch renders half-built subagent specs', () => {
    const shapes = [
      '{"subagents":[',
      '{"subagents":[{}',
      '{"subagents":[{"label":"Resea',
      '{"subagents":[{"label":"Research","instructions":"Look at\\nthe',
      '{"subagents":[{"label":"A","model":"openai:gp',
    ]
    for (const args of shapes) argsHtml('dispatch', args, true)
    expect(argsHtml('dispatch', shapes[0], true)).not.toContain('No subagents')
    expect(argsHtml('dispatch', shapes[1], true)).toContain('subagent 1')
    const html = argsHtml('dispatch', shapes[3], true)
    expect(html).toContain('Research')
    expect(html).toContain('Look at\nthe')
    expect(summaryHtml('dispatch', shapes[3], true)).toContain('1 subagent')
  })
})

describe('other opted-in renderers', () => {
  it('notify_contact shows the message as it streams', () => {
    const args = '{"urgency":"action_needed","message":"Deploy is blocked\\nby CI","question":"Re'
    const html = argsHtml('notify_contact', args, true)
    expect(html).toContain('Deploy is blocked\nby CI')
    expect(html).toContain('Re')
    expect(summaryHtml('notify_contact', args, true)).toContain('action needed: Deploy is blocked')
    // A partial urgency falls back to the info colors.
    expect(argsHtml('notify_contact', '{"urgency":"act', true)).toContain('>act</span>')
  })

  it('delegate_task shows the request as it streams', () => {
    const args = '{"label":"Check schedules","request":"Which schedules\\nare ena'
    expect(argsHtml('delegate_task', args, true, siteAssistantToolRenderers)).toContain('Which schedules\nare ena')
    expect(summaryHtml('delegate_task', args, true, siteAssistantToolRenderers)).toContain(
      'Background task: Check schedules'
    )
  })

  it('delegate_task without a label names the task by its request while it streams', () => {
    const args = '{"request":"Which schedules\\nare ena'
    expect(summaryHtml('delegate_task', args, true, siteAssistantToolRenderers)).toContain(
      'Background task: Which schedules'
    )
    expect(summaryHtml('delegate_task', '{"request":"Which sch', true, siteAssistantToolRenderers)).toContain(
      'Background task: Which sch'
    )
  })
})

describe('streaming every prefix of the args', () => {
  const cases: Array<[string, unknown, ToolRenderers?]> = [
    ['bash', { command: 'cd /repo\necho "done" \u00e9 \ud83d\ude00\nexit 0', timeout: 30 }],
    ['write', { path: '/repo/a.md', content: '# Title\n\n"quoted" \\ backslash' }],
    [
      'edit',
      {
        path: '/repo/a.ts',
        edits: [
          { oldText: 'a\n"b"', newText: 'c' },
          { oldText: 'd', newText: '' },
        ],
      },
    ],
    [
      'ask_human',
      {
        questions: [
          { id: 'q1', type: 'select', question: 'Pick?', options: [{ value: 'a' }, { value: 'ab', label: 'AB' }] },
          { id: 'q1x', question: 'Why?', context: 'Some\ncontext', optional: true },
        ],
      },
    ],
    [
      'dispatch',
      {
        subagents: [
          { label: 'One', instructions: 'Do\nthings', model: 'x:y' },
          { label: 'Two', instructions: 'More', inheritModel: true, agentType: 'subagent' },
        ],
      },
    ],
    ['notify_contact', { urgency: 'warning', message: 'Hello\nthere', question: 'OK?' }],
    ['delegate_task', { label: 'Task', request: 'Do it\nnow' }, siteAssistantToolRenderers],
    ['browser_click', { selector: '#main > a[href="/x"]', x: 10, nested: { list: [1, 'two', { three: 3 }] } }],
  ]

  it('renders every chunk boundary through a live root without errors, then the final args', async () => {
    const dom = await acquireDomHarness({ url: 'http://localhost/' })
    try {
      const { root } = dom.createRoot()
      for (const [toolName, value, renderers = agentToolRenderers] of cases) {
        const full = JSON.stringify(value)
        const render = (args: string, follow: boolean) =>
          dom.act(async () =>
            root.render(
              <MemoryRouter>
                <ToolSummary renderers={renderers} toolName={toolName} args={args} inProgress={follow} />
                <ToolArgsView renderers={renderers} toolName={toolName} args={args} follow={follow} />
              </MemoryRouter>
            )
          )
        for (let end = 1; end < full.length; end++) await render(full.slice(0, end), true)
        await render(full, false)
        expect(document.body.textContent).not.toContain('\\n')
      }
    } finally {
      await dom.cleanup()
    }
  })
})
