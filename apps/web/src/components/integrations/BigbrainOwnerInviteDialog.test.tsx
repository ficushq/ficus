import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { fireEvent } from '@testing-library/dom'
import { acquireDomHarness } from '../../test/domHarness'
import type { ManagedBigbrainVault } from '../../api/integrations'

let harness: Awaited<ReturnType<typeof acquireDomHarness>>
let root: import('react-dom/client').Root
let oldFetch: typeof globalThis.fetch
let requests: { url: string; body: string }[]
let expiresAt: string

const SECRET_FRAGMENT = 'S'.repeat(43)
const vault: ManagedBigbrainVault = {
  vaultId: '11111111-1111-4111-8111-111111111111',
  displayName: 'Research',
  ownerHandle: 'ficus',
  ownerLinksAvailable: true,
  state: 'ready',
  readAccess: 'active',
  desiredGeneration: 2,
  appliedGeneration: 2,
  upstreamVaultId: null,
  origin: null,
  connectionId: null,
  lastErrorCode: null,
  retryable: false,
  pendingAction: null,
  backup: 'unknown',
  assignedSquads: [],
  updatedAt: '2026-10-20T00:00:00.000Z',
}

beforeEach(async () => {
  harness = await acquireDomHarness({ url: 'http://localhost' })
  ;({ root } = harness.createRoot())
  oldFetch = globalThis.fetch
  requests = []
  expiresAt = new Date(Date.now() + 3_600_000).toISOString()
  globalThis.fetch = (async (input, init) => {
    requests.push({ url: String(input), body: String(init?.body ?? '') })
    return Response.json({
      inviteUrl: `https://bb-${'1'.repeat(32)}.vaults.example.com/invite#${SECRET_FRAGMENT}`,
      expiresAt,
    })
  }) as typeof fetch
})
afterEach(async () => {
  globalThis.fetch = oldFetch
  await harness.cleanup()
})

async function settle() {
  for (let i = 0; i < 3; i++) {
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}
async function render(isOpen: boolean) {
  const { BigbrainOwnerInviteDialog } = await import('./BigbrainOwnerInviteDialog')
  await harness.act(async () => {
    root.render(<BigbrainOwnerInviteDialog vault={vault} isOpen={isOpen} onClose={() => {}} />)
    await settle()
  })
}
const createButton = () => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Create device link')!

describe('BigbrainOwnerInviteDialog', () => {
  test('requests a link only on an explicit click, with the vault’s current generation', async () => {
    await render(true)
    expect(requests).toHaveLength(0)
    const text = document.body.textContent!
    // The trade-off is stated before any link exists: full owner access, one shared identity.
    expect(text).toContain('Connect owner device to')
    expect(text).toContain('as its owner, ficus')
    expect(text).toContain('reads and writes everything and manages members')
    expect(text).toContain('Anyone holding the link gets that access')
    expect(text).toContain('Everyone who connects this way writes as the same owner')
    expect(text).toContain('invite them as members from the BigBrain app')
    expect(text).toContain('Ficus records who created each link')
    expect(text).not.toMatch(/\byour?\b/i)
    await harness.act(async () => {
      fireEvent.click(createButton())
      await settle()
    })
    expect(requests).toHaveLength(1)
    expect(new URL(requests[0]!.url).pathname).toBe(
      `/api/integrations/providers/bigbrain/shared-vaults/${vault.vaultId}/owner-invite`
    )
    expect(JSON.parse(requests[0]!.body)).toEqual({ requestId: expect.any(String), expectedGeneration: 2 })
    const field = document.querySelector<HTMLInputElement>('input[aria-label="Owner device link"]')!
    expect(field.value).toContain(SECRET_FRAGMENT)
    // Never a navigable link.
    expect(document.querySelector(`a[href*="${SECRET_FRAGMENT}"]`)).toBeNull()
  })

  test('closing forgets the link; reopening requires a new explicit request', async () => {
    await render(true)
    await harness.act(async () => {
      fireEvent.click(createButton())
      await settle()
    })
    await render(false)
    await render(true)
    expect(document.querySelector('input[aria-label="Owner device link"]')).toBeNull()
    expect(createButton()).toBeTruthy()
    expect(requests).toHaveLength(1)
  })

  test('tells the owner what to do if the app cannot use the link', async () => {
    await render(true)
    await harness.act(async () => {
      fireEvent.click(createButton())
      await settle()
    })
    expect(document.body.textContent).toContain('Each link works once')
    expect(document.body.textContent).toContain('create a new link')
  })

  test('an unreachable vault creates no link and says so, without echoing server text', async () => {
    globalThis.fetch = (async (input, init) => {
      requests.push({ url: String(input), body: String(init?.body ?? '') })
      return Response.json({ code: 'tls_unavailable', retryable: false, detail: SECRET_FRAGMENT }, { status: 502 })
    }) as typeof fetch
    await render(true)
    await harness.act(async () => {
      fireEvent.click(createButton())
      await settle()
    })
    expect(document.querySelector('input[aria-label="Owner device link"]')).toBeNull()
    const alert = document.querySelector('[role="alert"]')!
    expect(alert.textContent).toContain('not reachable at its address yet, so no link was created')
    expect(document.body.textContent).not.toContain(SECRET_FRAGMENT)
    expect(createButton()).toBeTruthy()
  })

  test('an expired link is withdrawn', async () => {
    expiresAt = new Date(Date.now() + 20).toISOString()
    await render(true)
    await harness.act(async () => {
      fireEvent.click(createButton())
      await settle()
    })
    await harness.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40))
      await settle()
    })
    expect(document.querySelector('input[aria-label="Owner device link"]')).toBeNull()
    expect(document.body.textContent).toContain('That link expired')
  })
})
