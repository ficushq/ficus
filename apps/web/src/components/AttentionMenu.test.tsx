import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Attention } from '@ficus/shared'
import { queryKeys } from '../queryKeys'
import { AttentionMenu } from './AttentionMenu'
import { acquireDomHarness } from '../test/domHarness'

function renderSquad(attention: Attention, subscribed = true, align?: 'left' | 'right'): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.squadSubscription.detail('squad-1'), { subscribed, count: 3, attention })
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <AttentionMenu target={{ kind: 'squad', id: 'squad-1' }} align={align} />
    </QueryClientProvider>
  )
}

function renderStream(attention: Attention, inherited: boolean): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.workStreamSubscription.detail('ws-1'), {
    subscribed: !inherited,
    count: 1,
    attention,
    inherited,
  })
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <AttentionMenu target={{ kind: 'workStream', id: 'ws-1' }} />
    </QueryClientProvider>
  )
}

function renderLoadingStream(): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <AttentionMenu target={{ kind: 'workStream', id: 'ws-1' }} />
    </QueryClientProvider>
  )
}

const radio = (html: string, label: string) => html.match(new RegExp(`<input[^>]*aria-label="${label}"[^>]*>`))?.[0]

const levelLabel = (html: string, text: string) =>
  html.match(new RegExp(`<label[^>]*>[^<]*<input[^>]*aria-label="${text}"[^>]*>`))?.[0]

/**
 * The trigger's one-word summary. Asserting on the whole document would be vacuous: every render
 * contains "Notify", "Show" and "Mute" as radio labels, so only the <summary> span proves the
 * collapse rule.
 */
const summaryLabel = (html: string) => html.match(/<summary[^>]*>.*?<span>([^<]*)<\/span>/s)?.[1]

/**
 * The popover panel's own class list. Asserting on the whole document would be vacuous for the
 * surface classes: the `<summary>` trigger carries `hover:bg-surface-hover`, which contains the
 * substring `bg-surface` whatever the panel does.
 */
const panelClass = (html: string) => html.match(/<\/summary>\s*<div class="([^"]*)"/)?.[1]

