import { describe, expect, it } from 'bun:test'
import { selectOpenWait, WaitSelectionError, type SelectableWait } from './workstream-wait-selection'

function wait(id: string, type: string, message: string | null = null): SelectableWait {
  return { id, type, message }
}

function closedWait(
  id: string,
  type: string,
  extra: Partial<Pick<SelectableWait, 'resolution' | 'closedAt' | 'resolutionNote' | 'message'>> = {}
): SelectableWait {
  return {
    id,
    type,
    message: extra.message ?? null,
    closedAt: extra.closedAt ?? '2026-09-02T23:07:59.000Z',
    resolution: extra.resolution ?? 'cleared',
    resolutionNote: extra.resolutionNote ?? null,
  }
}

describe('selectOpenWait (CLI resolve-sugar ambiguity rule)', () => {
  it('throws when there is no open wait of the target type', () => {
    expect(() => selectOpenWait([], 'manual', { typeLabel: 'manual (input-request)' })).toThrow(WaitSelectionError)
    expect(() => selectOpenWait(undefined, 'review', { typeLabel: 'review' })).toThrow(/no open review wait/i)
    // Waits of OTHER types never count.
    expect(() => selectOpenWait([wait('a', 'review')], 'manual', { typeLabel: 'manual (input-request)' })).toThrow(
      WaitSelectionError
    )
  })

  it('selects the single open wait of the target type', () => {
    const target = wait('bbbb1111-0000-4000-8000-000000000000', 'manual', 'need creds')
    const selected = selectOpenWait(
      [wait('aaaa1111-0000-4000-8000-000000000000', 'review'), target, wait('cccc', 'question')],
      'manual',
      { typeLabel: 'manual (input-request)' }
    )
    expect(selected.id).toBe(target.id)
  })

  it('REFUSES with two open waits of the target type and requires --wait, listing the ids', () => {
    const a = wait('aaaa1111-0000-4000-8000-000000000000', 'manual', 'first')
    const b = wait('bbbb2222-0000-4000-8000-000000000000', 'manual', 'second')
    let error: unknown
    try {
      selectOpenWait([a, b], 'manual', { typeLabel: 'manual (input-request)' })
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(WaitSelectionError)
    const message = (error as Error).message
    expect(message).toContain('--wait')
    expect(message).toContain(a.id)
    expect(message).toContain(b.id)
  })

  it('an explicit --wait id (or unique prefix) picks among several open waits', () => {
    const a = wait('aaaa1111-0000-4000-8000-000000000000', 'manual', 'first')
    const b = wait('bbbb2222-0000-4000-8000-000000000000', 'manual', 'second')
    expect(selectOpenWait([a, b], 'manual', { explicitWaitId: b.id, typeLabel: 'manual' }).id).toBe(b.id)
    expect(selectOpenWait([a, b], 'manual', { explicitWaitId: 'bbbb2222', typeLabel: 'manual' }).id).toBe(b.id)
  })

  it('an explicit --wait id that matches nothing (or a wait of another type) throws', () => {
    const a = wait('aaaa1111-0000-4000-8000-000000000000', 'manual', 'first')
    const review = wait('cccc3333-0000-4000-8000-000000000000', 'review', 'round')
    expect(() => selectOpenWait([a, review], 'manual', { explicitWaitId: 'dddd', typeLabel: 'manual' })).toThrow(
      WaitSelectionError
    )
    // Explicit id pointing at an open wait of the WRONG type is not a match.
    expect(() => selectOpenWait([a, review], 'manual', { explicitWaitId: review.id, typeLabel: 'manual' })).toThrow(
      WaitSelectionError
    )
  })

  it('an ambiguous --wait prefix throws instead of guessing', () => {
    const a = wait('aaaa1111-0000-4000-8000-000000000000', 'manual')
    const b = wait('aaaa2222-0000-4000-8000-000000000000', 'manual')
    expect(() => selectOpenWait([a, b], 'manual', { explicitWaitId: 'aaaa', typeLabel: 'manual' })).toThrow(
      /multiple open manual waits/i
    )
  })

  describe('stale --wait targets (id names a CLOSED wait of the target type)', () => {
    const stale = closedWait('c3f556a2-1b82-4151-b8eb-7371979ebf59', 'manual', {
      resolution: 'cleared',
      closedAt: '2026-09-02T23:07:59.000Z',
      resolutionNote: 'Execution 8f2c started for the current assignee.',
    })
    const open = wait('29256adb-7458-4ae2-9f5d-7e8b2605372d', 'manual', 'need input')

    it('names the already-closed wait, its resolution, and that the note was not recorded', () => {
      let error: unknown
      try {
        selectOpenWait([open], 'manual', {
          explicitWaitId: stale.id,
          typeLabel: 'manual (input-request)',
          history: [open, stale],
        })
      } catch (e) {
        error = e
      }
      expect(error).toBeInstanceOf(WaitSelectionError)
      const message = (error as Error).message
      expect(message).toContain(`--wait ${stale.id}`)
      expect(message).toMatch(/already closed/i)
      expect(message).toContain('cleared')
      expect(message).toContain('Execution 8f2c started')
      // The actionable part: the operator must know the note went nowhere.
      expect(message).toMatch(/note was not recorded/i)
      // Still shows what IS open so the next command targets a live wait.
      expect(message).toContain(open.id)
      expect(message).not.toMatch(/No open .* wait matches/)
    })

    it('diagnoses on a unique prefix of the closed wait id as well', () => {
      expect(() =>
        selectOpenWait([open], 'manual', {
          explicitWaitId: 'c3f556a2',
          typeLabel: 'manual (input-request)',
          history: [open, stale],
        })
      ).toThrow(/already closed/i)
    })

    it('says there is nothing left to clear when no waits of the type remain open', () => {
      let error: unknown
      try {
        selectOpenWait([], 'manual', { explicitWaitId: stale.id, typeLabel: 'manual', history: [stale] })
      } catch (e) {
        error = e
      }
      expect((error as Error).message).toMatch(/nothing to clear|no open manual/i)
      expect((error as Error).message).toMatch(/already closed/i)
    })

    it('ignores closed waits of OTHER types (a closed review wait is not a manual target)', () => {
      const closedReview = closedWait('dddd4444-0000-4000-8000-000000000000', 'review', { resolution: 'approved' })
      expect(() =>
        selectOpenWait([open], 'manual', {
          explicitWaitId: closedReview.id,
          typeLabel: 'manual',
          history: [open, closedReview],
        })
      ).toThrow(/No open manual wait matches/)
    })

    it('falls back to the generic no-match error when the prefix matches several closed waits', () => {
      const staleA = closedWait('eeee1111-0000-4000-8000-000000000000', 'manual')
      const staleB = closedWait('eeee2222-0000-4000-8000-000000000000', 'manual')
      expect(() =>
        selectOpenWait([open], 'manual', {
          explicitWaitId: 'eeee',
          typeLabel: 'manual',
          history: [open, staleA, staleB],
        })
      ).toThrow(/No open manual wait matches/)
    })

    it('keeps the generic no-match error when no wait history is available', () => {
      expect(() => selectOpenWait([open], 'manual', { explicitWaitId: stale.id, typeLabel: 'manual' })).toThrow(
        /No open manual wait matches/
      )
    })
  })

  it('truncates very long wait messages in the ambiguity listing so the error stays scannable', () => {
    const a = wait('aaaa1111-0000-4000-8000-000000000000', 'manual', 'word '.repeat(60))
    const b = wait('bbbb2222-0000-4000-8000-000000000000', 'manual', 'second')
    let error: unknown
    try {
      selectOpenWait([a, b], 'manual', { typeLabel: 'manual' })
    } catch (e) {
      error = e
    }
    const message = (error as Error).message
    expect(message).toContain(a.id)
    // First line of the long message, cut at a bounded length with an ellipsis —
    // never the full multi-hundred-character watchdog text.
    expect(message).toContain('word word')
    expect(message).not.toContain('word '.repeat(60).trim())
    const longestLine = message.split('\n').reduce((max, line) => (line.length > max.length ? line : max), '')
    expect(longestLine.length).toBeLessThanOrEqual(140)
  })
})
