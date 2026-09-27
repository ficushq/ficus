import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { acquireDomHarness } from '../../test/domHarness'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { AuthApiProvider } from './authApi'

const demoPair = mock(async (_secret: string) => ({
  code: 'pair-code-1',
  serverUrl: 'https://demo.example.test',
  expiresAt: new Date(Date.now() + 90_000).toISOString(),
}))

mock.module('qrcode', () => ({
  default: { toDataURL: mock(async () => 'data:image/png;base64,QR') },
}))

describe('reviewer access page', () => {
  let dom: Awaited<ReturnType<typeof acquireDomHarness>>
  let container: HTMLDivElement
  let root: ReturnType<typeof dom.createRoot>['root']
  let DemoAccessPage: typeof import('./DemoAccessPage').DemoAccessPage

  beforeEach(async () => {
    dom = await acquireDomHarness({ url: 'http://localhost/demo' })
    ;({ DemoAccessPage } = await import('./DemoAccessPage'))
    ;({ container, root } = dom.createRoot())
    demoPair.mockClear()
  })

  afterEach(async () => {
    await dom.cleanup()
  })

  async function render(enabled: boolean) {
    await dom.act(async () => {
      root.render(
        <AuthApiProvider api={{ demoPair }}>
          <MemoryRouter initialEntries={['/demo']}>
            <Routes>
              <Route path="/demo" element={<DemoAccessPage enabled={enabled} />} />
              <Route path="/" element={<p>home</p>} />
            </Routes>
          </MemoryRouter>
        </AuthApiProvider>
      )
    })
  }

  async function submit(secret: string) {
    const input = container.querySelector<HTMLInputElement>('#demo-access-code')!
    await dom.act(async () => {
      // React tracks the value through the native setter; assigning the property would be ignored.
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, secret)
      input.dispatchEvent(new dom.window.InputEvent('input', { bubbles: true, inputType: 'insertText' }))
    })
    await dom.act(async () => {
      container
        .querySelector('form')!
        .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
    })
  }

  test('sends the visitor home when the instance has not opted in', async () => {
    await render(false)
    expect(container.textContent).toBe('home')
    expect(container.querySelector('#demo-access-code')).toBeNull()
  })

  test('turns the access code into a pairing QR without signing the browser in', async () => {
    await render(true)
    expect(container.textContent).toContain('Review Ficus')
    await submit('reviewer-secret')
    expect(demoPair).toHaveBeenCalledWith('reviewer-secret')
    expect(container.querySelector('img[alt="Pairing QR code"]')?.getAttribute('src')).toBe('data:image/png;base64,QR')
    expect(container.textContent).toContain('pair-code-1')
    expect(container.textContent).toContain('Expires in')
  })

  test('explains a rejected code and an unseeded instance without leaking anything else', async () => {
    demoPair.mockRejectedValueOnce(new Error('Invalid reviewer access code'))
    await render(true)
    await submit('wrong')
    expect(container.textContent).toContain('That access code was not accepted.')
    expect(container.querySelector('img')).toBeNull()

    demoPair.mockRejectedValueOnce(new Error('demo_not_seeded'))
    await submit('reviewer-secret')
    expect(container.textContent).toContain('ficus demo seed')
  })
})
