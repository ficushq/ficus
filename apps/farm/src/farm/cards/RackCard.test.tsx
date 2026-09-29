import { afterEach, describe, expect, it, mock } from 'bun:test'
import type { Agent } from '@ficus/shared'
import { click } from '../../chat/testing'
import { sampleFarm } from '../../dev/sampleFarm'
import { fakeMultiplayer, renderWith } from '../../multiplayer/testing'
import { layoutFarm } from '../layout'
import { FarmCardContext, type FarmCardEnv } from './context'
import { RackCard } from './RackCard'

const mounted: Array<() => void> = []
afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount()
})

describe('RackCard', () => {
  it("lists a squad's apps and opens each in a new tab, a local one through the instance with its token", async () => {
    const input = sampleFarm()
    const env = {
      layout: layoutFarm(input),
      input,
      agentsById: new Map<string, Agent>(),
      squadsById: new Map(input.squads.map((s) => [s.id, s])),
    } as unknown as FarmCardEnv
    const open = mock(() => null)
    window.open = open as unknown as typeof window.open
    const view = await renderWith(
      <FarmCardContext.Provider value={env}>
        <RackCard squadId="sq-platform" />
      </FarmCardContext.Provider>,
      await fakeMultiplayer()
    )
    mounted.push(view.unmount)
    expect(view.container.textContent).toContain('2 apps to open')
    expect(view.container.textContent).toContain('Remote · vercel · production · ready')
    await click(view.container.querySelector('button[aria-label="Open Dev server in a new tab"]'))
    expect(open).toHaveBeenCalledWith(
      `${window.location.origin}/api/app/demo-dev/?token=demo`,
      '_blank',
      'noopener,noreferrer'
    )
  })
})
