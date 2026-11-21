import { expect, test } from 'bun:test'
import { acquireDomHarness } from '../test/domHarness'
import { useAnimatedGraphPositions } from './useAnimatedGraphPositions'

test('layout animation interpolates shared coordinates and cancels its owned frame on unmount', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/' })
  const root = dom.createRoot()
  const originalRequest = globalThis.requestAnimationFrame
  const originalCancel = globalThis.cancelAnimationFrame
  const frames = new Map<number, FrameRequestCallback>()
  let nextId = 0
  globalThis.requestAnimationFrame = (callback) => {
    frames.set(++nextId, callback)
    return nextId
  }
  globalThis.cancelAnimationFrame = (id) => {
    frames.delete(id)
  }
  function Preview({ x, animate }: { x: number; animate: boolean }) {
    const positions = useAnimatedGraphPositions({ step: { x, y: 20 } }, animate)
    return <output>{positions.step!.x}</output>
  }
  const tick = async (time: number) =>
    dom.act(async () => {
      const pending = [...frames.values()]
      frames.clear()
      pending.forEach((callback) => callback(time))
    })
  try {
    await dom.act(async () => root.root.render(<Preview x={0} animate={false} />))
    await dom.act(async () => root.root.render(<Preview x={100} animate />))
    await tick(0)
    await tick(140)
    const x = Number(document.querySelector('output')!.textContent)
    expect(x).toBeGreaterThan(0)
    expect(x).toBeLessThan(100)
    await tick(280)
    expect(document.querySelector('output')!.textContent).toBe('100')
    expect(frames.size).toBe(0)
    await dom.act(async () => root.root.render(<Preview x={200} animate />))
    expect(frames.size).toBe(1)
    await dom.act(async () => root.root.render(null))
    expect(frames.size).toBe(0)
  } finally {
    globalThis.requestAnimationFrame = originalRequest
    globalThis.cancelAnimationFrame = originalCancel
    await dom.cleanup()
  }
})
