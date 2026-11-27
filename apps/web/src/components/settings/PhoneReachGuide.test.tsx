import { afterEach, expect, test } from 'bun:test'
import { act } from 'react'
import { fireEvent, getAllByRole, getByRole, queryAllByRole, queryByRole } from '@testing-library/dom'
import { acquireDomHarness } from '../../test/domHarness'
import type { AddressCheckResult, PhoneReachReport } from '../../api/publicUrl'
import { PhoneReachGuideView } from './PhoneReachGuide'

let cleanup: (() => Promise<void>) | undefined
afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
})

const report = (patch: Partial<PhoneReachReport> = {}): PhoneReachReport => ({
  current: { url: 'http://localhost:3000', reach: 'this-computer', https: false },
  listening: { host: '127.0.0.1', port: 3000, beyondThisComputer: false },
  homeNetwork: { addresses: ['http://studio-mac.local:3000', 'http://192.168.1.20:3000'] },
  tailscale: { state: 'not-installed', cli: null, serveCommand: 'tailscale serve --bg http://127.0.0.1:3000' },
  ...patch,
})

async function render(props: {
  report: PhoneReachReport
  canWrite?: boolean
  check?: AddressCheckResult | null
  onUse?: (url: string) => void
  onCheck?: () => void
}) {
  const dom = await acquireDomHarness({ url: 'http://localhost:3000/settings?section=server-address' })
  cleanup = () => dom.cleanup()
  const container = document.createElement('div')
  document.body.append(container)
  const { createRoot } = await import('react-dom/client')
  await act(async () => {
    createRoot(container).render(
      <PhoneReachGuideView
        report={props.report}
        canWrite={props.canWrite ?? true}
        check={props.check ?? null}
        checking={false}
        onUse={props.onUse ?? (() => undefined)}
        onCheck={props.onCheck ?? (() => undefined)}
      />
    )
  })
  return container
}

test('an address that only works on this computer says so, and offers three ways to fix it', async () => {
  const container = await render({ report: report() })
  const text = container.textContent ?? ''
  expect(text).toContain('Reach this server from a mobile device')
  expect(text).toContain('The current address only works on this computer.')
  for (const option of ['At home, on the same Wi-Fi', 'Anywhere, with Tailscale', 'Anywhere, with your own domain'])
    expect(text).toContain(option)
  // A paid relay is not offered here.
  expect(text).not.toMatch(/relay/i)
})

test('home network: lists this machine’s addresses to use, and says when the server is not listening yet', async () => {
  const used: string[] = []
  const container = await render({ report: report(), onUse: (url) => used.push(url) })
  const text = container.textContent ?? ''
  expect(text).toContain('http://studio-mac.local:3000')
  expect(text).toContain('This server is listening on this computer only')
  expect(text).toContain('HOST=0.0.0.0')
  expect(text).toContain('not encrypted')
  const use = getAllByRole(container, 'button', { name: /Use this address/ })
  await act(async () => {
    fireEvent.click(use[0]!)
  })
  expect(used).toEqual(['http://studio-mac.local:3000'])
})

test('a server already listening on the network does not get the HOST advice', async () => {
  const container = await render({
    report: report({ listening: { host: '0.0.0.0', port: 3000, beyondThisComputer: true } }),
  })
  expect(container.textContent).not.toContain('HOST=0.0.0.0')
})

test('Tailscale running: the one command to run, then its HTTPS address to use', async () => {
  const used: string[] = []
  const container = await render({
    report: report({
      tailscale: {
        state: 'running',
        cli: 'path',
        address: 'https://studio-mac.tail1234.ts.net',
        serveCommand: 'tailscale serve --bg http://127.0.0.1:3000',
      },
    }),
    onUse: (url) => used.push(url),
  })
  expect(container.textContent).toContain('tailscale serve --bg http://127.0.0.1:3000')
  expect(container.textContent).toContain('The mobile device needs the Tailscale app')
  const use = getAllByRole(container, 'button', { name: /Use this address/ })
  await act(async () => {
    fireEvent.click(use[use.length - 1]!)
  })
  expect(used).toEqual(['https://studio-mac.tail1234.ts.net'])
})

