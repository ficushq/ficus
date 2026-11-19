import { expect, test } from 'bun:test'
import { acquireDomHarness } from '../../test/domHarness'
import { NewProfileDialog } from './NewProfileDialog'

test('new profiles use a modal, validate the id, and start fresh when reopened', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost' })
  try {
    const { root } = dom.createRoot()
    const submitted: Array<{ id: string; name: string }> = []
    const render = (isOpen: boolean) =>
      dom.act(async () =>
        root.render(
          <NewProfileDialog isOpen={isOpen} onClose={() => {}} onSubmit={(profile) => submitted.push(profile)} />
        )
      )
    await render(true)
    const doc = dom.window.document
    expect(doc.querySelector('[role="dialog"]')).not.toBeNull()
    const create = () =>
      [...doc.querySelectorAll<HTMLButtonElement>('button')].find((el) => el.textContent === 'Create')!
    expect(create().disabled).toBe(true)
    const fill = (label: string, text: string) =>
      dom.act(async () => {
        const input = doc.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, text)
        input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      })
    await fill('Profile id', 'Not valid')
    expect(create().disabled).toBe(true)
    await fill('Profile id', '  platform-team  ')
    await fill('Profile name', '  Platform team  ')
    expect(create().disabled).toBe(false)
    await dom.act(async () => create().click())
    expect(submitted).toEqual([{ id: 'platform-team', name: 'Platform team' }])
    await render(false)
    await render(true)
    expect(doc.querySelector<HTMLInputElement>('[aria-label="Profile id"]')!.value).toBe('')
    expect(create().disabled).toBe(true)
  } finally {
    await dom.cleanup()
  }
})
