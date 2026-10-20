import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { renderToStaticMarkup } from 'react-dom/server'
import { IntegrationLogo } from './IntegrationLogo'

test('BigBrain uses the pinned official current static avatar, not the retired multicolor email mark', async () => {
  const bytes = await readFile(new URL('../../assets/bigbrain-mark.png', import.meta.url))
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(
    'aaa4ec568b3b81697482963b2961db2f812a2a97b1a79606915ab2fb8f71c0d9'
  )
  expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
})

test('shared logo stays decorative beside card labels, and unrelated logos/fallbacks are unchanged', () => {
  const mark = renderToStaticMarkup(<IntegrationLogo provider="bigbrain" label="BigBrain" />)
  expect(mark).toContain('alt=""')
  expect(mark).toContain('h-8 w-8')
  expect(mark).not.toContain('<svg')
  expect(renderToStaticMarkup(<IntegrationLogo provider="notion" label="Notion" />)).toContain('<svg')
  expect(renderToStaticMarkup(<IntegrationLogo provider="custom" label="Example" />)).toBe('E')
})
