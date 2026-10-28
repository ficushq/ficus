import { expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { queryKeys } from '../../queryKeys'
import { SquadEnvConfig } from './SquadEnvConfig'

test('Workspace renders only custom environment settings and explains agent/terminal visibility', () => {
  const queryClient = new QueryClient()
  queryClient.setQueryData(['squads', 's1', 'workspace-env'], { content: 'CUSTOM=keep' })
  queryClient.setQueryData(queryKeys.auth.permissions('s1'), { permissions: ['env:read', 'env:write'] })
  const html = renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <SquadEnvConfig squadId="s1" />
    </QueryClientProvider>
  )
  expect(html).toContain('Environment Variables')
  expect(html).toContain('visible to agents and terminals')
  expect(html).not.toContain('Secret Store')
  expect(html).not.toContain('exposed secrets')
  expect(html).toContain('<textarea')
})
