import { afterEach, describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SpendBreakdown, SpendSummary } from '@ficus/shared'
import { PermissionsProvider } from '../../../hooks/usePermissions'
import { acquireDomHarness } from '../../../test/domHarness'
import { SpendBreakdownTable } from './SpendBreakdownTable'
import { SpendDailyChart } from './SpendDailyChart'
import { SpendSection } from './SpendSection'
import { SpendTotals } from './SpendTotals'

/** The class list of the element whose opening tag contains `marker`, from static markup. */
function classesOf(html: string, marker: string): string[] {
  const at = html.indexOf(marker)
  expect(at).toBeGreaterThanOrEqual(0)
  const tag = html.slice(html.lastIndexOf('<', at), html.indexOf('>', at))
  return tag.match(/class="([^"]*)"/)?.[1].split(' ') ?? []
}

let dom: Awaited<ReturnType<typeof acquireDomHarness>> | undefined
afterEach(async () => {
  await dom?.cleanup()
  dom = undefined
})

const summary: SpendSummary = {
  from: '2026-09-01T00:00:00.000Z',
  to: '2026-10-01T00:00:00.000Z',
  totals: {
    calls: 1234,
    inputTokens: 1_000_000,
    outputTokens: 50_000,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    billedUsd: 41.5,
    subscriptionFeesUsd: 200,
    totalUsd: 241.5,
    listUsd: 612.25,
    approximate: false,
  },
  series: [
    { day: '2026-09-02', billedUsd: 10, listUsd: 30, calls: 100, tokens: 1000 },
    { day: '2026-09-03', billedUsd: 31.5, listUsd: 60, calls: 200, tokens: 2000 },
  ],
  subscriptions: [
    {
      provider: 'openai-codex',
      accountId: 'acc_1',
      label: 'OpenAI Codex · Work',
      plan: 'pro',
      planLabel: 'ChatGPT Pro',
      planSource: 'detected',
      detectedPlan: 'pro',
      monthlyPriceUsd: 200,
      priceSource: 'default',
      needsChoice: false,
      feeUsd: 200,
      calls: 900,
      listUsd: 570.75,
    },
    {
      provider: 'anthropic',
      accountId: 'acc_claude_code',
      label: 'Anthropic · Claude Code',
      plan: null,
      planLabel: null,
      planSource: null,
      detectedPlan: 'max',
      monthlyPriceUsd: null,
      priceSource: null,
      needsChoice: true,
      feeUsd: 0,
      calls: 12,
      listUsd: 0,
    },
  ],
  projection: { monthUsd: 260 },
  meta: { retentionDays: 180, detailFrom: '2026-04-18T00:00:00.000Z', feesIncluded: true },
}

// Phone layout (390 px): nothing may make the page wider than the viewport. Real layout is measured in
// Chromium by scripts/check-spend-layout.ts; these pin the rules that make it so.
describe('SpendSection on a phone', () => {
  const page = () =>
    renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <PermissionsProvider
          usePermissions={() => ({ permissions: ['*'], can: () => true, isLoading: false, isError: false })}
        >
          <SpendSection />
        </PermissionsProvider>
      </QueryClientProvider>
    )

  test('the period pills wrap inside their own row instead of widening the page', () => {
    const html = page()
    expect(html).toContain('>30 days<')
    expect(html).toContain('>Custom<')
    const pills = classesOf(html, 'aria-label="Period"')
    expect(pills).toContain('max-w-full')
    expect(pills).toContain('flex-wrap')
    // Its row is a shrinkable flex parent.
    expect(html).toContain(
      '<div class="flex min-w-0 flex-wrap items-center gap-3"><div role="radiogroup" aria-label="Period"'
    )
    expect(classesOf(html, 'aria-labelledby="spend-heading"')).toContain('min-w-0')
  })

  test('the top lists stack in one shrinkable column', () => {
    expect(classesOf(page(), 'class="grid ')).toEqual(expect.arrayContaining(['grid-cols-1', 'md:grid-cols-2']))
  })
})

describe('SpendTotals', () => {
  test('shows billed usage and each subscription as its own line, with plan-unknown asking for a choice', () => {
    const html = renderToStaticMarkup(
      <SpendTotals summary={summary} periodLabel="last month" preview={false} onPreviewChange={() => {}} />
    )
    expect(html).toContain('$241.50')
    expect(html).toContain('$41.50')
    expect(html).toContain('OpenAI Codex · Work: ChatGPT Pro')
    expect(html).toContain('$200.00/month')
    expect(html).toContain('Anthropic · Claude Code: subscription, plan unknown')
    expect(html).toContain('Choose its plan or price to count its fee')
    expect(html).toContain('About <span class="tabular-nums">$260.00</span> this month')
    // The preview is low-key: a link, with its figure hidden until asked.
    expect(html).toContain('Preview without subscriptions')
    expect(html).not.toContain('$612.25')
  })

  test('the preview shows every call at list price with no fees', async () => {
    dom = await acquireDomHarness({ url: 'http://localhost/settings?section=spend' })
    const { container, root } = dom.createRoot()
    let preview = false
    const render = () =>
      root.render(
        <SpendTotals
          summary={summary}
          periodLabel="last month"
          preview={preview}
          onPreviewChange={(next) => {
            preview = next
            render()
          }}
        />
      )
    await dom.act(async () => render())
    const toggle = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Preview without subscriptions')
    )!
    await dom.act(async () => toggle.click())
    expect(container.textContent).toContain('$612.25 if every call in this period were billed at list price')
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
  })

  test('says when fees are left out of a narrowed view', () => {
    const html = renderToStaticMarkup(
      <SpendTotals
        summary={{ ...summary, subscriptions: [], meta: { ...summary.meta, feesIncluded: false } }}
        periodLabel="7 days"
        preview={false}
        onPreviewChange={() => {}}
      />
    )
    expect(html).toContain('Subscription fees are left out')
  })
})

