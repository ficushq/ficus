import { afterEach, expect, test } from 'bun:test'
import { useState } from 'react'
import { acquireDomHarness } from '../test/domHarness'
import { useAdjustOnChange } from './useAdjustOnChange'

let dom: Awaited<ReturnType<typeof acquireDomHarness>> | undefined
afterEach(async () => {
  await dom?.cleanup()
  dom = undefined
})

test('runs once for each change of any dependency, with the previous list, and not on mount by default', async () => {
  dom = await acquireDomHarness({ url: 'http://localhost/' })
  const calls: Array<readonly unknown[] | undefined> = []
  function Probe({ a, b, onMount }: { a: string; b: number; onMount?: boolean }) {
    const [count, setCount] = useState(0)
    useAdjustOnChange(
      [a, b],
      (previous) => {
        calls.push(previous)
        setCount((value) => value + 1)
      },
      { onMount }
    )
    return <span data-count={count} />
  }
  const { root } = dom.createRoot()
  const count = () => dom!.window.document.querySelector('span')!.getAttribute('data-count')

  await dom.act(async () => root.render(<Probe a="x" b={1} />))
  expect(calls).toEqual([])
  await dom.act(async () => root.render(<Probe a="x" b={1} />))
  expect(calls).toEqual([])
  await dom.act(async () => root.render(<Probe a="y" b={1} />))
  expect(calls).toEqual([['x', 1]])
  await dom.act(async () => root.render(<Probe a="y" b={2} />))
  expect(calls).toEqual([
    ['x', 1],
    ['y', 1],
  ])
  expect(count()).toBe('2')
  await dom.act(async () => root.unmount())
})

test('with onMount the first render counts as a change', async () => {
  dom = await acquireDomHarness({ url: 'http://localhost/' })
  const calls: Array<readonly unknown[] | undefined> = []
  function Probe({ value }: { value: string | undefined }) {
    useAdjustOnChange([value], (previous) => calls.push(previous), { onMount: true })
    return null
  }
  const { root } = dom.createRoot()
  await dom.act(async () => root.render(<Probe value={undefined} />))
  expect(calls).toEqual([undefined])
  await dom.act(async () => root.render(<Probe value="a" />))
  expect(calls).toEqual([undefined, [undefined]])
  await dom.act(async () => root.unmount())
})
