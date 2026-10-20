import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { renderToStaticMarkup } from 'react-dom/server'
import { IntegrationLogo } from './IntegrationLogo'

test('BigBrain uses the pinned, unmodified desktop app icon from upstream', async () => {
  const bytes = await readFile(new URL('../../assets/bigbrain-app-icon.svg', import.meta.url))
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(
    '2eed99b8143439599579bec68b620ed53acf48772743f50ac1bf7beacf4f8ae9'
  )
  const svg = bytes.toString('utf8')
  expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true)
  // Static artwork only: nothing that can run code or fetch another resource.
  expect(svg).not.toMatch(/<script|<foreignObject|<image|<use|href|\son[a-z]+=|url\(|@import/i)
})

test('shared logo stays decorative beside card labels, and unrelated logos/fallbacks are unchanged', () => {
  const mark = renderToStaticMarkup(<IntegrationLogo provider="bigbrain" label="BigBrain" />)
  expect(mark).toContain('alt=""')
  expect(mark).toContain('bigbrain-app-icon')
  expect(mark).toContain('h-10 w-10')
  expect(mark).not.toContain('<svg')
  expect(renderToStaticMarkup(<IntegrationLogo provider="notion" label="Notion" />)).toContain('<svg')
  expect(renderToStaticMarkup(<IntegrationLogo provider="custom" label="Example" />)).toBe('E')
})
