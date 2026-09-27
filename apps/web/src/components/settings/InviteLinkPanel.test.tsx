import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { acquireDomHarness } from '../../test/domHarness'
import type { IssuedInviteLink } from './InviteLinkPanel'

const LINK = 'https://tau.example/register?token=invite%2Btoken'

describe('InviteLinkPanel', () => {
  let dom: Awaited<ReturnType<typeof acquireDomHarness>>
  let container: HTMLDivElement
  let root: ReturnType<typeof dom.createRoot>['root']
  let InviteLinkPanel: typeof import('./InviteLinkPanel').InviteLinkPanel
  let location = ''

  function LocationProbe() {
    const current = useLocation()
    location = current.pathname + current.search
    return null
  }

  beforeEach(async () => {
    dom = await acquireDomHarness({ url: 'http://localhost/settings' })
    ;({ InviteLinkPanel } = await import('./InviteLinkPanel'))
    ;({ container, root } = dom.createRoot())
  })

  afterEach(async () => {
    delete window.tauDesktopApp
    await dom.cleanup()
  })

  function useDesktop() {
    window.tauDesktopApp = {
      version: 1,
      notificationsEnabled: async () => false,
      deliverNotifications: async () => {},
    }
  }

  function useRemoteDesktop() {
    window.tauDesktopApp = {
      version: 1,
      notificationsEnabled: async () => false,
      deliverNotifications: async () => {},
      instance: { kind: 'remote', name: 'noah' },
    }
  }

  async function render(invite: IssuedInviteLink) {
    await dom.act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/settings?section=users']}>
          <InviteLinkPanel invite={invite} onDone={() => {}} />
          <LocationProbe />
        </MemoryRouter>
      )
    })
  }

  const button = (label: string) => [...container.querySelectorAll('button')].find((b) => b.textContent === label)

  test('inside Ficus Desktop, a pending admin invite opens in this window through the app route', async () => {
    useDesktop()
    await render({ url: LINK, forAdmin: true })

    expect(button('Copy')).toBeDefined()
    expect(container.textContent).toContain('can’t be used in Ficus Desktop')
    await dom.act(async () => {
      button('Open in Ficus')!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })

    expect(location).toBe('/register?token=invite%2Btoken')
  })

  test('in a browser, a pending admin invite keeps only Copy', async () => {
    await render({ url: LINK, forAdmin: true })

    expect(button('Copy')).toBeDefined()
    expect(button('Open in Ficus')).toBeUndefined()
  })

  test('inside Ficus Desktop, an ordinary invite keeps only Copy', async () => {
    useDesktop()
    await render({ url: LINK, forAdmin: false })

    expect(button('Copy')).toBeDefined()
    expect(button('Open in Ficus')).toBeUndefined()
  })

  test('for a remote Desktop instance, a pending admin invite keeps only Copy', async () => {
    useRemoteDesktop()
    await render({ url: LINK, forAdmin: true })

    expect(button('Copy')).toBeDefined()
    expect(button('Open in Ficus')).toBeUndefined()
  })
})