describe('AttentionMenu', () => {
  test('summarizes equal levels in one word and a mix as Custom', () => {
    expect(summaryLabel(renderSquad({ decisions: 'notify', progress: 'notify' }))).toBe('Notify')
    expect(summaryLabel(renderSquad({ decisions: 'show', progress: 'show' }, false))).toBe('Show')
    expect(summaryLabel(renderSquad({ decisions: 'mute', progress: 'mute' }))).toBe('Muted')
    expect(summaryLabel(renderSquad({ decisions: 'notify', progress: 'mute' }))).toBe('Custom')
  })

  test('offers both kinds with their helper text and checks the current level of each', () => {
    const html = renderSquad({ decisions: 'notify', progress: 'mute' })
    expect(html).toContain('Decisions')
    expect(html).toContain('Questions, reviews, and blockers')
    expect(html).toContain('Progress')
    expect(html).toContain('Active work and completions')

    expect(radio(html, 'Decisions: Notify')).toContain('checked')
    expect(radio(html, 'Decisions: Mute')).not.toContain('checked')
    expect(radio(html, 'Progress: Mute')).toContain('checked')
    expect(radio(html, 'Progress: Notify')).not.toContain('checked')
  })

  /**
   * The segmented control's three words are meaningless on their own — "Show" versus "Notify" says
   * nothing about where the item appears or whether a phone buzzes. The panel spells out the
   * CURRENT level per kind, from the copy shared with mobile.
   */
  test('each kind explains what its current level actually does', () => {
    const html = renderSquad({ decisions: 'show', progress: 'notify' })
    expect(html).toContain('Shown in Needs you. No inbox or push.')
    expect(html).toContain('Shown in the feed, plus inbox and push when work finishes.')
    // The description tracks the level, so the copy for a level that is NOT selected is absent.
    expect(html).not.toContain('Shown in Needs you, plus inbox and push.')
    expect(html).not.toContain('Hidden from Needs you.')

    const muted = renderSquad({ decisions: 'mute', progress: 'mute' })
    expect(muted).toContain('Hidden from Needs you.')
    expect(muted).toContain('Hidden from the feed\u2019s active work.')
  })

  test('each radiogroup points at its own description for screen readers', () => {
    const html = renderSquad({ decisions: 'show', progress: 'show' })
    const described = [...html.matchAll(/<div role="radiogroup"[^>]*aria-describedby="([^"]+)"/g)].map(
      (match) => match[1]
    )
    expect(described).toHaveLength(2)
    // Two kinds, two distinct targets, each resolving to a paragraph that exists in the markup.
    expect(new Set(described).size).toBe(2)
    for (const id of described) expect(html).toContain(`<p id="${id}"`)
  })

  test('a work stream shows its inheritance and the reset action only while inheriting', () => {
    const inheriting = renderStream({ decisions: 'notify', progress: 'notify' }, true)
    expect(inheriting).toContain('Inherits from squad')
    expect(inheriting).not.toContain('Reset to squad')

    const overridden = renderStream({ decisions: 'mute', progress: 'mute' }, false)
    expect(overridden).not.toContain('Inherits from squad')
    expect(overridden).toContain('Reset to squad')
  })

  test('a squad menu never offers stream inheritance copy', () => {
    const html = renderSquad({ decisions: 'show', progress: 'show' }, false)
    expect(html).not.toContain('Inherits from squad')
    expect(html).not.toContain('Reset to squad')
  })

  test('a work stream claims neither inheritance nor an override until its subscription loads', () => {
    const html = renderLoadingStream()
    expect(html).not.toContain('Inherits from squad')
    expect(html).not.toContain('Reset to squad')
  })

  /**
   * `bg-surface-primary` was not a token — tailwind.config.js defines surface DEFAULT/secondary/
   * hover and no `primary` — so the panel rendered with no background and the page read through
   * it on a phone. Pin the surface classes the repo's other popovers use.
   */
  test('the panel uses the shared popover surface, not an undefined token', () => {
    const panel = panelClass(renderSquad({ decisions: 'show', progress: 'show' }))
    expect(panel).toBeDefined()
    expect(panel).toContain('bg-surface ')
    expect(panel).not.toContain('bg-surface-primary')
    expect(panel).toContain('ficus-overlay')
    expect(panel).toContain('shadow-theme-lg')
    // A 16rem panel must never be wider than a phone viewport.
    expect(panel).toContain('max-w-[calc(100vw-2rem)]')
  })

  test('the panel hangs from the left of the trigger by default and from the right on request', () => {
    // The squad header's trigger sits at the LEFT, so a right-anchored panel ran off screen.
    const defaulted = panelClass(renderSquad({ decisions: 'show', progress: 'show' }))
    expect(defaulted).toContain('left-0')
    expect(defaulted).not.toContain('right-0')

    const rightAligned = panelClass(renderSquad({ decisions: 'show', progress: 'show' }, true, 'right'))
    expect(rightAligned).toContain('right-0')
    expect(rightAligned).not.toContain('left-0')
  })

  test('the clipped radio lends its keyboard focus ring to the visible label', () => {
    const html = renderSquad({ decisions: 'show', progress: 'show' })
    expect(levelLabel(html, 'Decisions: Show')).toContain('has-[:focus-visible]:outline')
    // The radio keeps focus through a level change: nothing disables it mid-request.
    expect(radio(html, 'Decisions: Show')).not.toContain('disabled')
  })
})

// ── Dismissal (live DOM) ─────────────────────────────────────────────────────

let domHarness: Awaited<ReturnType<typeof acquireDomHarness>> | undefined

afterEach(async () => {
  await domHarness?.cleanup()
  domHarness = undefined
})

async function mountSquadMenu() {
  const dom = (domHarness = await acquireDomHarness({ url: 'http://localhost/squads' }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.squadSubscription.detail('squad-1'), {
    subscribed: true,
    count: 1,
    attention: { decisions: 'notify', progress: 'notify' } satisfies Attention,
  })
  const { root } = dom.createRoot()
  await dom.act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <AttentionMenu target={{ kind: 'squad', id: 'squad-1' }} />
      </QueryClientProvider>
    )
  )
  const details = dom.window.document.querySelector('details')!
  const summary = details.querySelector('summary')!
  return { dom, details, summary }
}

describe('AttentionMenu dismissal', () => {
  test('Escape closes the popover and hands focus back to the trigger', async () => {
    const { dom, details, summary } = await mountSquadMenu()
    await dom.act(async () => summary.click())
    expect(details.open).toBe(true)

    // Focus sits on a radio inside the panel, as it would after arrowing through the levels.
    const radio = details.querySelector('input[type="radio"]')!
    await dom.act(async () => (radio as unknown as HTMLElement).focus())
    await dom.act(async () =>
      radio.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    )

    expect(details.open).toBe(false)
    // Without this the keyboard user is dropped at the top of the document.
    expect(dom.window.document.activeElement).toBe(summary)
  })

  test('a pointer press outside closes the popover, one inside leaves it open', async () => {
    const { dom, details, summary } = await mountSquadMenu()
    await dom.act(async () => summary.click())
    expect(details.open).toBe(true)

    await dom.act(async () =>
      details.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true, cancelable: true }))
    )
    expect(details.open).toBe(true)

    await dom.act(async () =>
      dom.window.document.body.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true, cancelable: true }))
    )
    expect(details.open).toBe(false)
  })
})
