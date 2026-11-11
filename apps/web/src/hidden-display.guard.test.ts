import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkHiddenDisplay, collectClassGroups, displayUtilitiesAfterHidden } from './test/hiddenDisplay'

// Tailwind 3 emitted `hidden` after every other display utility, so it always won on one element.
// Tailwind 4 orders them by name, so inline-flex, table and others now beat it: after the Tailwind 4
// migration the agent view's segmented control ("hidden lg:inline-flex" on a control that sets its
// own inline-flex) showed on phones and broke the squad chat header.

const fixture = (text: string) => ({ path: 'synthetic.tsx', text })

test('the production build emits inline and table display utilities after hidden, and flex, block and grid before it', async () => {
  const after = await displayUtilitiesAfterHidden()
  for (const utility of ['inline-flex', 'inline-block', 'inline', 'table', 'table-cell', 'list-item'])
    expect(after.has(utility)).toBe(true)
  for (const utility of ['flex', 'block', 'grid', 'contents', 'flow-root']) expect(after.has(utility)).toBe(false)
})

test('reports hidden losing to a display utility on the same element, with its location', async () => {
  const findings = await checkHiddenDisplay([
    fixture(`
const a = <span className="hidden inline-flex items-center" />
const b = <div className={clsx('inline-block', !open && 'hidden')} />
const c = 'table hidden'
`),
  ])
  expect(findings).toHaveLength(3)
  expect(findings[0]).toStartWith('synthetic.tsx:2:17 hidden with inline-flex')
  expect(findings[1]).toStartWith('synthetic.tsx:3:16 hidden with inline-block')
  expect(findings[2]).toStartWith('synthetic.tsx:4:11 hidden with table')
  for (const finding of findings) expect(finding).toContain('max-md:hidden')
})

test('reports hidden with a variant display utility passed to a component', async () => {
  const findings = await checkHiddenDisplay([
    fixture(`
const a = <SegmentedControl ariaLabel="View" className="hidden lg:inline-flex" />
const b = <Popup.Trigger triggerClassName={clsx('hidden', 'md:flex')} />
`),
  ])
  expect(findings).toHaveLength(2)
  expect(findings[0]).toStartWith('synthetic.tsx:2:46 <SegmentedControl> hidden lg:inline-flex')
  expect(findings[0]).toContain('max-lg:hidden')
  expect(findings[1]).toStartWith('synthetic.tsx:3:26 <Popup.Trigger> hidden md:flex')
})

test('accepts responsive hiding that cannot conflict', async () => {
  const source = fixture(`
const a = <div className="hidden md:flex" />
const b = <span className="hidden sm:inline" />
const c = <SegmentedControl className="max-lg:hidden" />
const d = <div className={clsx('flex', !open && 'hidden')} />
const e = <Badge className="max-sm:hidden" />
const f = <div className="overflow-hidden inline-flex" aria-hidden="true" />
const g = <NavLink to="/settings" className={() => clsx('hidden md:flex')} />
`)
  expect(await checkHiddenDisplay([source])).toEqual([])
  // Plain elements and React Router's links: none is treated as a component that adds its own classes.
  expect(collectClassGroups(source).map((group) => group.component ?? null)).toStrictEqual([null, null, null, null])
})

test('app source never pairs hidden with a display utility that beats it', async () => {
  const files = [...new Bun.Glob('**/*.{ts,tsx}').scanSync({ cwd: import.meta.dir })]
    .filter((path) => !/(^|\/)(test|tests|fixtures|__tests__)\/|\.(test|spec|fixture)\.[jt]sx?$|test-setup/.test(path))
    .sort()
  expect(files.length).toBeGreaterThan(500)
  const sources = files.map((path) => ({
    path: `src/${path}`,
    text: readFileSync(join(import.meta.dir, path), 'utf8'),
  }))
  expect(await checkHiddenDisplay(sources)).toEqual([])
})
