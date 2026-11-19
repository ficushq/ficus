import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { PublicVoiceProfileJson } from '@ficus/shared'
import { VoiceProfileList } from './VoicesTab'

const profile = (over: Partial<PublicVoiceProfileJson>): PublicVoiceProfileJson => ({
  id: 'team',
  name: 'Team',
  description: null,
  base: 'Team voice.',
  surfaces: {},
  disabled: false,
  hasTemplate: false,
  yamlFieldOverrides: [],
  bytes: 30,
  assignedSquadCount: 2,
  createdAt: '2026-11-18T00:00:00Z',
  updatedAt: '2026-11-18T00:00:00Z',
  ...over,
})

const noop = () => {}

describe('VoiceProfileList', () => {
  test('lists profiles with size and assigned squads; the default cannot be deleted', () => {
    const html = renderToStaticMarkup(
      <VoiceProfileList
        profiles={[
          profile({
            id: 'default',
            name: 'Default',
            hasTemplate: true,
            yamlFieldOverrides: ['base'],
            assignedSquadCount: 0,
          }),
          profile({}),
        ]}
        canWrite
        onEdit={noop}
        onToggle={noop}
        onDelete={noop}
      />
    )
    expect(html).toContain('Instance default')
    expect(html).toContain('Modified from template')
    expect(html).toContain('30 / 2,000 bytes')
    expect(html).toContain('2 assigned squads')
    const defaultCard = html.slice(
      html.indexOf('data-voice-profile="default"'),
      html.indexOf('data-voice-profile="team"')
    )
    expect(defaultCard).not.toContain('Delete')
    expect(html.slice(html.indexOf('data-voice-profile="team"'))).toContain('Delete')
  })

  test('read-only viewers can view but not change profiles', () => {
    const html = renderToStaticMarkup(
      <VoiceProfileList profiles={[profile({})]} canWrite={false} onEdit={noop} onToggle={noop} onDelete={noop} />
    )
    expect(html).toContain('View')
    expect(html).not.toContain('Disable')
    expect(html).not.toContain('Delete')
  })
})

test('deleting an unshipped profile requires a second click and uses the danger variant', async () => {
  const { acquireDomHarness } = await import('../../test/domHarness')
  const dom = await acquireDomHarness({ url: 'http://localhost' })
  try {
    const { root, container } = dom.createRoot()
    const removed: string[] = []
    await dom.act(async () =>
      root.render(
        <VoiceProfileList
          profiles={[profile({})]}
          canWrite
          onEdit={noop}
          onToggle={noop}
          onDelete={(p) => removed.push(p.id)}
        />
      )
    )
    const remove = container.querySelector<HTMLButtonElement>('[aria-label="Delete Team"]')!
    expect(remove.className).toContain('ficus-button-danger')
    await dom.act(async () => remove.click())
    expect(removed).toEqual([])
    expect(remove.textContent).toContain('2 squad(s) return to the default')
    await dom.act(async () => remove.click())
    expect(removed).toEqual(['team'])
  } finally {
    await dom.cleanup()
  }
})
