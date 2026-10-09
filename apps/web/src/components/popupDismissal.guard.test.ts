/**
 * Source guard for the popup dismissal rule (see `hooks/usePopupDismiss.ts`): a popup closes only through
 * `usePopupDismiss`, never from its own blur/focusout handler or a bespoke outside-press listener. Every
 * past "tap on a menu item does nothing on iPhone" bug was one of those hand-rolled paths, because WebKit
 * blurs a tapped button to its focusable ancestor (or to nothing) before the click and no Chromium-based
 * test notices. The allowlists are deliberately tiny and each entry says why it is not a popup.
 */
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const SRC = join(import.meta.dir, '..')
const PRIMITIVE = 'hooks/usePopupDismiss.ts'

/** Document/window press and focus-loss listeners outside the primitive that are not popup dismissal. */
const LISTENER_ALLOWLIST: Record<string, string> = {
  'lib/pwaUpdater.ts': 'records user activity to time an update reload; dismisses nothing',
  'components/PullToRefresh.tsx': 'a pull gesture on its own container; dismisses nothing',
}

/** Blur handlers that match the dismissal pattern but close no popup. Keep this small. */
const BLUR_ALLOWLIST: Record<string, string> = {}

const DISMISSAL =
  /\bset\w*(?:Open|Expanded|Visible|Shown|Preview)\(\s*(?:false|null)|\b(?:close|dismiss|hide|collapse)\w*\(|\bon(?:Dismiss|Close)\b|\.open\s*=\s*false/

function sources(): Array<{ path: string; text: string }> {
  const files: Array<{ path: string; text: string }> = []
  for (const entry of new Bun.Glob('**/*.{ts,tsx}').scanSync({ cwd: SRC })) {
    const path = entry.replaceAll('\\', '/')
    if (/\.(test|spec)\.tsx?$/.test(path) || path.startsWith('test/') || path === PRIMITIVE) continue
    files.push({ path, text: readFileSync(join(SRC, path), 'utf8') })
  }
  return files
}

/** The balanced `{…}`/`(…)` block starting at `open`, exclusive of the delimiters. */
function block(text: string, open: number): string {
  const pairs: Record<string, string> = { '{': '}', '(': ')' }
  const close = pairs[text[open]!]!
  let depth = 0
  for (let index = open; index < text.length; index++) {
    if (text[index] === text[open]) depth++
    else if (text[index] === close && --depth === 0) return text.slice(open + 1, index)
  }
  return text.slice(open + 1)
}

/** The body of a same-file function named `name`, or '' when it is a prop or import. */
function definition(text: string, name: string): string {
  const match = new RegExp(`(?:const|let|function)\\s+${name.replace(/[$]/g, '\\$')}\\b`).exec(text)
  if (!match) return ''
  const brace = text.indexOf('{', match.index)
  // An arrow with an expression body: its line is the body.
  const head = brace < 0 ? text.slice(match.index) : text.slice(match.index, brace)
  if (/=>\s*\S/.test(head)) return text.slice(match.index, text.indexOf('\n', match.index))
  return brace < 0 ? '' : block(text, brace)
}

/** Blur/focusout handlers in `text` whose body (inline, or a same-file named handler) dismisses something. */
function blurDismissals(text: string): string[] {
  const found: string[] = []
  for (const match of text.matchAll(/\bon(?:Blur|BlurCapture|FocusOut)=\{/g)) {
    const expression = block(text, match.index! + match[0].length - 1).trim()
    const body = /^[\w$.]+$/.test(expression) ? definition(text, expression.split('.').at(-1)!) : expression
    if (DISMISSAL.test(body)) found.push(`${expression.split('\n')[0]!.slice(0, 80)}`)
  }
  return found
}

test('the guard recognizes the hand-rolled blur dismissals that caused the regressions', () => {
  const inline = `<div onBlur={(event) => { const next = event.relatedTarget; if (next && !contains(next)) setOpen(false) }}>`
  const named = `const onBlur = (event) => {\n  if (outside(event)) setOpen(false)\n}\n<button onBlur={onBlur} />`
  const preview = `<div onBlurCapture={(event) => { if (!inside(event.relatedTarget)) onDismiss() }} />`
  const details = `<details onBlur={() => { if (detailsRef.current) detailsRef.current.open = false }} />`
  for (const source of [inline, named, preview, details]) expect(blurDismissals(source)).toHaveLength(1)
  // Non-popup blur handlers stay legal.
  expect(blurDismissals(`<input onBlur={() => commit(entries)} />`)).toEqual([])
  expect(blurDismissals(`<input onBlur={() => setFocusedOption(null)} />`)).toEqual([])
  expect(blurDismissals(`<Field onBlur={onBlur} />`)).toEqual([])
})

test('no component closes a popup from its own blur or focusout handler', () => {
  const offenders = sources().flatMap(({ path, text }) =>
    BLUR_ALLOWLIST[path] ? [] : blurDismissals(text).map((handler) => `${path}: ${handler}`)
  )
  expect(offenders).toEqual([])
})

test('no component reads relatedTarget or adds its own outside-press/focus-loss listener', () => {
  const listener = /addEventListener\(\s*['"](pointerdown|mousedown|touchstart|focusout|blur)['"]/
  const offenders = sources().flatMap(({ path, text }) => [
    ...(/\brelatedTarget\b/.test(text) ? [`${path}: reads relatedTarget`] : []),
    ...(listener.test(text) && !LISTENER_ALLOWLIST[path] ? [`${path}: ${listener.exec(text)![0]}`] : []),
  ])
  expect(offenders).toEqual([])
})

test('the primitive documents the rule this guard enforces', () => {
  const doc = readFileSync(join(SRC, PRIMITIVE), 'utf8')
  expect(doc).toContain(relative(SRC, join(SRC, 'components/popupDismissal.guard.test.ts')))
  expect(doc).toContain('Never close a popup from a component')
})
