import { expect, test } from 'bun:test'
import { useVoiceDerivation } from './useVoiceDerivation'
import { acquireDomHarness } from '../../test/domHarness'
const result = (base: string) => ({
  login: 'octo',
  draft: { base, surfaces: {} },
  observations: [],
  exemplars: [],
  sampling: {
    filters: {},
    counts: {
      collected: 20,
      kept: 20,
      droppedByFilter: { date: 0, repository: 0 },
      droppedAsToolAuthored: 0,
      droppedAsTemplate: 0,
    },
    dateRange: {},
    publicRepositories: [],
    privateRepositories: [],
    pagingCapped: false,
  },
  bytes: 20,
  maxBytes: 2000,
})
test('cancel, retry, context switch and unmount fence stale callbacks and drafts', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost' })
  const originalFetch = globalThis.fetch
  const pending: Array<{ resolve: (response: Response) => void; signal: AbortSignal }> = []
  globalThis.fetch = ((_, init) =>
    new Promise((resolve) => pending.push({ resolve, signal: init!.signal! }))) as typeof fetch
  let hook!: ReturnType<typeof useVoiceDerivation>
  function Fixture({ squadId }: { squadId: string }) {
    hook = useVoiceDerivation({ kind: 'squad', squadId }, () => ({ login: 'octo', filters: {} }))
    return <p>{hook.data?.draft.base ?? hook.notice}</p>
  }
  try {
    const { root, container } = dom.createRoot()
    await dom.act(async () => root.render(<Fixture squadId="a" />))
    let runA!: Promise<void>
    await dom.act(async () => {
      runA = hook.mutate()
    })
    await dom.act(async () => hook.cancel())
    expect(pending[0]!.signal.aborted).toBe(true)
    let runB!: Promise<void>
    await dom.act(async () => {
      runB = hook.mutate()
    })
    await dom.act(async () => {
      pending[1]!.resolve(Response.json(result('New draft.')))
      await runB
    })
    expect(container.textContent).toBe('New draft.')
    await dom.act(async () => {
      pending[0]!.resolve(Response.json(result('Stale draft.')))
      await runA
    })
    expect(container.textContent).toBe('New draft.')
    await dom.act(async () => root.render(<Fixture squadId="b" />))
    expect(container.textContent).not.toContain('New draft.')
    let runC!: Promise<void>
    await dom.act(async () => {
      runC = hook.mutate()
    })
    await dom.act(async () => root.unmount())
    expect(pending[2]!.signal.aborted).toBe(true)
    pending[2]!.resolve(Response.json(result('Unmounted draft.')))
    await runC
  } finally {
    globalThis.fetch = originalFetch
    await dom.cleanup()
  }
})
