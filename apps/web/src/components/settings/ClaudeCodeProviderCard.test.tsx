import { describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { queryKeys } from '../../queryKeys'
import type { ClaudeCodeStatus } from '../../api/providerAuth'
import { ClaudeCodeProviderCard } from './ClaudeCodeProviderCard'

function render(status: ClaudeCodeStatus) {
  const qc = new QueryClient()
  qc.setQueryData(queryKeys.providerAuth.claudeCode(), status)
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <ClaudeCodeProviderCard canWrite />
    </QueryClientProvider>
  )
}

describe('ClaudeCodeProviderCard', () => {
  test('is absent on Ficus Cloud', () => {
    expect(render({ offered: false, enabled: false, installed: false, loggedIn: false })).toBe('')
  })

  test('is off until turned on, and shows the sign-in state, never a credential field', () => {
    const base = { offered: true, installed: true, loggedIn: true, subscriptionType: 'max' }
    expect(render({ ...base, enabled: false })).toContain('Off')
    const connected = render({ ...base, enabled: true })
    expect(connected).toContain('Claude Code')
    expect(connected).toContain('Connected')
    expect(connected).not.toContain('<input')
    expect(render({ ...base, enabled: true, loggedIn: false })).toContain('Not signed in')
    expect(render({ ...base, enabled: true, installed: false, loggedIn: false })).toContain('Not installed')
  })
})
