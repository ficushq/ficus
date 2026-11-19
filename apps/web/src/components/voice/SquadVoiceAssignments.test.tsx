import { expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Squad } from '@ficus/shared'
import { acquireDomHarness } from '../../test/domHarness'
import { PermissionsProvider } from '../../hooks/usePermissions'
import { queries } from '../../queryOptions'
import { SquadVoiceAssignments } from './SquadVoiceAssignments'

const squads = [
  { id: 'old', name: 'Original', publicVoiceId: 'team' },
  { id: 'new', name: 'New team', publicVoiceId: null },
  { id: 'custom', name: 'Custom', publicVoiceId: null, publicVoice: { base: 'Ours.', surfaces: {} } },
  { id: 'denied', name: 'Read only', publicVoiceId: null },
  { id: 'archived', name: 'Archived', archivedAt: '2026-01-01' },
] as Squad[]
for (const disabled of [false, true])
  test(`assignment control respects squads and disabled=${disabled}`, async () => {
    const dom = await acquireDomHarness({ url: 'http://localhost' })
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })
    client.setQueryData(queries.squads.list().queryKey, squads)
    const original = globalThis.fetch
    const calls: Array<{ url: string; body: any }> = []
    globalThis.fetch = (async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) })
      return String(url).includes('/custom/')
        ? Response.json({ error: 'public_voice_too_long' }, { status: 400 })
        : Response.json({ voiceId: null })
    }) as typeof fetch
    try {
      const { root, container } = dom.createRoot()
      await dom.act(async () =>
        root.render(
          <QueryClientProvider client={client}>
            <PermissionsProvider
              usePermissions={(id) => ({
                permissions: [],
                isLoading: false,
                isError: false,
                can: () => id !== 'denied',
              })}
            >
              <SquadVoiceAssignments profile={{ id: 'team', disabled }} squads={squads} />
            </PermissionsProvider>
          </QueryClientProvider>
        )
      )
      expect(container.textContent).toContain('Assigned squads: Original')
      expect(container.textContent).toContain(
        "uses its own custom voice; assigning a profile has no effect until that is cleared in the squad's Voice settings"
      )
      expect(container.textContent).not.toContain('Archived')
      const box = (id: string) => container.querySelector<HTMLInputElement>(`[data-squad-id="${id}"] input`)!
      expect(box('old').checked).toBe(true)
      expect(box('denied').disabled).toBe(true)
      if (disabled) {
        expect(box('new').disabled).toBe(true)
        expect(container.querySelector<HTMLButtonElement>('button')!.disabled).toBe(true)
      } else {
        await dom.act(async () => {
          box('old').click()
          box('new').click()
          box('custom').click()
        })
        await dom.act(async () => {
          container.querySelector<HTMLButtonElement>('button')!.click()
          await new Promise((r) => setTimeout(r, 20))
        })
        expect(calls).toEqual([
          { url: 'http://localhost/api/squads/old/voice', body: { voiceId: null, preserveCustomBase: true } },
          { url: 'http://localhost/api/squads/new/voice', body: { voiceId: 'team', preserveCustomBase: true } },
          { url: 'http://localhost/api/squads/custom/voice', body: { voiceId: 'team', preserveCustomBase: true } },
        ])
        expect(container.textContent).toContain('Custom:')
        expect(container.textContent).toContain('public_voice_too_long')
        expect(
          client.getQueryData<Squad[]>(queries.squads.list().queryKey)?.find((s) => s.id === 'new')?.publicVoiceId
        ).toBe('team')
      }
    } finally {
      globalThis.fetch = original
      client.clear()
      await dom.cleanup()
    }
  })

test('assigning default clears the selected assignment and explains effective defaults', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost' })
  const client = new QueryClient()
  const original = globalThis.fetch
  const patches: unknown[] = []
  globalThis.fetch = (async (_, init) => {
    patches.push(JSON.parse(String(init?.body)))
    return Response.json({ voiceId: null })
  }) as typeof fetch
  try {
    const { root, container } = dom.createRoot()
    await dom.act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <PermissionsProvider
            usePermissions={() => ({ permissions: ['*'], can: () => true, isLoading: false, isError: false })}
          >
            <SquadVoiceAssignments profile={{ id: 'default', disabled: false }} squads={squads.slice(0, 2)} />
          </PermissionsProvider>
        </QueryClientProvider>
      )
    )
    expect(container.textContent).toContain('Unassigned squads already use the instance default')
    expect(container.textContent).toContain("Assigning default clears a squad's assignment")
    const boxes = container.querySelectorAll<HTMLInputElement>('input')
    expect(boxes[0]!.checked).toBe(false)
    expect(boxes[1]!.checked).toBe(true)
    await dom.act(async () => boxes[0]!.click())
    await dom.act(async () => {
      container.querySelector<HTMLButtonElement>('button')!.click()
      await new Promise((r) => setTimeout(r, 10))
    })
    expect(patches).toEqual([{ voiceId: null, preserveCustomBase: true }])
  } finally {
    globalThis.fetch = original
    client.clear()
    await dom.cleanup()
  }
})
