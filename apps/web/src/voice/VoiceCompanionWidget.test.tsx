import { afterEach, expect, mock, test } from 'bun:test'
import type { ComponentProps } from 'react'
import { acquireDomHarness } from '../test/domHarness'
import { webkitTap } from '../test/webkitTap'
import { VoiceCompanionButton } from './VoiceCompanionWidget'

type Controls = ReturnType<
  NonNullable<ComponentProps<typeof VoiceCompanionButton>['dependencies']>['useVoiceAssistant']
>
let dom: Awaited<ReturnType<typeof acquireDomHarness>> | undefined
let restoreBrowser: (() => void) | undefined
afterEach(async () => {
  restoreBrowser?.()
  restoreBrowser = undefined
  await dom?.cleanup()
  dom = undefined
})

async function setup(props: Omit<ComponentProps<typeof VoiceCompanionButton>, 'dependencies'> = {}) {
  dom = await acquireDomHarness({ url: 'http://localhost/' })
  const navigator = dom.window.navigator
  const original = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices')
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: mock() } })
  restoreBrowser = () => {
    if (original) Object.defineProperty(navigator, 'mediaDevices', original)
    else Reflect.deleteProperty(navigator, 'mediaDevices')
  }
  const toggle = mock(() => {})
  const toggleMicMuted = mock(() => {})
  const interrupt = mock(() => {})
  let voice: Controls = {
    status: 'idle',
    history: [],
    error: null,
    toggle,
    restartFresh: async () => {},
    interrupt,
    isConnected: false,
    rateLimitRetry: null,
    isMicMuted: false,
    toggleMicMuted,
  }
  const { container, root } = dom.createRoot()
  const render = async (patch: Partial<Controls> = {}) => {
    voice = { ...voice, ...patch }
    await dom!.act(async () =>
      root.render(<VoiceCompanionButton {...props} dependencies={{ useVoiceAssistant: () => voice }} />)
    )
  }
  await render()
  const button = (text: string) =>
    [...dom!.window.document.querySelectorAll('button')].find((item) => item.textContent?.trim() === text)!
  return { container, toggle, toggleMicMuted, interrupt, render, button }
}

test('opening guidance does not start recording and the start control stays mounted while connecting', async () => {
  const { container, toggle, render, button } = await setup()
  await dom!.act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Voice assistant"]')!.click())
  expect(toggle).not.toHaveBeenCalled()
  const start = button('Start voice chat')
  expect(start).toBeDefined()
  await dom!.act(async () => start.click())
  expect(toggle).toHaveBeenCalledTimes(1)
  await render({ status: 'connecting' })
  expect(button('Starting voice chat…')).toBe(start)
  expect(start.disabled).toBe(true)
  await render({ status: 'error', error: 'Connection failed' })
  expect(button('Try again')).toBe(start)
  expect(start.disabled).toBe(false)
  expect(dom!.window.document.body.textContent).toContain('Connection failed')
})

test('embedded guidance has no draggable body label or duplicate connecting status', async () => {
  const { container, render, button } = await setup({ embedded: true })
  expect(container.querySelector('[data-assistant-drag-handle]')).toBeNull()
  const statusRow =
    container.querySelector<HTMLElement>('[role="status"]')!.parentElement!.parentElement!.parentElement!
  expect(statusRow.style.display).toBe('none')
  await render({ status: 'connecting' })
  expect(statusRow.style.display).toBe('none')
  expect(button('Starting voice chat…').disabled).toBe(true)
  await render({ status: 'listening', isConnected: true })
  expect(statusRow.style.display).toBe('')
})

test('expanded voice interrupts beside the current transcript response', async () => {
  const { container, render, interrupt } = await setup({ embedded: true, compactOverride: false })
  await render({
    status: 'speaking',
    isConnected: true,
    history: [
      { role: 'assistant', text: 'Earlier reply', final: true },
      { role: 'user', text: 'What is happening?', final: true },
      { role: 'assistant', text: 'Your squad is', final: false },
    ],
  })
  const stop = container.querySelector<HTMLButtonElement>('[aria-label="Stop response"]')!
  expect(stop.parentElement?.textContent).toContain('Your squad is')
  expect(stop.parentElement?.textContent).not.toContain('Earlier reply')
  await dom!.act(async () => stop.click())
  expect(interrupt).toHaveBeenCalledTimes(1)
  await render({ status: 'listening' })
  expect(container.querySelector('[aria-label="Stop response"]')).toBeNull()
})

test('connected voice floats compactly and stays available when interacting with the page', async () => {
  const { container, render } = await setup()
  await render({ status: 'listening', isConnected: true })
  const panel = dom!.window.document.querySelector<HTMLElement>('.ficus-voice-panel')!
  expect(panel.dataset.compact).toBe('true')
  const anchoredTop = panel.style.top
  expect(anchoredTop).not.toBe('')
  expect(container.contains(panel)).toBe(false)
  expect(panel.querySelector('[aria-label="Mute microphone"]')).not.toBeNull()
  expect(panel.querySelector('[aria-label="End chat"]')).not.toBeNull()
  await dom!.act(async () => panel.querySelector<HTMLButtonElement>('[aria-label="Expand voice assistant"]')!.click())
  expect(panel.dataset.compact).toBe('false')
  await dom!.act(async () =>
    dom!.window.document.body.dispatchEvent(new dom!.window.MouseEvent('pointerdown', { bubbles: true }))
  )
  expect(panel.dataset.compact).toBe('true')
  expect(panel.dataset.state).toBe('open')
  await render({ status: 'error', isConnected: false, error: 'Connection interrupted' })
  expect(panel.style.top).toBe(anchoredTop)
  expect(panel.dataset.compact).toBe('false')
})

