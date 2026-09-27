import { describe, it, expect, mock } from 'bun:test'
import { createPrecompactionExtension } from './extension'
import type { SessionBeforeCompactEvent } from '@earendil-works/pi-coding-agent'

const event = {
  type: 'session_before_compact',
  preparation: {},
  branchEntries: [],
  signal: new AbortController().signal,
} as unknown as SessionBeforeCompactEvent

/** Invoke the single registered session_before_compact handler. */
async function invoke(
  ext: ReturnType<typeof createPrecompactionExtension>,
  e: SessionBeforeCompactEvent
): Promise<unknown> {
  const handlers = ext.handlers.get('session_before_compact')!
  const handler = handlers[0] as (event: SessionBeforeCompactEvent, ctx: unknown) => Promise<unknown>
  return handler(e, {})
}

describe('createPrecompactionExtension', () => {
  it('registers exactly one session_before_compact handler', () => {
    const ext = createPrecompactionExtension(() => undefined)
    expect(ext.handlers.get('session_before_compact')?.length).toBe(1)
  })

  it('carries identifying source metadata', () => {
    const ext = createPrecompactionExtension(() => undefined)
    expect(ext.path).toBe('ficus:precompaction')
    expect(ext.sourceInfo.source).toBe('ficus')
    // empty maps so pi treats it as a no-op except for the handler
    expect(ext.tools.size).toBe(0)
    expect(ext.commands.size).toBe(0)
  })

  it('returns undefined when no controller is set', async () => {
    const ext = createPrecompactionExtension(() => undefined)
    expect(await invoke(ext, event)).toBeUndefined()
  })

  it('returns { compaction } when the controller has a valid ready result', async () => {
    const result = { summary: 'S', firstKeptEntryId: 'keep', tokensBefore: 1 }
    const controller = { awaitReadyResult: mock(() => result) } as never
    const ext = createPrecompactionExtension(() => controller)
    expect(await invoke(ext, event)).toEqual({ compaction: result })
  })

  it('returns undefined when the controller has nothing valid', async () => {
    const controller = { awaitReadyResult: mock(() => undefined) } as never
    const ext = createPrecompactionExtension(() => controller)
    expect(await invoke(ext, event)).toBeUndefined()
  })

  it('reads the controller lazily on each invocation', async () => {
    let current: unknown = undefined
    const ext = createPrecompactionExtension(() => current as never)
    expect(await invoke(ext, event)).toBeUndefined()
    const result = { summary: 'S2', firstKeptEntryId: 'k', tokensBefore: 2 }
    current = { awaitReadyResult: mock(() => result) }
    expect(await invoke(ext, event)).toEqual({ compaction: result })
  })
})

describe('fit fallback chaining', () => {
  async function invokeExt(ext: ReturnType<typeof createPrecompactionExtension>) {
    const handler = ext.handlers.get('session_before_compact')![0] as (e: unknown) => Promise<unknown>
    return handler(event)
  }

  it('serves the baked result without consulting the fallback', async () => {
    const compaction = { summary: 'S', firstKeptEntryId: 'k', tokensBefore: 1 }
    const fallback = mock(async () => undefined)
    const ext = createPrecompactionExtension(
      () => ({ awaitReadyResult: async () => compaction }) as never,
      () => fallback
    )
    expect(await invokeExt(ext)).toEqual({ compaction })
    expect(fallback).not.toHaveBeenCalled()
  })

  it('falls back to the fit bake when the cache misses', async () => {
    const compaction = { summary: 'F', firstKeptEntryId: 'k', tokensBefore: 1 }
    const ext = createPrecompactionExtension(
      () => ({ awaitReadyResult: async () => undefined }) as never,
      () => async () => compaction as never
    )
    expect(await invokeExt(ext)).toEqual({ compaction })
  })

  it('runs the fit fallback even with no controller', async () => {
    const compaction = { summary: 'F', firstKeptEntryId: 'k', tokensBefore: 1 }
    const ext = createPrecompactionExtension(
      () => undefined,
      () => async () => compaction as never
    )
    expect(await invokeExt(ext)).toEqual({ compaction })
  })

  it('returns undefined when both cache and fallback decline', async () => {
    const ext = createPrecompactionExtension(
      () => ({ awaitReadyResult: async () => undefined }) as never,
      () => async () => undefined
    )
    expect(await invokeExt(ext)).toBeUndefined()
  })

  it('returns undefined instead of throwing when the fallback rejects', async () => {
    const ext = createPrecompactionExtension(
      () => ({ awaitReadyResult: async () => undefined }) as never,
      () => async () => {
        throw new Error('boom')
      }
    )
    expect(await invokeExt(ext)).toBeUndefined()
  })
})
