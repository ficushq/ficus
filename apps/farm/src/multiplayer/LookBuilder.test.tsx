import { afterEach, describe, expect, it, mock } from 'bun:test'
import { isFarmLook, type FarmLook } from '@ficus/shared'
import { byText, click, keyDown } from '../chat/testing'
import { Welcome } from '../onboarding/Welcome'
import { LookBuilder } from './LookBuilder'
import { fakeMultiplayer, renderWith } from './testing'

const mounted: Array<() => void> = []
afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount()
})

const chip = (root: ParentNode, group: string, label: string) =>
  byText(root.querySelector(`[aria-label="${group}"]`)!, 'button', label)

const saved = (setMyLook: unknown): FarmLook => (setMyLook as ReturnType<typeof mock>).mock.calls[0]![0] as FarmLook

describe('LookBuilder', () => {
  it('dresses you part by part, previews it, and saves the whole look', async () => {
    const multiplayer = await fakeMultiplayer()
    const onClose = mock(() => {})
    const view = await renderWith(<LookBuilder narrow={false} onClose={onClose} />, multiplayer)
    mounted.push(view.unmount)
    await click(chip(view.container, 'Hairstyle', 'Afro'))
    await click(chip(view.container, 'Hat', 'Cowboy'))
    await click(chip(view.container, 'Bottoms', 'Skirt'))
    await click(chip(view.container, 'Piercings', 'Nose'))
    await click(chip(view.container, 'Piercings', 'Ears'))
    expect(chip(view.container, 'Hat', 'Cowboy').getAttribute('aria-checked')).toBe('true')
    // The preview can switch style.
    await click(chip(view.container, 'Preview in', 'Cozy'))
    expect(view.container.querySelector('svg[aria-label="You, in the Cozy style"]')).not.toBeNull()

    await click(byText(view.container, 'button', 'Save my look'))
    const look = saved(multiplayer.setMyLook)
    expect(isFarmLook(look)).toBe(true)
    expect(look).toMatchObject({ hair: 'afro', hat: 'cowboy', pants: 'skirt', piercings: ['ears', 'nose'] })
    expect(onClose).toHaveBeenCalled()
  })

  it('closes on Cancel or Escape without saving', async () => {
    const multiplayer = await fakeMultiplayer()
    const onClose = mock(() => {})
    const view = await renderWith(<LookBuilder narrow={false} onClose={onClose} />, multiplayer)
    mounted.push(view.unmount)
    await click(chip(view.container, 'Hairstyle', 'Bald'))
    await keyDown(view.container.querySelector('.g-look')!, { key: 'Escape' })
    await click(byText(view.container, 'button', 'Cancel'))
    expect(onClose).toHaveBeenCalledTimes(2)
    expect(multiplayer.setMyLook).not.toHaveBeenCalled()
  })
})

describe('Welcome', () => {
  it('has you pick a style, then make your farmer', async () => {
    const multiplayer = await fakeMultiplayer()
    const setSkin = mock(() => {})
    const onDone = mock(() => {})
    const view = await renderWith(<Welcome narrow={false} onDone={onDone} />, multiplayer, { setSkin })
    mounted.push(view.unmount)
    expect(view.container.textContent).toContain('How should your farm look?')
    await click(byText(view.container, '[aria-label="Farm style"] button', /Cozy/))
    expect(setSkin).toHaveBeenCalledWith('cozy')

    await click(byText(view.container, 'button', 'Next: your farmer'))
    expect(view.container.textContent).toContain('Now make your farmer')
    await click(chip(view.container, 'Hairstyle', 'Bald'))
    await click(byText(view.container, 'button', 'Start farming'))
    expect(saved(multiplayer.setMyLook)).toMatchObject({ hair: 'bald' })
    expect(onDone).toHaveBeenCalled()
  })

  it('can be skipped, leaving your look as it is', async () => {
    const multiplayer = await fakeMultiplayer()
    const onDone = mock(() => {})
    const view = await renderWith(<Welcome narrow={false} onDone={onDone} />, multiplayer)
    mounted.push(view.unmount)
    await click(byText(view.container, 'button', 'Skip'))
    expect(onDone).toHaveBeenCalled()
    expect(multiplayer.setMyLook).not.toHaveBeenCalled()
  })
})
