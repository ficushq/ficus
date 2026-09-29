import { expect, test } from 'bun:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { acquireDomHarness } from '../../test/domHarness'
import { useGraphModulesReady } from './useGraphModulesReady'

for (const resolveBeforeToggle of [true, false]) {
  test(`3D labels become ready when modules resolve ${resolveBeforeToggle ? 'before' : 'after'} the 3D toggle`, async () => {
    const harness = await acquireDomHarness({ url: 'https://ficus.test' })
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const sprite = Promise.withResolvers<void>()
    const group = Promise.withResolvers<void>()
    const modules = Promise.all([sprite.promise, group.promise])
    function Consumer({ is3D }: { is3D: boolean }) {
      const ready = useGraphModulesReady(is3D, modules)
      return <output>{is3D && ready ? '3D labels' : 'not ready'}</output>
    }
    try {
      await act(async () => {
        root.render(<Consumer is3D={false} />)
      })
      if (resolveBeforeToggle) {
        await act(async () => {
          sprite.resolve()
          group.resolve()
          await modules
        })
        expect(container.textContent).toBe('not ready')
      }
      await act(async () => {
        root.render(<Consumer is3D />)
      })
      if (!resolveBeforeToggle) {
        await act(async () => {
          sprite.resolve()
          await sprite.promise
        })
        expect(container.textContent).toBe('not ready') // Group must also be ready.
        await act(async () => {
          group.resolve()
          await modules
        })
      }
      expect(container.textContent).toBe('3D labels')
      await act(async () => {
        root.render(<Consumer is3D={false} />)
      })
      await act(async () => {
        root.render(<Consumer is3D />)
      })
      expect(container.textContent).toBe('3D labels')
    } finally {
      await act(async () => {
        root.unmount()
        sprite.resolve()
        group.resolve()
        await modules
      })
      await harness.cleanup()
    }
  })
}

test('disabled graph does not receive late readiness updates', async () => {
  const harness = await acquireDomHarness({ url: 'https://ficus.test' })
  const root = createRoot(document.createElement('div'))
  const modules = Promise.withResolvers<void>()
  const renders: boolean[] = []
  function Consumer({ enabled }: { enabled: boolean }) {
    renders.push(useGraphModulesReady(enabled, modules.promise))
    return null
  }
  try {
    await act(async () => {
      root.render(<Consumer enabled />)
    })
    await act(async () => {
      root.render(<Consumer enabled={false} />)
    })
    const count = renders.length
    await act(async () => {
      modules.resolve()
      await modules.promise
    })
    expect(renders).toHaveLength(count)
    expect(renders.every((ready) => !ready)).toBe(true)
  } finally {
    await act(async () => {
      root.unmount()
      modules.resolve()
      await modules.promise
    })
    await harness.cleanup()
  }
})
