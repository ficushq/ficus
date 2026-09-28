import { afterEach, beforeEach, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent } from '@testing-library/dom'
import type { GitHubRepositoryAccess as Access } from '@ficus/shared'
import { acquireDomHarness } from '../../test/domHarness'
import { integrationQueryKeys } from '../../queryKeys'
import { palettes } from '../../theme/test/builtins'
import { GitHubRepositoryAccess } from './GitHubRepositoryAccess'

let harness: Awaited<ReturnType<typeof acquireDomHarness>>
let client: QueryClient
let originalFetch: typeof fetch
beforeEach(async () => {
  harness = await acquireDomHarness({ url: 'http://localhost/settings' })
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  originalFetch = globalThis.fetch
})
afterEach(async () => {
  await harness.cleanup()
  client.clear()
  globalThis.fetch = originalFetch
})
const missing: Access = { status: 'missing', complete: true, personalAccountInstalled: false, installations: [] }
async function render(data: Access, usesFicusApp = true) {
  client.setQueryData(integrationQueryKeys.githubRepositoryAccess('account'), data)
  const { root, container } = harness.createRoot()
  await harness.act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <GitHubRepositoryAccess connectionId="account" login="example" usesFicusApp={usesFicusApp} />
      </QueryClientProvider>
    )
  )
  return container
}
test('missing installation gives a prominent grant-access action and explicit personal fork warning', async () => {
  const container = await render(missing)
  expect(container.textContent).toContain('Setup needs repository access')
  expect(container.textContent).toContain('The App is not installed on example')
  const link = container.querySelector('a')!
  expect(link.className).toContain('ficus-button-primary')
  expect(link.href).toBe('https://github.com/apps/ficus-integration/installations/new')
  expect(link.target).toBe('_blank')
})
test('organization access does not hide missing access to personal forks', async () => {
  const container = await render({
    ...missing,
    status: 'verified',
    installations: [
      { account: 'org', repositoryCount: 2, contentsWrite: true, workflowsWrite: false, suspended: false },
    ],
  })
  expect(container.textContent).toContain('org: 2 accessible repositories')
  expect(container.textContent).toContain('Workflows: write permission missing')
  expect(container.textContent).toContain('The App is not installed on example')
})
test('unknown results prompt retry without falsely reporting a missing installation', async () => {
  const container = await render({ ...missing, status: 'unknown', complete: false, personalAccountInstalled: null })
  expect(container.textContent).toContain('Could not fully verify')
  expect(container.textContent).not.toContain('The App is not installed')
})
test('custom Apps link to installation management instead of installing the Ficus App', async () => {
  const container = await render(missing, false)
  expect(container.querySelector('a')!.href).toBe('https://github.com/settings/installations')
})
test('checking again replaces missing-access guidance with verified results', async () => {
  const container = await render(missing)
  globalThis.fetch = (async () =>
    Response.json({
      ...missing,
      status: 'verified',
      personalAccountInstalled: true,
      installations: [
        { account: 'example', repositoryCount: 1, contentsWrite: true, workflowsWrite: true, suspended: false },
      ],
    })) as typeof fetch
  await harness.act(async () => {
    fireEvent.click(container.querySelector('button')!)
    await new Promise((resolve) => setTimeout(resolve, 10))
  })
  expect(container.textContent).toContain('Repository access verified')
  expect(container.textContent).not.toContain('The App is not installed')
})

test('a failed recheck does not keep presenting stale installation conclusions', async () => {
  const container = await render(missing)
  globalThis.fetch = (async () => Response.json({ error: 'Unavailable' }, { status: 503 })) as typeof fetch
  await harness.act(async () => {
    fireEvent.click(container.querySelector('button')!)
    await new Promise((resolve) => setTimeout(resolve, 10))
  })
  expect(container.textContent).toContain('Could not fully verify repository access')
  expect(container.textContent).not.toContain('The App is not installed')
  expect(container.textContent).not.toContain('Repository access verified')
})

test('both repository warnings retain the original light600 and dark400 attention colors', async () => {
  const container = await render(missing)
  const warnings = [...container.querySelectorAll('p')].filter((node) =>
    /Setup needs repository access|The App is not installed/.test(node.textContent!)
  )
  expect(warnings).toHaveLength(2)
  for (const warning of warnings) {
    expect(warning.classList.contains('text-status-attention-600')).toBe(true)
    expect(warning.classList.contains('dark:text-status-attention-400')).toBe(true)
    expect(warning.classList.contains('text-status-attention-fg')).toBe(false)
    for (const palette of palettes) {
      const dark = palette.appearance === 'dark'
      expect(palette.tokens[`--status-attention-${dark ? '400' : '600'}`]).toBe(dark ? '251 191 36' : '217 119 6')
    }
  }
})
