import { afterEach, expect, test } from 'bun:test'
import { act } from 'react'
import { fireEvent, getByRole, queryByRole } from '@testing-library/dom'
import { acquireDomHarness } from '../../test/domHarness'
import type { ServerAddressReach } from '../../api/publicUrl'
import { MobileAppStepView } from './MobileSetupSteps'

let cleanup: (() => Promise<void>) | undefined
afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
})

async function render(props: { reach: ServerAddressReach | null; paired?: number; onPair?: () => void }) {
  const dom = await acquireDomHarness({ url: 'http://localhost:3000/onboarding' })
  cleanup = () => dom.cleanup()
  const container = document.createElement('div')
  document.body.append(container)
  const { createRoot } = await import('react-dom/client')
  await act(async () => {
    createRoot(container).render(
      <MobileAppStepView
        reach={props.reach}
        paired={props.paired ?? 0}
        pairing={null}
        starting={false}
        error={null}
        onPair={props.onPair ?? (() => undefined)}
      />
    )
  })
  return container
}

test('until the server has an address a mobile device can open, the app step says to do that first', async () => {
  for (const reach of ['none', 'this-computer'] as const) {
    const container = await render({ reach })
    expect(container.textContent).toContain('First give this server an address a mobile device can open')
    expect(queryByRole(container, 'button', { name: 'Pair a device' })).toBeNull()
    await cleanup?.()
  }
})

test('with a reachable address: where to get the app, then pair from here', async () => {
  let asked = 0
  const container = await render({ reach: 'tailscale', onPair: () => asked++ })
  expect(getByRole(container, 'link', { name: /Get it from ficus\.sh/ }).getAttribute('href')).toBe(
    'https://ficus.sh/mobile#download'
  )
  await act(async () => {
    fireEvent.click(getByRole(container, 'button', { name: 'Pair a device' }))
  })
  expect(asked).toBe(1)
})

test('a home-network address pairs too, with the reminder that it only works on that network', async () => {
  const container = await render({ reach: 'home-network' })
  expect(getByRole(container, 'button', { name: 'Pair a device' })).toBeTruthy()
  expect(container.textContent).toContain('only while the mobile device is on the same network')
})

test('says when a mobile device is already paired', async () => {
  const one = await render({ reach: 'public', paired: 1 })
  expect(one.textContent).toContain('1 mobile device is paired.')
  await cleanup?.()
  const two = await render({ reach: 'public', paired: 2 })
  expect(two.textContent).toContain('2 mobile devices are paired.')
})

test('before the address is known, nothing is claimed either way', async () => {
  const container = await render({ reach: null })
  expect(container.textContent).not.toContain('First give this server')
  expect(queryByRole(container, 'button', { name: 'Pair a device' })).toBeNull()
})
