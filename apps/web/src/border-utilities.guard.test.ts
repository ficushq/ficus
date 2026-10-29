import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkBorderUtilities, collectBorderUtilities } from './test/borderUtilities'

const fixture = (text: string) => ({ path: 'synthetic.tsx', text })

test('reports the incident and an unknown themed border with actionable locations', async () => {
  const findings = await checkBorderUtilities([
    fixture('<div\n className="border-l border-current/20 hover:border-th-typo border-current" />'),
  ])
  expect(findings).toHaveLength(2)
  expect(findings[0]).toContain('synthetic.tsx:2:22')
  expect(findings[0]).toContain('border-current/20')
  expect(findings[1]).toContain('hover:border-th-typo')
  for (const finding of findings) {
    expect(finding).toContain('border-th-border')
    expect(finding).toContain('border-status-danger-500/30')
    expect(finding).toContain('No border color declaration')
  }
})

test('accepts real neutral, status, directional, variant and opacity output', async () => {
  const classes = [
    'border-th-border',
    'border-l-th-border',
    'border-th-border/20',
    'hover:border-th-border-hover',
    'md:focus:border-th-border/50',
    'dark:border-status-danger-400',
    'border-status-danger-500/30',
    'border-t-status-success-border',
    'group-hover:!border-status-attention-600',
    'border-current',
  ]
  expect(collectBorderUtilities(fixture(`<div className="${classes.join(' ')}" />`)).map((x) => x.utility)).toEqual(
    classes
  )
  expect(await checkBorderUtilities([fixture(`<div className="${classes.join(' ')}" />`)])).toEqual([])
})

test('collects complete literals in constants, clsx, ternaries and template segments', () => {
  const source = fixture(`
const styles = { warning: 'border-status-attention-500/30' }
const element = <div className={clsx('border-th-border', active ? 'hover:border-th-border' : 'border-current', \`border-l-th-border \${extra} focus:border-th-border\`)} />
`)
  expect(collectBorderUtilities(source).map((x) => x.utility)).toEqual([
    'border-status-attention-500/30',
    'border-th-border',
    'hover:border-th-border',
    'border-current',
    'border-l-th-border',
    'focus:border-th-border',
  ])
})

test('excludes dynamic fragments, arbitrary classes, comments and external class names', async () => {
  const source = fixture(`
// border-th-typo
const dynamic = \`border-status-\${status}-500 hover:border-th-\${token}\`
const concatenated = 'border-th-' + token
const external = <div className={externalClassName} />
const arbitrary = <div className="border-[var(--frame)] border-current/[.2] [&>a]:border-th-border border-vendor-frame" />
const document = html\`<p>border-th-typo</p>\`
`)
  expect(collectBorderUtilities(source)).toEqual([])
  expect(await checkBorderUtilities([source])).toEqual([])
})

test('app-owned static themed borders all emit color declarations', async () => {
  const files = [...new Bun.Glob('**/*.{ts,tsx,js,jsx}').scanSync({ cwd: import.meta.dir })]
    .filter((path) => !/(^|\/)(test|tests|fixtures|__tests__)\/|\.(test|spec|fixture)\.[jt]sx?$|test-setup/.test(path))
    .sort()
  expect(files.length).toBeGreaterThan(500)
  const sources = files.map((path) => ({
    path: `src/${path}`,
    text: readFileSync(join(import.meta.dir, path), 'utf8'),
  }))
  expect(await checkBorderUtilities(sources)).toEqual([])
})
