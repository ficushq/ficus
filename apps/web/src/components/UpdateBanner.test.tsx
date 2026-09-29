import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { acquireDomHarness } from '../test/domHarness'
import { UpdateBanner } from './UpdateBanner'

let updateAvailable = true
let applyUpdate = mock(async () => {})

const useFixturePWA = () => ({ updateAvailable, applyUpdate })

describe('UpdateBanner', () => {
  let dom: Awaited<ReturnType<typeof acquireDomHarness>>
  let container: HTMLDivElement
  let root: Root

  beforeEach(async () => {
    dom = await acquireDomHarness({
      url: 'http://localhost/',
      afterUnmount: async () => {
        await Bun.sleep(0)
        await Bun.sleep(0)
      },
    })
    ;({ container, root } = dom.createRoot())
    updateAvailable = true
    applyUpdate = mock(async () => {})
  })

  afterEach(async () => {
    await dom.cleanup()
  })

  test('renders as an in-flow banner below the header, not a fixed safe-area overlay', async () => {
    await dom.act(async () => {
      root.render(<UpdateBanner usePWA={useFixturePWA} />)
    })

    const banner = container.firstElementChild
    expect(banner).not.toBeNull()
    expect(banner?.className).toContain('bg-accent')
    expect(banner?.className).toContain('shrink-0')
    expect(banner?.className).not.toContain('fixed')
    expect(banner?.className).not.toContain('safe-area')
  })

  test('shows visible applying feedback and disables the update button after pressing update', async () => {
    let finishApply!: () => void
    applyUpdate = mock(
      () =>
        new Promise<void>((resolve) => {
          finishApply = resolve
        })
    )

    await dom.act(async () => {
      root.render(<UpdateBanner usePWA={useFixturePWA} />)
    })

    const button = getButton('Update')
    await dom.act(async () => {
      button.click()
    })

    expect(container.textContent).toContain('Applying update…')
    const applyingButton = getButton('Updating…')
    expect(applyingButton.disabled).toBe(true)

    await dom.act(async () => {
      finishApply()
    })
    expect(applyUpdate).toHaveBeenCalledTimes(1)
  })

  test('clears applying feedback if applying the update fails', async () => {
    applyUpdate = mock(async () => {
      throw new Error('failed')
    })

    await dom.act(async () => {
      root.render(<UpdateBanner usePWA={useFixturePWA} />)
    })

    const originalConsoleError = console.error
    console.error = mock(() => {})
    try {
      await dom.act(async () => {
        getButton('Update').click()
      })
    } finally {
      console.error = originalConsoleError
    }

    expect(getButton('Update').disabled).toBe(false)
    expect(container.textContent).toContain('A new version is available')
  })

  function getButton(label: string): HTMLButtonElement {
    const button = findButtons(container).find((button) => button.textContent === label)
    if (!button) throw new Error(`Missing button: ${label}`)
    return button
  }

  function findButtons(element: Element): HTMLButtonElement[] {
    const buttons: HTMLButtonElement[] = []
    for (const child of Array.from(element.children)) {
      if (child.tagName.toLowerCase() === 'button') buttons.push(child as HTMLButtonElement)
      buttons.push(...findButtons(child))
    }
    return buttons
  }
})
