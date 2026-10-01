import { describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ClaudeCodeStatus } from '../../api/providerAuth'
import { ClaudeCodeAccountSetup } from './ClaudeCodeAccountSetup'

const render = (status: ClaudeCodeStatus) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <ClaudeCodeAccountSetup status={status} onDone={() => {}} onCancel={() => {}} />
    </QueryClientProvider>
  )

const installed: ClaudeCodeStatus = {
  offered: true,
  enabled: false,
  installed: true,
  loggedIn: false,
  path: '/Users/me/.local/bin/claude',
}

describe('ClaudeCodeAccountSetup', () => {
  test('signed out: says to sign in, and which claude was checked', () => {
    const html = render({ ...installed, reason: 'Claude Code is not signed in' })
    expect(html).toContain('claude auth login')
    expect(html).toContain('/Users/me/.local/bin/claude')
  })

  test("couldn't read the sign-in: shows claude's error, not a sign-in prompt", () => {
    const html = render({
      ...installed,
      reason: "Could not read Claude Code's sign-in status",
      detail: 'exit 127: env: node: No such file or directory',
      candidates: ['/Users/me/.local/bin/claude', '/opt/homebrew/bin/claude'],
    })
    expect(html).toContain('role="alert"')
    expect(html).toContain('exit 127: env: node: No such file or directory')
    expect(html).toContain('Also found: /opt/homebrew/bin/claude')
    expect(html).not.toContain('claude auth login')
  })
})