test('Tailscale missing or signed out: says which, with where to get it', async () => {
  const missing = await render({ report: report() })
  expect(missing.textContent).toContain('Tailscale was not found on this machine.')
  expect(getByRole(missing, 'link', { name: /Get Tailscale/ }).getAttribute('href')).toBe(
    'https://tailscale.com/download'
  )
  await cleanup?.()
  const stopped = await render({
    report: report({
      tailscale: { state: 'stopped', cli: 'path', serveCommand: 'tailscale serve --bg http://127.0.0.1:3000' },
    }),
  })
  expect(stopped.textContent).toContain('Tailscale is installed but not connected.')
})

test('own domain: a proxy snippet with this server’s port, and the guide', async () => {
  const container = await render({
    report: report({ listening: { host: '127.0.0.1', port: 4100, beyondThisComputer: false } }),
  })
  expect(container.textContent).toContain('reverse_proxy 127.0.0.1:4100')
  expect(getByRole(container, 'link', { name: /Reverse proxy guide/ }).getAttribute('href')).toBe(
    'https://docs.ficus.sh/self-host/runtime-and-access/'
  )
})

test('checking the current address: asks, then reports the answer in plain words', async () => {
  let asked = 0
  const idle = await render({
    report: report({ current: { url: 'https://ficus.example.com', reach: 'public', https: true } }),
    onCheck: () => asked++,
  })
  await act(async () => {
    fireEvent.click(getByRole(idle, 'button', { name: 'Check this address' }))
  })
  expect(asked).toBe(1)
  await cleanup?.()
  const ok = await render({
    report: report({ current: { url: 'https://ficus.example.com', reach: 'public', https: true } }),
    check: { ok: true },
  })
  expect(getByRole(ok, 'status').textContent).toContain('This address leads back to this server.')
  expect(getByRole(ok, 'status').textContent).toContain('a mobile device on another network can still be blocked')
  await cleanup?.()
  const other = await render({
    report: report({ current: { url: 'https://ficus.example.com', reach: 'public', https: true } }),
    check: { ok: false, reason: 'not-this-server' },
  })
  expect(getByRole(other, 'status').textContent).toContain(
    'Something answered at that address, but it was not this server.'
  )
})

test('someone who can read but not change settings sees the guide without its buttons', async () => {
  const container = await render({ report: report(), canWrite: false })
  expect(queryAllByRole(container, 'button', { name: /Use this address/ })).toHaveLength(0)
  expect(queryByRole(container, 'button', { name: 'Check this address' })).toBeNull()
  expect(container.textContent).toContain('http://studio-mac.local:3000')
})

test('Tailscale always links out: where to set it up, and its own guide to serving an app', async () => {
  for (const tailscale of [
    { state: 'not-installed', cli: null, serveCommand: 'tailscale serve --bg http://127.0.0.1:3000' },
    {
      state: 'running',
      cli: 'path',
      address: 'https://a.ts.net',
      serveCommand: 'tailscale serve --bg http://127.0.0.1:3000',
    },
  ] as const) {
    const container = await render({ report: report({ tailscale }) })
    expect(getByRole(container, 'link', { name: /Get Tailscale/ }).getAttribute('href')).toBe(
      'https://tailscale.com/download'
    )
    expect(getByRole(container, 'link', { name: /Tailscale Serve guide/ }).getAttribute('href')).toBe(
      'https://tailscale.com/docs/features/tailscale-serve'
    )
    await cleanup?.()
  }
})

test('the Mac app without its command-line tool: the command uses the copy inside the app, and says why', async () => {
  const app = '/Applications/Tailscale.app/Contents/MacOS/Tailscale'
  const container = await render({
    report: report({
      tailscale: {
        state: 'running',
        cli: 'app',
        address: 'https://studio-mac.tail1234.ts.net',
        serveCommand: `${app} serve --bg http://127.0.0.1:3000`,
      },
    }),
  })
  expect(container.textContent).toContain(`${app} serve --bg http://127.0.0.1:3000`)
  expect(container.textContent).toContain('command-line tool is not installed')
  // On PATH there is nothing to explain.
  await cleanup?.()
  const onPath = await render({
    report: report({
      tailscale: {
        state: 'running',
        cli: 'path',
        address: 'https://a.ts.net',
        serveCommand: 'tailscale serve --bg http://127.0.0.1:3000',
      },
    }),
  })
  expect(onPath.textContent).not.toContain('command-line tool is not installed')
})
