import { expect, test } from 'bun:test'
import { fireEvent } from '@testing-library/dom'
import { acquireDomHarness } from '../test/domHarness'
import { AssistantUpdateChip } from './AssistantUpdateChip'

const update = {
  messageId: 'first',
  reportedStatus: 'working' as const,
  senderName: 'Riley',
  createdAt: '2026-10-20T00:32:00Z',
  subject: null,
  content: 'First **full** report.',
  seenAt: null,
}

for (const preview of [false, true]) {
  test(`task update preserves disclosure behavior with a decorative icon (preview: ${preview})`, async () => {
    const dom = await acquireDomHarness({ url: 'http://localhost/' })
    try {
      const { root, container } = dom.createRoot()
      const label = 'A very long application configuration task label'
      await dom.act(async () => {
        root.render(
          <AssistantUpdateChip
            updates={[update, { ...update, messageId: 'latest', content: 'Latest report.' }]}
            taskLabel={label}
            preview={preview}
          />
        )
      })
      const button = container.querySelector('button')!
      expect(button.querySelector('svg[aria-hidden="true"]')).not.toBeNull()
      expect(button.textContent).not.toContain('↳')
      // The label remains available in full when the visible text is truncated.
      const title = button.querySelector(`[title="${label}"]`)!
      expect(title.textContent).toBe(label)
      expect(button.querySelector('[aria-label="Unread"]')).not.toBeNull()
      expect(button.textContent).toContain('Working')
      expect(button.textContent).toContain('2 updates')
      expect(button.textContent?.includes('Latest report.')).toBe(preview)
      expect(button.getAttribute('aria-expanded')).toBe('false')
      await dom.act(async () => fireEvent.click(button))
      expect(button.getAttribute('aria-expanded')).toBe('true')
      const report = container.querySelector(`[id="${button.getAttribute('aria-controls')}"]`)!
      expect(report.querySelectorAll('li')).toHaveLength(2)
      expect(report.querySelector('strong')?.textContent).toBe('full')
      expect(report.textContent).toContain('Latest report.')
      await dom.act(async () => fireEvent.click(button))
      expect(container.querySelector('ul')).toBeNull()
    } finally {
      await dom.cleanup()
    }
  })
}

test('a read update without a task label or status falls back to its sender', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/' })
  try {
    const { root, container } = dom.createRoot()
    await dom.act(async () => {
      root.render(<AssistantUpdateChip updates={[{ ...update, reportedStatus: null, seenAt: update.createdAt }]} />)
    })
    const button = container.querySelector('button')!
    expect(button.querySelector('[title="Riley"]')?.textContent).toBe('Riley')
    expect(button.querySelector('[aria-label="Unread"]')).toBeNull()
    expect(button.textContent).not.toContain('Working')
    expect(button.textContent).not.toContain('updates')
    await dom.act(async () => root.render(<AssistantUpdateChip updates={[]} />))
    expect(container.textContent).toBe('')
  } finally {
    await dom.cleanup()
  }
})