describe('SpendDailyChart', () => {
  test('draws one bar group per day, empty days included, with an accessible summary', () => {
    const html = renderToStaticMarkup(
      <SpendDailyChart series={summary.series} from="2026-09-01T00:00:00.000Z" to="2026-09-05T00:00:00.000Z" />
    )
    expect(html.match(/data-day=/g)).toHaveLength(4)
    expect(html).toContain('role="img"')
    expect(html).toContain('aria-label="Daily spend, 4 days, $41.50 billed; highest $31.50 on 2026-09-03"')
    expect(html).toContain('<title>2026-09-01: $0.00 billed, 0 calls</title>')
    expect(html).not.toContain('at list price')
  })

  test('with the preview on, each day also shows its list price', () => {
    const html = renderToStaticMarkup(
      <SpendDailyChart series={summary.series} from="2026-09-02T00:00:00.000Z" to="2026-09-04T00:00:00.000Z" showList />
    )
    expect(html).toContain('$30.00 at list price')
    expect(html.match(/opacity="0.25"/g)).toHaveLength(2)
  })
})

describe('SpendBreakdownTable', () => {
  const breakdown: SpendBreakdown = {
    by: 'model',
    by2: 'billing',
    truncated: true,
    rows: [
      {
        key: 'claude-sonnet-4-5',
        label: 'claude-sonnet-4-5',
        key2: 'api',
        label2: 'API key',
        calls: 10,
        tokens: 12_300,
        billedUsd: 3,
        listUsd: 3,
        approximate: false,
      },
      {
        key: null,
        label: 'Unknown model',
        key2: 'unknown',
        label2: 'Unknown',
        calls: 2,
        tokens: 5,
        billedUsd: 1,
        listUsd: 1,
        approximate: true,
      },
    ],
  }

  test('lists rows with shares and narrows the view to a clicked value', async () => {
    dom = await acquireDomHarness({ url: 'http://localhost/settings?section=spend' })
    const { container, root } = dom.createRoot()
    const filters: Array<[string, string | null]> = []
    await dom.act(async () =>
      root.render(
        <SpendBreakdownTable
          title="Top models"
          breakdown={breakdown}
          showList={false}
          onFilter={(dimension, key) => filters.push([dimension, key])}
        />
      )
    )
    const text = container.textContent ?? ''
    expect(text).toContain('12.3k')
    expect(text).toContain('75%')
    expect(text).toContain('≈ $1.00')
    expect(text).toContain('Showing the largest 2.')
    const buttons = [...container.querySelectorAll('tbody button')]
    await dom.act(async () => (buttons[0] as HTMLButtonElement).click())
    await dom.act(async () => (buttons[3] as HTMLButtonElement).click())
    expect(filters).toEqual([
      ['model', 'claude-sonnet-4-5'],
      ['billing', 'unknown'],
    ])
  })

  test('fits a phone: the table scrolls in its own container, calls and tokens fold under the label', () => {
    const html = renderToStaticMarkup(
      <SpendBreakdownTable title="Top agents" breakdown={breakdown} showList={false} onFilter={() => {}} />
    )
    expect(classesOf(html, 'aria-labelledby="spend-breakdown-top-agents"')).toContain('min-w-0')
    expect(classesOf(html, 'class="max-w-full overflow-x-auto')).toContain('overflow-x-auto')
    // Calls and tokens columns only from sm up; under it, a line under the label says the same.
    for (const heading of ['>Calls<', '>Tokens<'])
      expect(classesOf(html, heading)).toEqual(expect.arrayContaining(['hidden', 'sm:table-cell']))
    expect(html).toContain('10 calls · 12.3k tokens')
    expect(html).toContain('2 calls · 5 tokens')
    expect(classesOf(html, '10 calls · 12.3k tokens')).toEqual(expect.arrayContaining(['block', 'sm:hidden']))
    // "≈" never wraps away from its amount.
    expect(classesOf(html, '≈ $1.00')).toContain('whitespace-nowrap')
  })

  test('an empty period says so', () => {
    const html = renderToStaticMarkup(
      <SpendBreakdownTable
        title="Top agents"
        breakdown={{ by: 'agent', rows: [], truncated: false }}
        showList={false}
        onFilter={() => {}}
      />
    )
    expect(html).toContain('No spend in this period.')
  })
})
