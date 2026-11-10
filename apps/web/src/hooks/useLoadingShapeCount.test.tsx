import { afterEach, beforeEach, expect, test } from 'bun:test'
import { useEffect } from 'react'
import { acquireDomHarness } from '../test/domHarness'
import { getApiUrl } from '../api/client'
import { PermissionsProvider } from './usePermissions'
import { LoadingShapeScopeProvider, useLoadingShapeCount } from './useLoadingShapeCount'
import { readLoadingShapeCount, writeLoadingShapeCount } from '../lib/loadingShapeStorage'

let dom: Awaited<ReturnType<typeof acquireDomHarness>>
let root: import('react-dom/client').Root
let seen: number[]

const usePermissions = () => ({
  permissions: [],
  can: () => true,
  isLoading: false,
  isError: false,
  identity: { type: 'user' as const, userId: 'u1' },
})
const scope = () => `${getApiUrl()}|default|user:u1`

function Probe({ surface, live }: { surface: string; live: number | undefined }) {
  const count = useLoadingShapeCount(surface, live, { fallbackCount: 4, maxCount: 10 })
  useEffect(() => {
    seen.push(count)
  })
  return <span data-testid="count">{count}</span>
}

async function render(surface: string, live: number | undefined) {
  await dom.act(async () => {
    root.render(
      <PermissionsProvider usePermissions={usePermissions as never}>
        <LoadingShapeScopeProvider>
          <Probe surface={surface} live={live} />
        </LoadingShapeScopeProvider>
      </PermissionsProvider>
    )
  })
}
const shown = () => Number(dom.window.document.querySelector('[data-testid="count"]')?.textContent)

beforeEach(async () => {
  dom = await acquireDomHarness({ url: 'http://localhost/' })
  root = dom.createRoot().root
  seen = []
})
afterEach(async () => {
  await dom.cleanup()
})

test('remembers the live count per surface, keeps it while reloading and re-reads on a surface change', async () => {
  writeLoadingShapeCount(window.localStorage, scope(), 'schedules', 7, 10)
  writeLoadingShapeCount(window.localStorage, scope(), 'memory', 9, 10)

  await render('schedules', undefined)
  expect(shown()).toBe(7)

  await render('schedules', 3)
  expect(shown()).toBe(3)
  expect(readLoadingShapeCount(window.localStorage, scope(), 'schedules', 4, 10)).toBe(3)

  // A refetch that has no data yet keeps the last live count.
  await render('schedules', undefined)
  expect(shown()).toBe(3)

  await render('memory', undefined)
  expect(shown()).toBe(9)

  // Counts are bounded before they are shown or stored.
  await render('memory', 25)
  expect(shown()).toBe(10)
  expect(readLoadingShapeCount(window.localStorage, scope(), 'memory', 4, 10)).toBe(10)
})

test('an unknown surface shows the fallback count', async () => {
  await render('never-seen', undefined)
  expect(shown()).toBe(4)
  expect(seen.every((count) => count === 4)).toBe(true)
})
