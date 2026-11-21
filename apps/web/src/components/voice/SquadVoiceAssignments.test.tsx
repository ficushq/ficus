import { untilRendered } from '../../test/untilRendered'
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
      const disclosure = container.querySelector('details')
      expect(disclosure).not.toBeNull()
      expect(disclosure!.open).toBe(false)
      await dom.act(async () => disclosure!.querySelector('summary')!.click())
      expect(disclosure!.open).toBe(true)
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
        await dom.act(async () => container.querySelector<HTMLButtonElement>('button')!.click())
        // The failure list renders only after every sequential PATCH settled.
        await untilRendered(dom, () => expect(container.querySelector('[role="alert"]')).not.toBeNull())
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
      await dom.cleanup()
      client.clear()
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
    expect(container.textContent).toContain('Unassigned squads already use this default profile')
    expect(container.textContent).toContain("Choosing it for a squad clears that squad's assignment")
    const boxes = container.querySelectorAll<HTMLInputElement>('input')
    expect(boxes[0]!.checked).toBe(false)
    expect(boxes[1]!.checked).toBe(true)
    await dom.act(async () => boxes[0]!.click())
    await dom.act(async () => container.querySelector<HTMLButtonElement>('button')!.click())
    await untilRendered(dom, () => expect(container.textContent).toContain('Updated 1 squad.'))
    expect(patches).toEqual([{ voiceId: null, preserveCustomBase: true }])
  } finally {
    globalThis.fetch = original
    await dom.cleanup()
    client.clear()
  }
})

for (const chosen of ['mine', 'other'] as const)
  test(`a chosen instance default (${chosen === 'mine' ? 'this profile' : 'another profile'}) decides who uses it`, async () => {
    const dom = await acquireDomHarness({ url: 'http://localhost' })
    const client = new QueryClient()
    const original = globalThis.fetch
    const patches: unknown[] = []
    globalThis.fetch = (async (_, init) => {
      patches.push(JSON.parse(String(init?.body)))
      return Response.json({ voiceId: null })
    }) as typeof fetch
    const list = [
      { id: 'mine-assigned', name: 'Mine assigned', publicVoiceId: 'mine' },
      { id: 'unassigned', name: 'Unassigned', publicVoiceId: null },
      { id: 'shipped', name: 'Shipped', publicVoiceId: 'default' },
    ] as Squad[]
    try {
      const { root, container } = dom.createRoot()
      await dom.act(async () =>
        root.render(
          <QueryClientProvider client={client}>
            <PermissionsProvider
              usePermissions={() => ({ permissions: ['*'], can: () => true, isLoading: false, isError: false })}
            >
              <SquadVoiceAssignments
                profile={{ id: 'mine', disabled: false, isInstanceDefault: chosen === 'mine' }}
                squads={list}
              />
            </PermissionsProvider>
          </QueryClientProvider>
        )
      )
      const boxes = container.querySelectorAll<HTMLInputElement>('input')
      expect([...boxes].map((b) => b.checked)).toEqual([true, chosen === 'mine', false])
      // Unassigned squads already follow the chosen default and cannot be unticked.
      expect(boxes[1]!.disabled).toBe(chosen === 'mine')
      await dom.act(async () => boxes[2]!.click())
      await dom.act(async () => container.querySelector<HTMLButtonElement>('button')!.click())
      await untilRendered(dom, () => expect(container.textContent).toContain('Updated 1 squad.'))
      // Choosing the instance default clears the assignment; any other profile is assigned explicitly.
      expect(patches).toEqual([{ voiceId: chosen === 'mine' ? null : 'mine', preserveCustomBase: true }])
    } finally {
      globalThis.fetch = original
      client.clear()
      await dom.cleanup()
    }
  })
