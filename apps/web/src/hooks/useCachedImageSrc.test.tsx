import { afterEach, expect, spyOn, test } from 'bun:test'
import { useEffect } from 'react'
import { waitFor } from '@testing-library/dom'
import { acquireDomHarness } from '../test/domHarness'
import { useCachedImageSrc } from './useCachedImageSrc'

let dom: Awaited<ReturnType<typeof acquireDomHarness>> | undefined
const restores: Array<() => void> = []
afterEach(async () => {
  for (const restore of restores.splice(0)) restore()
  await dom?.cleanup()
  dom = undefined
})

/** A Cache Storage that already holds the bytes for every image id. */
function installCaches() {
  const original = (globalThis as { caches?: unknown }).caches
  ;(globalThis as { caches?: unknown }).caches = {
    open: async () => ({
      match: async () => new Response(new Blob([new Uint8Array([1])])),
      put: async () => {},
    }),
  }
  restores.push(() => {
    ;(globalThis as { caches?: unknown }).caches = original
  })
}

test('shows the signed URL at once, upgrades to the cached blob, and starts over for another image', async () => {
  installCaches()
  let created = 0
  const create = spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:image-${++created}`)
  const revoke = spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  restores.push(
    () => create.mockRestore(),
    () => revoke.mockRestore()
  )
  dom = await acquireDomHarness({ url: 'http://localhost/' })
  const seen: Array<string | null> = []
  function Probe({ url }: { url: string }) {
    const src = useCachedImageSrc(url)
    useEffect(() => {
      seen.push(src)
    }, [src])
    return null
  }
  const { root } = dom.createRoot()
  // Wait for the observable upgrade rather than a fixed delay.
  const eventually = (assert: () => void) =>
    dom!.act(async () => {
      await waitFor(assert)
    })

  await dom.act(async () => root.render(<Probe url="/api/images/one?sig=a" />))
  expect(seen[0]).toBe('/api/images/one?sig=a')
  await eventually(() => expect(seen.at(-1)).toBe('blob:image-1'))

  // Another image shows its own signed URL first, never the previous image's blob.
  await dom.act(async () => root.render(<Probe url="/api/images/two?sig=b" />))
  expect(seen.at(-2)).toBe('/api/images/two?sig=b')
  expect(revoke).toHaveBeenCalledWith('blob:image-1')
  await eventually(() => expect(seen.at(-1)).toBe('blob:image-2'))

  await dom.act(async () => root.unmount())
  expect(revoke).toHaveBeenCalledWith('blob:image-2')
})

test('a URL that is not a signed image path is used as is', async () => {
  installCaches()
  dom = await acquireDomHarness({ url: 'http://localhost/' })
  let value: string | null | undefined
  function Probe() {
    const src = useCachedImageSrc('data:image/png;base64,AA==')
    useEffect(() => {
      value = src
    })
    return null
  }
  const { root } = dom.createRoot()
  await dom.act(async () => root.render(<Probe />))
  expect(value).toBe('data:image/png;base64,AA==')
  await dom.act(async () => root.unmount())
})
