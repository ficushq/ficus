import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { Badge, BADGE_COLORS, type BadgeColor } from './Badge'

describe('Badge token treatments', () => {
  test('every status and used decorative accent renders without palette literals', () => {
    for (const color of Object.keys(BADGE_COLORS) as BadgeColor[]) {
      const html = renderToStaticMarkup(<Badge color={color}>Label</Badge>)
      expect(html).toContain(BADGE_COLORS[color])
      expect(html).not.toMatch(/(?:bg|text)-(?:gray|red|orange|amber|yellow|green|cyan|blue|violet|purple)-/)
      expect(html).not.toContain('hover:')
    }
    expect(Object.keys(BADGE_COLORS)).toHaveLength(16)
    expect(renderToStaticMarkup(<Badge>Default</Badge>)).toContain(BADGE_COLORS.neutral)
  })

  test('links and buttons use the same token-backed hover treatment', () => {
    const link = renderToStaticMarkup(
      <MemoryRouter>
        <Badge color="humanWait" to="/inbox">
          Link
        </Badge>
      </MemoryRouter>
    )
    const button = renderToStaticMarkup(
      <Badge color="humanWait" onClick={() => {}}>
        Button
      </Badge>
    )
    for (const html of [link, button]) {
      expect(html).toContain(BADGE_COLORS.humanWait)
      expect(html).toContain('hover:bg-status-human-wait-badge-hover')
    }
    expect(link).toContain('href="/inbox"')
    expect(button).toContain('type="button"')
  })
})
