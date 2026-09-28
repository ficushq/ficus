import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { PUSH_CATEGORIES } from '@ficus/shared'
import { queries } from '../../queryOptions'
import { NotificationPreferences } from './NotificationPreferences'

function render(mutedEvents: string[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queries.notificationConfig.mine().queryKey, {
    showPreviews: true,
    pushEnabled: true,
    mutedEvents,
    pushEvents: PUSH_CATEGORIES.map((category) => category.id),
  })
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <NotificationPreferences />
    </QueryClientProvider>
  )
}

describe('NotificationPreferences', () => {
  it('renders every push category by label and description, never by raw id', () => {
    const html = render([])
    for (const category of PUSH_CATEGORIES) {
      expect(html).toContain(category.label)
      expect(html).toContain(category.description)
      expect(html).not.toContain(`>${category.id}<`)
    }
    expect(html).not.toContain('inbox.messageReceived')
  })

  it('reflects a muted category as an unchecked switch while others stay checked', () => {
    const html = render(['done'])
    const checkbox = (label: string) => {
      const match = html.match(new RegExp(`<input[^>]*aria-label="Notify about ${label}"[^>]*>`))
      expect(match).not.toBeNull()
      return match![0]
    }
    expect(checkbox('Completions')).not.toContain('checked')
    expect(checkbox('Review requests')).toContain('checked')
  })

  it('points at the per-squad and per-work-stream attention control', () => {
    expect(render([])).toContain(
      'Which squads and work streams notify you is set on each squad and work stream (Notify / Show / Mute).'
    )
  })
})
