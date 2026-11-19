import { expect, test } from 'bun:test'
import { acquireDomHarness } from '../../test/domHarness'
import { VoiceDisclosure } from './VoiceDisclosure'

test('voice disclosures use the app chevron without a native triangle and retain native toggle behavior', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost' })
  try {
    const { root, container } = dom.createRoot()
    await dom.act(async () =>
      root.render(
        <VoiceDisclosure summary="Assign to squads">
          <p>Squad choices</p>
        </VoiceDisclosure>
      )
    )
    const details = container.querySelector('details')!
    const summary = container.querySelector('summary')!
    expect(details.open).toBe(false)
    expect(summary.className).toContain('list-none')
    expect(summary.className).toContain('[&::-webkit-details-marker]:hidden')
    expect(summary.querySelector('svg path')?.getAttribute('d')).toBe('M19 9l-7 7-7-7')
    await dom.act(async () => summary.click())
    expect(details.open).toBe(true)
    await dom.act(async () => summary.click())
    expect(details.open).toBe(false)
  } finally {
    await dom.cleanup()
  }
})
