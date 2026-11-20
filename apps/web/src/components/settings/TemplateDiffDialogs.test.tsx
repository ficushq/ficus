import { expect, test } from 'bun:test'
import { acquireDomHarness } from '../../test/domHarness'
import { TemplateDiffDialog } from './TemplateDiffDialog'
import { TemplateFieldActions } from './TemplateFieldActions'

const template = { name: 'Researcher', model: 'deep', instructions: 'Read the brief and the history first.' }
const current = { name: 'Researcher', model: 'standard', instructions: 'Read the brief first.' }

async function harness() {
  const dom = await acquireDomHarness({})
  const { root } = dom.createRoot()
  const confirms: string[] = []
  window.confirm = (message?: string) => {
    confirms.push(String(message))
    return true
  }
  const dialog = (name: string) =>
    document.querySelector<HTMLElement>(`.ficus-modal-backdrop[role="dialog"][aria-label="${name}"]`)
  const button = (scope: ParentNode, label: string) =>
    [...scope.querySelectorAll('button')].find(
      (candidate) => candidate.textContent?.trim() === label || candidate.getAttribute('aria-label') === label
    )!
  const click = (target: Element) => dom.act(async () => (target as HTMLElement).click())
  const escape = () =>
    dom.act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
  return { dom, root, confirms, dialog, button, click, escape }
}

test('the template diff opens as the shared Modal, portaled to the page body, and keeps its actions', async () => {
  const t = await harness()
  const calls: string[] = []
  const render = (isOpen: boolean) =>
    t.dom.act(async () =>
      t.root.render(
        <TemplateDiffDialog
          isOpen={isOpen}
          onClose={() => calls.push('close')}
          title="Template differences"
          current={current}
          template={template}
          onRevert={() => calls.push('revert')}
          onRevertFields={(fields) => calls.push(`revert:${fields.join(',')}`)}
          fieldOverrides={['model']}
        />
      )
    )
  try {
    await render(true)
    const dialog = t.dialog('Template differences')!
    // Modal's layer: above floating windows, focusable, with the Desktop title-bar reserve and drag band.
    expect(dialog).not.toBeNull()
    expect(dialog.parentElement).toBe(document.body)
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.className).toContain('z-60')
    expect(dialog.querySelector('.ficus-modal-drag-region')).not.toBeNull()
    expect(document.activeElement).toBe(dialog)
    // The legend, the diff and the field revert are all still there.
    expect(dialog.textContent).toContain('Template')
    expect(dialog.textContent).toContain('Current')
    expect(dialog.textContent).toContain('+ ')
    expect(dialog.textContent).toContain('- ')

    await t.click(t.button(dialog, 'Revert model'))
    await t.click(t.button(dialog, 'Revert to Template'))
    expect(t.confirms).toEqual([
      'Revert "model" to template?',
      'Revert to template? This will overwrite all customizations.',
    ])
    expect(calls).toEqual(['revert:model', 'revert'])

    // Footer Close, the header close button, the backdrop and Escape all close it.
    calls.length = 0
    await t.click(t.button(dialog, 'Close'))
    await t.click(dialog.querySelector('button[aria-label="Close"]')!)
    await t.click(dialog)
    await t.escape()
    expect(calls).toEqual(['close', 'close', 'close', 'close'])

    await render(false)
    expect(t.dialog('Template differences')?.dataset.state ?? 'closed').toBe('closed')
  } finally {
    await t.dom.cleanup()
  }
})

test('a field diff opens as the shared Modal and keeps its revert and close actions', async () => {
  const t = await harness()
  const reverted: string[] = []
  try {
    await t.dom.act(async () =>
      t.root.render(
        <TemplateFieldActions
          field="model"
          current={current}
          template={template}
          fieldOverrides={['model']}
          onRevert={(field) => reverted.push(field)}
        />
      )
    )
    expect(t.dialog('Template Diff — model')).toBeNull()
    await t.click(t.button(document, 'Diff'))
    const dialog = t.dialog('Template Diff — model')!
    expect(dialog.parentElement).toBe(document.body)
    expect(dialog.dataset.state).toBe('open')
    expect(dialog.className).toContain('z-60')
    expect(dialog.querySelector('pre')!.textContent).toBe('deepstandard')

    await t.click(t.button(dialog, 'Revert Field'))
    expect(t.confirms).toEqual(['Revert "model" to template?'])
    expect(reverted).toEqual(['model'])

    await t.click(t.button(dialog, 'Close'))
    expect(dialog.dataset.state).toBe('closed')
    // Escape now closes it too, like every other dialog.
    await t.click(t.button(document, 'Diff'))
    expect(t.dialog('Template Diff — model')!.dataset.state).toBe('open')
    await t.escape()
    expect(t.dialog('Template Diff — model')!.dataset.state).toBe('closed')
  } finally {
    await t.dom.cleanup()
  }
})
