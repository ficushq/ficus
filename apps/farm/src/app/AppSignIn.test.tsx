import { afterEach, describe, expect, it, mock } from 'bun:test'
import { act } from 'react'
import { appToFarmMessage, parseFarmToAppMessage } from '@ficus/shared/farm-embed'
import { resetEmbedForTests } from '../embed/embed'
import { fakeMultiplayer, renderWith } from '../multiplayer/testing'
import { AppSignIn } from './App'

const originalFetch = globalThis.fetch
const mounted: Array<() => void> = []

afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount()
  resetEmbedForTests()
  delete window.ReactNativeWebView
  globalThis.fetch = originalFetch
})

async function signIn(exchangeStatus: number) {
  const posted: string[] = []
  window.ReactNativeWebView = { postMessage: (message: string) => void posted.push(message) }
  globalThis.fetch = (async () => new Response('{}', { status: exchangeStatus })) as unknown as typeof fetch
  const onSignedIn = mock(() => {})
  const view = await renderWith(<AppSignIn onSignedIn={onSignedIn} />, await fakeMultiplayer())
  mounted.push(view.unmount)
  const sendHandoff = async (code: string) =>
    act(async () => {
      window.dispatchEvent(
        new window.MessageEvent('message', { data: appToFarmMessage({ type: 'handoff', code }) }) as unknown as Event
      )
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  return { posted: () => posted.map((m) => parseFarmToAppMessage(m)), onSignedIn, view, sendHandoff }
}

describe('AppSignIn', () => {
  it('asks the app once, then signs in with the code it sends', async () => {
    const { posted, onSignedIn, view, sendHandoff } = await signIn(200)
    expect(posted()).toEqual([{ type: 'auth-required' }])
    expect(view.container.textContent).toContain('Signing you in')
    await sendHandoff('ficus_wh_abc')
    expect(onSignedIn).toHaveBeenCalledTimes(1)
    expect(posted()).toEqual([{ type: 'auth-required' }])
  })

  it('ignores a handoff posted by a frame inside the page', async () => {
    const { onSignedIn } = await signIn(200)
    let exchanges = 0
    globalThis.fetch = (async () => {
      exchanges++
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
    const frame = document.createElement('iframe')
    document.body.appendChild(frame)
    await act(async () => {
      window.dispatchEvent(
        new window.MessageEvent('message', {
          data: appToFarmMessage({ type: 'handoff', code: 'ficus_wh_theirs' }),
          source: frame.contentWindow as never,
        }) as unknown as Event
      )
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    frame.remove()
    expect(exchanges).toBe(0)
    expect(onSignedIn).not.toHaveBeenCalled()
  })

  it('exchanges one code at a time and signs in once', async () => {
    const { onSignedIn, sendHandoff } = await signIn(200)
    let exchanges = 0
    globalThis.fetch = (async () => {
      exchanges++
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
    await act(async () => {
      for (const code of ['ficus_wh_1', 'ficus_wh_2'])
        window.dispatchEvent(
          new window.MessageEvent('message', { data: appToFarmMessage({ type: 'handoff', code }) }) as unknown as Event
        )
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    await sendHandoff('ficus_wh_3')
    expect(exchanges).toBe(1)
    expect(onSignedIn).toHaveBeenCalledTimes(1)
  })

  it('offers to try again when the code does not work', async () => {
    const { posted, onSignedIn, view, sendHandoff } = await signIn(401)
    await sendHandoff('ficus_wh_used')
    expect(onSignedIn).not.toHaveBeenCalled()
    const retry = [...view.container.querySelectorAll('button')].find((b) => b.textContent === 'Try again')
    expect(retry).toBeDefined()
    await act(async () => retry!.click())
    expect(posted()).toEqual([{ type: 'auth-required' }, { type: 'auth-required' }])
  })
})
