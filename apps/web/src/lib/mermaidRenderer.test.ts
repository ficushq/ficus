import { expect, test } from 'bun:test'
import { acquireDomHarness } from '../test/domHarness'
import { mermaidConfig } from './mermaidConfig'

// Real Mermaid parses here; drawing needs a browser layout engine, which the test DOM lacks.
test('diagram directives cannot relax strict mode, enable HTML labels or loosen sanitizing', async () => {
  const harness = await acquireDomHarness({ url: 'https://ficus.test' })
  try {
    const { default: mermaid } = await import('mermaid/dist/mermaid.esm.min.mjs')
    mermaid.initialize(mermaidConfig(true))
    const directive = JSON.stringify({
      securityLevel: 'loose',
      htmlLabels: true,
      flowchart: { htmlLabels: true },
      dompurifyConfig: { ADD_TAGS: ['script'] },
      themeCSS: '.node { background: url(https://example.com/track) }',
    })
    await mermaid.parse(`%%{init: ${directive}}%%\nflowchart TD\n  A --> B`)
    const config = mermaid.mermaidAPI.getConfig()
    expect(config.securityLevel).toBe('strict')
    expect(config.htmlLabels).toBe(false)
    expect(config.flowchart?.htmlLabels).not.toBe(true)
    expect(config.dompurifyConfig).toBeUndefined()
    expect(config.themeCSS).toBeUndefined()
    expect(config.theme).toBe('dark')
  } finally {
    await harness.cleanup()
  }
}, 20_000)

test('invalid source rejects, so the Markdown block keeps its source', async () => {
  const harness = await acquireDomHarness({ url: 'https://ficus.test' })
  try {
    const { renderMermaid } = await import('./mermaidRenderer')
    await expect(renderMermaid('flowchart TD\n  A -->', false)).rejects.toThrow(/Parse error/)
    expect(document.body.querySelector('[id^="ficus-mermaid"], [id^="dficus-mermaid"]')).toBeNull()
  } finally {
    await harness.cleanup()
  }
}, 20_000)
