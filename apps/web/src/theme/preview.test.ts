import { expect, test } from 'bun:test'
import { acquireDomHarness } from '../test/domHarness'
import { paintRoot } from './preview'
import { findWebTheme } from './registry'
import type { CustomThemeDocument } from '@ficus/shared'

test('paintRoot applies a plain built-in, then layers a valid custom document; an invalid one falls back cleanly', async () => {
  const dom = await acquireDomHarness({ url: 'https://tau.test' })
  try {
    const root = document.documentElement
    paintRoot(root, findWebTheme('harbor'), 'dark', null)
    expect(root.getAttribute('data-theme')).toBe('harbor')
    expect(root.getAttribute('data-appearance')).toBe('dark')

    const doc: CustomThemeDocument = {
      format: 'tau-custom-theme',
      version: 2,
      name: 'Preview',
      base: 'harbor',
      variants: { light: {}, dark: { '--color-primary': '#123456' } },
    }
    paintRoot(root, findWebTheme('harbor'), 'dark', doc)
    expect(root.style.getPropertyValue('--color-primary')).toBe('18 52 86')

    // An invalid document (rejected by revalidation) never throws out of
    // paintRoot; it falls back to the plain builtin paint.
    const invalid = { ...doc, variants: { light: {}, dark: { '--color-primary': 'url(x)' } } } as CustomThemeDocument
    expect(() => paintRoot(root, findWebTheme('harbor'), 'dark', invalid)).not.toThrow()
    expect(root.style.getPropertyValue('--color-primary')).toBe('')
  } finally {
    await dom.cleanup()
  }
})
