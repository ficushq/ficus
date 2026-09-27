import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ArtifactRenderer } from './ArtifactRenderer'
import { clampHtmlBlockHeight, isPresentationHtmlHeightMessage } from './PresentationHtmlBlockSizing'

const presentationContent = {
  schemaVersion: 1,
  title: 'Weekly Voice Summary',
  sections: [
    {
      id: 'overview',
      title: 'Overview',
      blocks: [
        { type: 'markdown', content: '## Highlights\n\n- Calls are up' },
        {
          type: 'metrics',
          items: [
            { label: 'Calls', value: 42, tone: 'success' },
            { label: 'Escalations', value: '3', tone: 'warning' },
          ],
        },
        {
          type: 'table',
          columns: [
            { key: 'name', label: 'Name' },
            { key: 'score', label: 'Score' },
          ],
          rows: [{ name: 'Ada', score: 98 }],
        },
        {
          type: 'chart',
          library: 'vega-lite',
          spec: {
            mark: 'bar',
            data: { values: [{ label: 'Calls', value: 42 }] },
            encoding: { x: { field: 'label', type: 'nominal' }, y: { field: 'value', type: 'quantitative' } },
          },
        },
        { type: 'callout', title: 'Watch', content: 'Review missed calls', tone: 'info' },
        { type: 'timeline', items: [{ title: 'Started', at: '9:00', content: 'Agent joined' }] },
      ],
    },
  ],
} as const

