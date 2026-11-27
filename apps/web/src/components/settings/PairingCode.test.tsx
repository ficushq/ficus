import { afterEach, expect, test } from 'bun:test'
import { act } from 'react'
import { queryByRole } from '@testing-library/dom'
import { acquireDomHarness } from '../../test/domHarness'
import { PairingCode } from './PairingCode'

let cleanup: (() => Promise<void>) | undefined
afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
})

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Mobile/15E148 Safari/604.1'

async function render({ userAgent, getAppLink }: { userAgent?: string; getAppLink?: boolean } = {}) {
  const dom = await acquireDomHarness({
    url: 'https://ficus.example.com/settings?section=devices',
    configureWindow(window) {
      if (userAgent) Object.defineProperty(window.navigator, 'userAgent', { value: userAgent, configurable: true })
      ;(window as unknown as { matchMedia: (query: string) => unknown }).matchMedia = (query: string) => ({
        matches: false,
        media: query,
      })
    },
  })
  cleanup = () => dom.cleanup()
  const container = document.createElement('div')
  document.body.append(container)
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(container)
  await act(async () => {
    root.render(
      <PairingCode
        pairing={{
          dataUrl: 'data:image/png;base64,AA==',
          deepLink: 'ficus://pair?url=x&code=y',
          expiresAt: Date.now() + 60_000,
          code: 'abc123',
        }}
        onExpired={() => undefined}
        onRegenerate={() => undefined}
        regenerating={false}
        getAppLink={getAppLink}
      />
    )
  })
  return container
}

test('on an iPhone, the same-phone link comes with a way to get the app from the App Store', async () => {
  const container = await render({ userAgent: IPHONE })
  expect(queryByRole(container, 'link', { name: /Open in Ficus app/ })?.getAttribute('href')).toBe(
    'ficus://pair?url=x&code=y'
  )
  expect(container.textContent).toContain('Don’t have the app?')
  const get = queryByRole(container, 'link', { name: /Get it on the App Store/ })
  expect(get?.getAttribute('href')).toBe('https://apps.apple.com/app/ficus-mobile/id6817527183')
  expect(get?.getAttribute('target')).toBe('_blank')
  expect(get?.getAttribute('rel')).toContain('noopener')
})

test('on a desktop browser there is no same-phone link and no install link', async () => {
  const container = await render()
  expect(queryByRole(container, 'link', { name: /Open in Ficus app/ })).toBeNull()
  expect(container.textContent).not.toContain('Don’t have the app?')
})

test('a page that offers the app itself can turn the install link off', async () => {
  const container = await render({ userAgent: IPHONE, getAppLink: false })
  expect(queryByRole(container, 'link', { name: /Open in Ficus app/ })).toBeTruthy()
  expect(container.textContent).not.toContain('Don’t have the app?')
})
