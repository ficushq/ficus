import { describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ClaudeCodeStatus, ProviderAuthEntry } from '../../api/providerAuth'
import { ProviderAccountsList, ProviderRow } from './ProviderAuthSection'

const anthropic = { id: 'anthropic', name: 'Anthropic / Claude Code', description: 'Claude models' }
const signedIn: ClaudeCodeStatus = { offered: true, enabled: false, installed: true, loggedIn: true }

const render = (node: ReactNode) =>
  renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>)

describe('Claude Code on the Anthropic card', () => {
  test('Connect account offers Claude Code alongside an API key where it is offered', () => {
    const html = render(
      <ProviderRow provider={anthropic} oauthAvailable={false} claudeCode={signedIn} canWrite setup />
    )
    expect(html).toContain('Claude Code (your Claude plan)')
    expect(html).toContain('API key')
  })

  test('without Claude Code (Ficus Cloud) it goes straight to the API key form', () => {
    const html = render(<ProviderRow provider={anthropic} oauthAvailable={false} canWrite setup />)
    expect(html).not.toContain('Claude Code (your Claude plan)')
    expect(html).toContain('Enter API key')
  })

  test('the Claude Code account row says when claude is signed out', () => {
    const accounts = [
      {
        id: 'acc_claude_code',
        label: 'Claude Code (your Claude plan)',
        enabled: true,
        type: 'api_key',
        kind: 'claude-code',
      },
    ] as ProviderAuthEntry['accounts'] & object
    const signedOut = render(
      <ProviderAccountsList
        providerId="anthropic"
        accounts={accounts}
        canWrite={false}
        claudeCode={{ ...signedIn, loggedIn: false }}
      />
    )
    expect(signedOut).toContain('Claude Code on this computer')
    expect(signedOut).toContain('Not signed in')
    expect(
      render(<ProviderAccountsList providerId="anthropic" accounts={accounts} canWrite={false} claudeCode={signedIn} />)
    ).toContain('Available')
  })
})
