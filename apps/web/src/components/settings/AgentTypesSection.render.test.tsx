import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ResolvedModelText, TierChainEditor, TierFilterChip } from './AgentTypesSection'
describe('Agents rendered model controls', () => {
  test('renders only the human-facing tier label in a tier-backed Types row', () => {
    const html = renderToStaticMarkup(
      <ResolvedModelText
        agentType={{ tier: 'deep', model: '', resolvedChain: 'openai:model:high', provenance: 'via tier: deep' }}
        tierLabel="Deep"
      />
    )
    expect(html).toContain('Model tier: Deep')
    expect(html).not.toContain('openai:model:high')
    expect(html).not.toContain('via tier')
  })
  test('keeps a colon-bearing model id out of the effort control', () => {
    const html = renderToStaticMarkup(
      <TierChainEditor
        tier={{
          slug: 'fast',
          label: 'Fast',
          description: null,
          chain: 'local:llama3.2:latest',
          sortOrder: 1,
          usedByCount: 1,
        }}
        providers={['local']}
        onSave={() => {}}
      />
    )
    expect(html).toContain('value="llama3.2:latest"')
    expect(html).toContain('<option selected="">off</option>')
  })

  test('marks entries of a disabled provider as Disabled, muted, without touching enabled entries', () => {
    const tier = {
      slug: 'deep',
      label: 'Deep',
      description: null,
      chain: 'zai:glm-5.3:high,openai:gpt:high',
      sortOrder: 1,
      usedByCount: 1,
    }
    const html = renderToStaticMarkup(
      <TierChainEditor tier={tier} providers={['zai', 'openai']} disabledProviders={['zai']} onSave={() => {}} />
    )
    expect(html.match(/>Disabled<\/span>/g)).toHaveLength(1)
    expect(html.match(/opacity-60/g)).toHaveLength(1)
    expect(html).toContain('title="This provider is disabled in provider settings, so this entry is skipped."')
    const none = renderToStaticMarkup(<TierChainEditor tier={tier} providers={['zai', 'openai']} onSave={() => {}} />)
    expect(none).not.toContain('>Disabled</span>')
  })

  test('renders separate provider, model and effort controls for every position', () => {
    const html = renderToStaticMarkup(
      <TierChainEditor
        tier={{
          slug: 'deep',
          label: 'Deep',
          description: null,
          chain: 'openai:gpt:high',
          sortOrder: 1,
          usedByCount: 1,
        }}
        providers={['openai']}
        onSave={() => {}}
      />
    )
    expect(html).toContain('aria-label="Deep provider position 1"')
    expect(html).toContain('aria-label="Deep model position 1"')
    expect(html).toContain('aria-label="Deep effort position 1"')
  })

  test('renders derived OpenRouter rows after all editable positions and hides them when absent', () => {
    const tier = {
      slug: 'deep',
      label: 'Deep',
      description: null,
      chain: 'openai:gpt:high,anthropic:claude:medium',
      sortOrder: 1,
      usedByCount: 1,
    }
    const enabled = renderToStaticMarkup(
      <TierChainEditor
        tier={tier}
        providers={['openai', 'anthropic']}
        derivedFallbacks={['openrouter:openai/gpt:high', 'openrouter:anthropic/claude:medium']}
        onSave={() => {}}
      />
    )
    expect(enabled.indexOf('Deep provider position 2')).toBeLessThan(enabled.indexOf('via OpenRouter'))
    expect(enabled).toMatch(/>3\.<\/span><code[^>]*>openrouter:openai\/gpt:high<\/code>/)
    expect(enabled).toMatch(/>4\.<\/span><code[^>]*>openrouter:anthropic\/claude:medium<\/code>/)
    expect(enabled.match(/via OpenRouter/g)).toHaveLength(2)

    const disabled = renderToStaticMarkup(
      <TierChainEditor tier={tier} providers={['openai', 'anthropic']} onSave={() => {}} />
    )
    expect(disabled).not.toContain('via OpenRouter')
    expect(disabled).not.toContain('openrouter:')
  })

  test('TierFilterChip shows the active tier and a clear affordance when filtered', () => {
    const html = renderToStaticMarkup(<TierFilterChip tierFilter="deep" onClear={() => {}} />)
    expect(html).toContain('Filtered to model tier:')
    expect(html).toContain('deep')
    expect(html).toContain('Clear filter')
  })

  test('TierFilterChip renders nothing when no tier filter is active', () => {
    const html = renderToStaticMarkup(<TierFilterChip onClear={() => {}} />)
    expect(html).toBe('')
  })
})

test('catalog selection preserves custom IDs and supports keyboard reorder', async () => {
  const { acquireDomHarness } = await import('../../test/domHarness')
  const dom = await acquireDomHarness({})
  const { root, container } = dom.createRoot()
  const saved: string[] = []
  try {
    await dom.act(async () =>
      root.render(
        <TierChainEditor
          tier={{
            slug: 'deep',
            label: 'Deep',
            description: null,
            chain: 'local:llama:latest:high,openai:custom:model:low',
            sortOrder: 1,
            usedByCount: 1,
          }}
          providers={['local', 'openai']}
          catalog={[
            {
              provider: 'local',
              id: 'llama:latest',
              name: 'Local Llama',
              reasoning: true,
              input: ['text'],
              contextWindow: 32000,
              maxTokens: 8000,
            },
          ]}
          onSave={(tier) => saved.push(tier.chain)}
        />
      )
    )
    expect(container.textContent).toContain('Local Llama')
    expect(container.textContent).toContain('32k context')
    const picker = container.querySelector<HTMLSelectElement>('[aria-label="Deep model selection position 1"]')!
    await dom.act(async () => {
      picker.value = '__custom__'
      picker.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    })
    expect(container.querySelector<HTMLInputElement>('[aria-label="Deep model position 1"]')!.value).toBe(
      'llama:latest'
    )
    expect(saved).toEqual([])
    await dom.act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Move Deep model 2 up"]')!.click()
    )
    expect(saved.at(-1)).toBe('openai:custom:model:low,local:llama:latest:high')
  } finally {
    await dom.cleanup()
  }
})