describe('ArtifactRenderer', () => {
  test('renders presentation sections and supported block content', () => {
    const html = renderToStaticMarkup(
      <ArtifactRenderer entry={{ type: 'presentation', path: 'artifact.json' }} content={presentationContent} />
    )

    expect(html).toContain('Weekly Voice Summary')
    expect(html).toContain('Overview')
    expect(html).toContain('Calls')
    expect(html).toContain('42')
    expect(html).toContain('Ada')
    expect(html).toContain('Review missed calls')
    expect(html).toContain('Started')
  })

  test('renders presentation without title chrome when requested', () => {
    const html = renderToStaticMarkup(
      <ArtifactRenderer
        entry={{ type: 'presentation', path: 'artifact.json' }}
        content={presentationContent}
        presentationChrome="none"
      />
    )

    expect(html).not.toContain('Weekly Voice Summary')
    expect(html).not.toContain('Overview')
    expect(html).toContain('Calls')
    expect(html).toContain('42')
  })

  test('renders chrome-less presentation sections at content height', () => {
    const html = renderToStaticMarkup(
      <ArtifactRenderer
        entry={{ type: 'presentation', path: 'artifact.json' }}
        content={{
          schemaVersion: 1,
          title: 'Sequential presentation',
          sections: [
            { id: 'first', blocks: [{ type: 'markdown', content: 'First section' }] },
            { id: 'second', blocks: [{ type: 'markdown', content: 'Second section' }] },
          ],
        }}
        presentationChrome="none"
      />
    )

    expect(html).toContain('First section')
    expect(html).toContain('Second section')
    expect(html).not.toContain('<div class="h-full min-h-0 w-full" data-artifact-type="presentation"')
    expect(html).not.toContain('<section class="h-full min-h-0">')
    expect(html).not.toContain('<div class="h-full min-h-0"><section')
  })

  test('renders legacy HTML inside presentation markdown blocks as sandboxed HTML', () => {
    const html = renderToStaticMarkup(
      <ArtifactRenderer
        entry={{ type: 'presentation', path: 'artifact.json' }}
        content={{
          schemaVersion: 1,
          title: 'HTML dashboard presentation',
          sections: [
            {
              id: 'dashboard',
              blocks: [
                {
                  type: 'markdown',
                  content:
                    '# Hello World Dashboard\n\n<div style="min-height: 360px"><div style="font-size: 4rem">Hello, World!</div></div>',
                },
              ],
            },
          ],
        }}
        presentationChrome="none"
      />
    )

    expect(html).toContain('<iframe')
    expect(html).toContain('sandbox="allow-scripts"')
    expect(html).not.toContain('# Hello World Dashboard')
    expect(html).toContain('&lt;div style=&quot;min-height: 360px&quot;&gt;')
    expect(html).not.toContain('min-h-[100dvh]')
  })

  test('renders explicit presentation HTML blocks as sandboxed HTML', () => {
    const html = renderToStaticMarkup(
      <ArtifactRenderer
        entry={{ type: 'presentation', path: 'artifact.json' }}
        content={{
          schemaVersion: 1,
          title: 'HTML dashboard presentation',
          sections: [
            {
              id: 'dashboard',
              blocks: [
                {
                  type: 'html',
                  iframeAccessibilityTitle: 'Hello card',
                  content: '<div style="min-height: 360px"><div style="font-size: 4rem">Hello, World!</div></div>',
                },
              ],
            },
          ],
        }}
      />
    )

    expect(html).toContain('<iframe')
    expect(html).toContain('sandbox="allow-scripts"')
    expect(html).toContain('Hello card')
    expect(html).toContain('&lt;div style=&quot;min-height: 360px&quot;&gt;')
    expect(html).not.toContain('&amp;lt;div style')
  })

  test('presentation HTML blocks include the auto-height bridge while preserving sandbox isolation', () => {
    const html = renderToStaticMarkup(
      <ArtifactRenderer
        entry={{ type: 'presentation', path: 'artifact.json' }}
        content={{
          schemaVersion: 1,
          title: 'HTML dashboard',
          sections: [{ id: 'main', blocks: [{ type: 'html', content: '<div>Hi</div>' }] }],
        }}
        presentationChrome="none"
      />
    )

    expect(html).toContain('ficus:presentation-html-height')
    expect(html).toContain('sandbox="allow-scripts"')
    expect(html).not.toContain('allow-same-origin')
    expect(html).toContain('tau-presentation-html-content')
    expect(html).not.toContain('min-height:100%')
    expect(html).not.toContain('documentElement.scrollHeight')
    expect(html).not.toContain('min-h-[360px]')
  })

  test('presentation HTML blocks honor min/max height metadata while keeping auto-height enabled', () => {
    const html = renderToStaticMarkup(
      <ArtifactRenderer
        entry={{ type: 'presentation', path: 'artifact.json' }}
        content={{
          schemaVersion: 1,
          title: 'Clamped HTML dashboard',
          sections: [
            { id: 'main', blocks: [{ type: 'html', content: '<div>Hi</div>', minHeight: 240, maxHeight: 800 }] },
          ],
        }}
        presentationChrome="none"
      />
    )

    expect(html).toContain('style="height:240px"')
    expect(html).toContain('ficus:presentation-html-height')
    expect(html).toContain('tau-presentation-html-content')
  })

  test('presentation HTML blocks honor explicit fixed height metadata', () => {
    const html = renderToStaticMarkup(
      <ArtifactRenderer
        entry={{ type: 'presentation', path: 'artifact.json' }}
        content={{
          schemaVersion: 1,
          title: 'Fixed HTML dashboard',
          sections: [{ id: 'main', blocks: [{ type: 'html', content: '<div>Hi</div>', height: 640 }] }],
        }}
        presentationChrome="none"
      />
    )

    expect(html).toContain('style="height:640px"')
    expect(html).not.toContain('ficus:presentation-html-height')
  })

  test('validates and clamps presentation HTML height messages', () => {
    expect(clampHtmlBlockHeight(42, 120, 4000)).toBe(120)
    expect(clampHtmlBlockHeight(260.2, 120, 4000)).toBe(261)
    expect(clampHtmlBlockHeight(9999, 120, 1600)).toBe(1600)

    expect(
      isPresentationHtmlHeightMessage(
        { type: 'ficus:presentation-html-height', blockId: 'presentation-html-1', height: 320 },
        'presentation-html-1'
      )
    ).toBe(true)
    expect(
      isPresentationHtmlHeightMessage(
        { type: 'ficus:presentation-html-height', blockId: 'spoofed-block', height: 320 },
        'presentation-html-1'
      )
    ).toBe(false)
    expect(
      isPresentationHtmlHeightMessage(
        { type: 'ficus:presentation-html-height', blockId: 'presentation-html-1', height: Number.POSITIVE_INFINITY },
        'presentation-html-1'
      )
    ).toBe(false)
  })

  test('rejects charts with external urls', () => {
    const html = renderToStaticMarkup(
      <ArtifactRenderer
        entry={{ type: 'presentation', path: 'artifact.json' }}
        content={{
          schemaVersion: 1,
          title: 'Unsafe chart',
          sections: [
            {
              id: 'chart',
              blocks: [
                {
                  type: 'chart',
                  library: 'vega-lite',
                  spec: { mark: 'bar', data: { url: 'https://example.com/data.json' } },
                },
              ],
            },
          ],
        }}
      />
    )

    expect(html).toContain('Unable to render chart')
    expect(html).toContain('external URLs')
    expect(html).not.toContain('https://example.com/data.json')
  })

  test('rejects nested chart href and src resource references', () => {
    const html = renderToStaticMarkup(
      <ArtifactRenderer
        entry={{ type: 'presentation', path: 'artifact.json' }}
        content={{
          schemaVersion: 1,
          title: 'Unsafe nested chart',
          sections: [
            {
              id: 'chart',
              blocks: [
                {
                  type: 'chart',
                  library: 'vega-lite',
                  spec: {
                    mark: 'point',
                    encoding: { href: { value: 'https://example.com/detail' } },
                    config: { image: { src: 'data:image/png;base64,abc' } },
                  },
                },
              ],
            },
          ],
        }}
      />
    )

    expect(html).toContain('Unable to render chart')
    expect(html).toContain('external URLs')
    expect(html).not.toContain('https://example.com/detail')
  })

  test('renders markdown through React markdown without injecting raw html', () => {
    const html = renderToStaticMarkup(
      <ArtifactRenderer entry={{ type: 'markdown', path: 'notes.md' }} content={'# Notes\n<script>alert(1)</script>'} />
    )

    expect(html).toContain('<h1>Notes</h1>')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  test('renders html artifacts in a sandboxed iframe with a restrictive resource policy', () => {
    const html = renderToStaticMarkup(
      <ArtifactRenderer
        entry={{ type: 'html', path: 'index.html' }}
        content={'<main>Hello</main><img src="https://example.com/tracker.png"><script>alert(1)</script>'}
      />
    )

    expect(html).toContain('<iframe')
    expect(html).toContain('sandbox="allow-scripts"')
    expect(html).toContain(
      'http-equiv=&quot;Content-Security-Policy&quot; content=&quot;default-src &#x27;none&#x27;; img-src data: blob:; style-src &#x27;unsafe-inline&#x27;; font-src data:; frame-src &#x27;none&#x27;; object-src &#x27;none&#x27;; connect-src * http: https: ws: wss:; script-src &#x27;unsafe-inline&#x27;&quot;'
    )
    expect(html).toContain('&lt;main&gt;Hello&lt;/main&gt;')
    expect(html).toContain('https://example.com/tracker.png')
  })

  test('places html artifact CSP in a real wrapper head before attacker-controlled content', () => {
    const html = renderToStaticMarkup(
      <ArtifactRenderer
        entry={{ type: 'html', path: 'index.html' }}
        content={'<!-- <head> --><img src="https://example.com/x.png">'}
      />
    )

    const headIndex = html.indexOf('&lt;head&gt;')
    const cspIndex = html.indexOf('http-equiv=&quot;Content-Security-Policy&quot;')
    const commentIndex = html.indexOf('&lt;!-- &lt;head&gt; --&gt;')

    expect(headIndex).toBeGreaterThanOrEqual(0)
    expect(cspIndex).toBeGreaterThan(headIndex)
    expect(commentIndex).toBeGreaterThan(cspIndex)
    expect(html).not.toContain('&lt;!-- &lt;head&gt;&lt;meta')
  })

  test('shows a placeholder for sandbox app artifacts', () => {
    const html = renderToStaticMarkup(<ArtifactRenderer entry={{ type: 'sandbox_app', path: 'app' }} content={{}} />)

    expect(html).toContain('Sandbox apps are not available yet')
  })
})
