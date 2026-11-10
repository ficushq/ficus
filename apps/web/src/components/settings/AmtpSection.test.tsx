import { describe, test, expect } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { queryKeys } from '../../queryKeys'

import { AmtpSection } from './AmtpSection'

const peer = {
  id: 'p1',
  localAlias: 'acme',
  instanceId: 'acme-id',
  baseUrl: 'https://acme/api',
  publicKeyPem: 'x',
  status: 'active',
  createdAt: new Date(),
}

function render(permissions: string[]): string {
  const qc = new QueryClient()
  qc.setQueryData(queryKeys.amtp.peers(), [peer])
  qc.setQueryData(queryKeys.auth.permissions(undefined), { permissions })
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <AmtpSection />
      </MemoryRouter>
    </QueryClientProvider>
  )
}

describe('AmtpSection', () => {
  test('renders the section heading and reads the centralized peers cache', () => {
    const html = render([])
    expect(html.toLowerCase()).toContain('federation')
    expect(html).toContain('acme')
  })

  test('shows an Edit affordance for amtp:write operators', () => {
    const html = render(['amtp:write'])
    expect(html).toContain('>Edit<')
  })

  test('hides Edit/Remove for read-only viewers', () => {
    const html = render([])
    expect(html).not.toContain('>Edit<')
    expect(html).not.toContain('>Remove<')
  })
})
