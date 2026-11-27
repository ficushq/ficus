import { describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { waitFor } from '@testing-library/dom'
import { MemoryRouter } from 'react-router'
import { acquireDomHarness } from '../test/domHarness'
import { apiUnavailable, type ApiRoutes } from '../test/apiMock'
import {
  WORKSPACE_FILE_FORBIDDEN,
  WORKSPACE_FILE_MISSING,
  WORKSPACE_FILE_NETWORK_ERROR,
  WORKSPACE_FILE_SERVER_ERROR,
} from '../lib/workflowAttachments'
import { WorkStreamFileCard } from './WorkStreamFileCard'
import { createAppQueryClient } from '../lib/appQueryClient'

const refusal = (status: number, error: string) => () => Response.json({ error }, { status })

/** Opens the viewer for a workspace file the server answers with `answer`, then hands over the page. */
async function openFile(
  answer: ApiRoutes[string],
  inspect: (page: { body: HTMLElement; act: (fn: () => Promise<void>) => Promise<void> }) => Promise<void>,
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
) {
  const routes: ApiRoutes = { '/api/squads/:id/workspace/file': answer }
  const dom = await acquireDomHarness({
    url: 'http://localhost/',
    api: routes,
    beforeUnmount: async () => queryClient.cancelQueries(),
    afterUnmount: () => queryClient.clear(),
  })
  try {
    const rendered = dom.createRoot()
    await dom.act(async () =>
      rendered.root.render(
        <MemoryRouter>
          <QueryClientProvider client={queryClient}>
            <WorkStreamFileCard filePath="docs/plan.md" squadId="squad-1" />
          </QueryClientProvider>
        </MemoryRouter>
      )
    )
    const body = dom.window.document.body
    await dom.act(async () => body.querySelector<HTMLButtonElement>('button[title="docs/plan.md"]')!.click())
    await inspect({ body, act: (fn) => dom.act(fn) })
  } finally {
    await dom.cleanup()
  }
}

const alertText = async (page: { body: HTMLElement; act: (fn: () => Promise<void>) => Promise<void> }) => {
  await page.act(async () => {
    await waitFor(() => expect(page.body.querySelector('[role="alert"]')).not.toBeNull())
  })
  return page.body.querySelector('[role="alert"]')!.textContent
}
const tryAgain = (body: HTMLElement) =>
  [...body.querySelectorAll('button')].find((button) => button.textContent === 'Try again')

describe('WorkStreamFileCard load errors', () => {
  test('says a refused file is about workspace access, not a missing file', async () => {
    await openFile(refusal(403, 'Forbidden'), async (page) => {
      expect(await alertText(page)).toBe(WORKSPACE_FILE_FORBIDDEN)
      expect(WORKSPACE_FILE_FORBIDDEN).toBe('You don’t have access to this squad’s workspace.')
      expect(tryAgain(page.body)).toBeUndefined()
    })
  })

  test('says a file that is not there may have been moved or deleted', async () => {
    for (const answer of [refusal(404, 'File not found'), refusal(400, 'Path is not a file')])
      await openFile(answer, async (page) => {
        expect(await alertText(page)).toBe(WORKSPACE_FILE_MISSING)
        expect(tryAgain(page.body)).toBeUndefined()
      })
  })

  test('offers to try again after a network failure, and shows the file once it loads', async () => {
    let reachable = false
    await openFile(
      () => (reachable ? { path: 'docs/plan.md', content: '# The plan', size: 10, binary: false } : apiUnavailable),
      async (page) => {
        expect(await alertText(page)).toBe(WORKSPACE_FILE_NETWORK_ERROR)
        reachable = true
        await page.act(async () => tryAgain(page.body)!.click())
        await page.act(async () => {
          await waitFor(() => expect(page.body.textContent).toContain('The plan'))
        })
        expect(page.body.querySelector('[role="alert"]')).toBeNull()
      }
    )
  })

  test('waits for a sandbox that cannot be provisioned yet instead of failing', async () => {
    let reads = 0
    const provisioning = () => {
      reads++
      return Response.json(
        { error: 'Sandbox scheduling is temporarily unavailable.', code: 'SANDBOX_PROVISION_UNAVAILABLE' },
        { status: 503, headers: { 'Retry-After': '75' } }
      )
    }
    // The app's own client: its retry policy waits out the 75-second cooldown Core asked for.
    await openFile(
      provisioning,
      async (page) => {
        await page.act(async () => {
          await waitFor(() => expect(page.body.textContent).toContain('The workspace is starting'))
        })
        expect(page.body.textContent).toContain('This file will load as soon as it is ready')
        expect(page.body.querySelector('[role="alert"]')).toBeNull()
        expect(reads).toBe(1)
      },
      createAppQueryClient()
    )
  })

  test('says a server failure is temporary rather than calling the file missing', async () => {
    await openFile(refusal(500, 'Failed to read file'), async (page) => {
      expect(await alertText(page)).toBe(WORKSPACE_FILE_SERVER_ERROR)
      expect(tryAgain(page.body)).toBeDefined()
    })
  })
})
