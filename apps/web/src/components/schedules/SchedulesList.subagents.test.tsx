import { describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'

import { SchedulesList } from './SchedulesList'

const dependencies = {
  useWebSocket: () => ({ subscribe: () => () => undefined, isConnected: false }),
}

function renderSchedulesList(initialEntry = '/') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  renderToStaticMarkup(
    <MemoryRouter initialEntries={[initialEntry]}>
      <QueryClientProvider client={queryClient}>
        <SchedulesList scopeType="agent" scopeId="parent-1" dependencies={dependencies} />
      </QueryClientProvider>
    </MemoryRouter>
  )
  return queryClient
    .getQueryCache()
    .getAll()
    .map((query) => query.queryKey)
}

describe('SchedulesList system schedules filter', () => {
  test('hides subagent watchdog schedules by default via excludeKind query param', () => {
    const seenKeys = renderSchedulesList()

    expect(JSON.stringify(seenKeys)).toContain('excludeKind')
    expect(JSON.stringify(seenKeys)).toContain('subagent-watchdog')
  })

  test('drops excludeKind when systemSchedules=1 is present in the URL state', () => {
    const seenKeys = renderSchedulesList('/?systemSchedules=1')

    expect(JSON.stringify(seenKeys)).not.toContain('excludeKind')
    expect(JSON.stringify(seenKeys)).not.toContain('subagent-watchdog')
  })
})