test('voice keeps the Listening label and pulses the mic only while detecting speech', async () => {
  const { render } = await setup()
  await render({ status: 'listening', isConnected: true })
  const status = dom!.window.document.querySelector('[role="status"]')!
  expect(status.textContent).toBe('Listening')
  expect(dom!.window.document.querySelector('.motion-safe\\:animate-ping')).toBeNull()
  await render({ status: 'user-speaking' })
  expect(status.textContent).toBe('Listening')
  expect(dom!.window.document.querySelector('.motion-safe\\:animate-ping')).not.toBeNull()
  await render({ status: 'processing' })
  expect(status.textContent).toBe('Thinking')
  expect(dom!.window.document.querySelector('.motion-safe\\:animate-ping')).toBeNull()
  await render({ status: 'speaking' })
  expect(status.textContent).toBe('Speaking')
  await render({ status: 'listening' })
  expect(status.textContent).toBe('Listening')
})

test('compact embedded voice exposes mute, end, and expand in its status row', async () => {
  const onExpand = mock(() => {})
  const { container, render, toggle, toggleMicMuted } = await setup({ embedded: true, compactOverride: true, onExpand })
  await render({ status: 'listening', isConnected: true })
  const mic = container.querySelector<HTMLButtonElement>('[aria-label="Mute microphone"]')!
  expect(mic.getAttribute('aria-pressed')).toBe('false')
  await dom!.act(async () => mic.click())
  expect(toggleMicMuted).toHaveBeenCalledTimes(1)
  await render({ isMicMuted: true })
  expect(container.querySelector('[aria-label="Unmute microphone"]')?.getAttribute('aria-pressed')).toBe('true')
  await dom!.act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Expand assistant"]')!.click())
  expect(onExpand).toHaveBeenCalledTimes(1)
  await dom!.act(async () => container.querySelector<HTMLButtonElement>('[aria-label="End chat"]')!.click())
  expect(toggle).toHaveBeenCalledTimes(1)
})

test('reset reconnects in place without returning to the start guide', async () => {
  const onConnected = mock(() => {})
  const { container, render } = await setup({ embedded: true, onConnected })
  let finish!: () => void
  const restarting = new Promise<void>((resolve) => {
    finish = resolve
  })
  await render({ status: 'listening', isConnected: true, restartFresh: () => restarting })
  const reset = container.querySelector<HTMLButtonElement>('[aria-label="Reset voice conversation"]')!
  await dom!.act(async () => reset.click())
  await render({ status: 'connecting', isConnected: false })
  expect(container.querySelector('[role="status"]')?.textContent).toBe('Resetting…')
  expect(reset.disabled).toBe(true)
  expect(container.textContent).not.toContain('Starting voice chat')
  expect(container.textContent).not.toContain('Try asking')
  await render({ status: 'listening', isConnected: true })
  await dom!.act(async () => {
    finish()
    await restarting
  })
  expect(container.querySelector('[role="status"]')?.textContent).toBe('Listening')
  expect(reset.disabled).toBe(false)
  expect(onConnected).toHaveBeenCalledTimes(1)
})

test('the header panel takes WebKit taps, and an outside tap or Escape closes it idle and compacts it live', async () => {
  const { container, toggle, render, button } = await setup()
  const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Voice assistant"]')!
  const panel = () => dom!.window.document.querySelector<HTMLElement>('.ficus-voice-panel')!
  await dom!.act(async () => trigger.click())
  await dom!.act(async () => button('Start voice chat').focus())
  expect(await webkitTap(button('Start voice chat'), { touch: true })).toBe(true)
  expect(toggle).toHaveBeenCalledTimes(1)
  expect(panel().dataset.state).toBe('open')

  await webkitTap(dom!.window.document.body)
  expect(panel().dataset.state).toBe('closed')
  await dom!.act(async () => trigger.click())
  await dom!.act(async () =>
    dom!.window.document.dispatchEvent(new dom!.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  )
  expect(panel().dataset.state).toBe('closed')
  expect(dom!.window.document.activeElement).toBe(trigger)

  // Live and compact it is a persistent mini player: it neither dismisses nor claims Escape.
  await render({ status: 'listening', isConnected: true })
  expect(panel().dataset.compact).toBe('true')
  let escapes = 0
  dom!.window.document.addEventListener('keydown', () => escapes++)
  await dom!.act(async () =>
    dom!.window.document.dispatchEvent(new dom!.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  )
  expect(escapes).toBe(1)
  expect(panel().dataset.state).toBe('open')
})
