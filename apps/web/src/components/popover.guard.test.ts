/**
 * Source guard for floating UI (see `components/popover/Popover.md`): every popup — menu, picker, panel,
 * hover card, autocomplete list — renders through the `components/popover` module, which owns anchoring,
 * edge-aware placement, the portal, `usePopupDismiss`, the `Presence` animation, focus and ARIA. A
 * component that positions its own floating surface (`absolute top-full`, `fixed` + `ficus-overlay`, a
 * floating `role="menu"`/`"listbox"`), animates one with `Presence`, or portals one itself fails here.
 * The allowlist is deliberately tiny and each entry says why it is not an anchored popup.
 */
import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(import.meta.dir, '..')
const MODULE = 'components/popover/'

/** Files that may use `Presence`, `createPortal` or floating markup, and why. */
const ALLOWLIST: Record<string, string> = {
  'components/Presence.tsx': 'the animation primitive itself',
  'components/Modal.tsx': 'the modal dialog/sheet primitive (scrim, focus trap), not an anchored popup',
  'components/MobileChatOptionsSheet.tsx': 'a modal bottom sheet (dialog), not an anchored popup',
  'components/ExpandableChatPanel.tsx': 'portals the chat into a host slot in the layout; nothing floats',
  'components/WorkStreamList.tsx': 'portals the Filters trigger into its header slot; the panel is a Popover',
  // Follow-ups: scrim-dismissed header sheets opened by app events, not anchored to a trigger.
  'components/InboxPopup.tsx': 'scrimmed header sheet opened by an app event (follow-up: move to Panel)',
  'components/ActionCenterPanel.tsx': 'scrimmed header sheet, currently unused (follow-up: move to Panel)',
}

/** Popups that were migrated onto the module; each must keep rendering through it. */
const MIGRATED = [
  'components/ThemedPopup.tsx',
  'components/OverflowMenu.tsx',
  'components/WorkStreamActionsMenu.tsx',
  'components/ThemeQuickPicker.tsx',
  'components/WorkStreamFiltersPopover.tsx',
  'components/EntityReferencePreview.tsx',
  'components/AttentionMenu.tsx',
  'components/FileMentionAutocomplete.tsx',
  'components/AppNav.tsx',
  'components/AssistantSnapMenu.tsx',
  'components/AssistantConversations.tsx',
  'components/settings/SettingsNavigation.tsx',
  'voice/VoiceCompanionWidget.tsx',
  // Found by this guard: hand-built menus with no dismissal at all.
  'components/SquadDetailPage.tsx',
  'components/ChatDrawer.tsx',
]

function sources(): Array<{ path: string; text: string }> {
  const files: Array<{ path: string; text: string }> = []
  for (const entry of new Bun.Glob('**/*.{ts,tsx}').scanSync({ cwd: SRC })) {
    const path = entry.replaceAll('\\', '/')
    if (/\.(test|spec)\.tsx?$/.test(path) || path.startsWith('test/') || path.startsWith(MODULE)) continue
    files.push({ path, text: readFileSync(join(SRC, path), 'utf8') })
  }
  return files
}

/** Every JSX opening tag (`<Name …>`), read up to its closing `>` outside braces and strings. */
function openingTags(text: string): string[] {
  const tags: string[] = []
  for (const match of text.matchAll(/<[A-Za-z][\w.]*/g)) {
    let depth = 0
    let quote = ''
    for (let index = match.index! + match[0].length; index < text.length; index++) {
      const char = text[index]!
      if (quote) {
        if (char === quote && text[index - 1] !== '\\') quote = ''
      } else if (char === '"' || char === "'" || char === '`') quote = char
      else if (char === '{') depth++
      else if (char === '}') depth--
      else if (char === '>' && depth === 0) {
        tags.push(text.slice(match.index!, index + 1))
        break
      } else if (char === '<' && depth === 0) break // not a tag after all (a comparison or generic)
    }
  }
  return tags
}

const POSITIONED = /(?<![\w-])(?:absolute|fixed)(?![\w-])/
const FLOATING_HINT = /ficus-overlay|role=["'](?:menu|listbox)["']|(?<![\w-])(?:top|bottom)-full(?![\w-])/
// Not popups: a CSS-only tooltip, transient status/alert notes beside a control, and decoration that
// takes no pointer input at all.
const NOT_A_POPUP = /role=["'](?:tooltip|status|alert)["']|pointer-events-none/

/** The hand-built floating surfaces in `text`: a `Presence`, a `createPortal`, or self-positioned overlay markup. */
function handBuiltPopups(text: string): string[] {
  const found: string[] = []
  if (/<Presence\b/.test(text)) found.push('renders <Presence>')
  if (/\bcreatePortal\(/.test(text)) found.push('calls createPortal')
  for (const tag of openingTags(text)) {
    if (tag.startsWith('<Presence')) continue
    if (POSITIONED.test(tag) && FLOATING_HINT.test(tag) && !NOT_A_POPUP.test(tag))
      found.push(`positions its own floating surface: ${tag.replace(/\s+/g, ' ').slice(0, 100)}`)
  }
  return found
}

test('the guard recognizes the hand-built popups this module replaced', () => {
  const oldPatterns = {
    overflowMenu: `<Presence ref={surface} open={open} className="ficus-overlay absolute right-0 top-full z-30 mt-1 w-44">`,
    themedPopup: `createPortal(<div ref={popupRef} role={role} className="ficus-overlay fixed z-[90] overflow-y-auto">`,
    actionsMenu: `{open && (\n  <div className="ficus-overlay absolute right-0 top-full z-30 mt-1 w-72 rounded-lg">`,
    switcher: `<div\n  id="assistant-conversations"\n  className="absolute top-full left-3 right-3 z-20 ficus-glass shadow-theme-lg rounded-xl p-2"\n>`,
    fileMention: `<div ref={containerRef} className="ficus-overlay fixed z-50 bg-surface" style={{ bottom: \`calc(100vh - \${top}px)\` }}>`,
    snapMenu: `<div ref={menu} role="menu" style={{ top: place.top }} className="fixed z-[70] w-60 rounded-lg">`,
    attention: `<div className={clsx(inline ? 'p-3' : 'ficus-overlay absolute top-full z-30 mt-1 w-64', 'left-0')}>`,
  }
  for (const [name, source] of Object.entries(oldPatterns))
    expect([name, handBuiltPopups(source).length > 0]).toEqual([name, true])

  // Popovers, CSS-only tooltips, status notes, inline lists and badges stay legal.
  expect(handBuiltPopups(`<Menu {...popover.popoverProps} className="ficus-overlay w-44 p-1">`)).toEqual([])
  expect(
    handBuiltPopups(`<div role="tooltip" className="ficus-overlay pointer-events-none absolute top-full">`)
  ).toEqual([])
  expect(handBuiltPopups(`<span role="status" className="absolute right-0 top-full z-30 mt-1">`)).toEqual([])
  expect(handBuiltPopups(`<div id="results" role="listbox" aria-label="Search results">`)).toEqual([])
  expect(handBuiltPopups(`<span className="absolute -top-1 -right-1 rounded-full">{count}</span>`)).toEqual([])
  expect(handBuiltPopups(`<div className="pointer-events-none absolute bottom-full left-3">`)).toEqual([])
  expect(handBuiltPopups(`const ref = useRef<HTMLDivElement>(null); if (a < b && c > d) {}`)).toEqual([])
})

test('no component outside the popover module hand-builds a floating popup', () => {
  const offenders = sources().flatMap(({ path, text }) =>
    ALLOWLIST[path] ? [] : handBuiltPopups(text).map((reason) => `${path}: ${reason}`)
  )
  expect(offenders).toEqual([])
})

test('every allowlisted file still exists and still needs its entry', () => {
  const stale = Object.keys(ALLOWLIST).filter(
    (path) =>
      path !== 'components/Presence.tsx' &&
      (!existsSync(join(SRC, path)) || handBuiltPopups(readFileSync(join(SRC, path), 'utf8')).length === 0)
  )
  expect(stale).toEqual([])
})

test('every migrated popup renders through the popover module', () => {
  const offenders = MIGRATED.filter(
    (path) => !/from '(?:\.\.?\/)+(?:components\/)?popover(?:\/\w+)?'/.test(readFileSync(join(SRC, path), 'utf8'))
  )
  expect(offenders).toEqual([])
})

test('the module documents its API and the WebKit tap testing rule', () => {
  const doc = readFileSync(join(SRC, MODULE, 'Popover.md'), 'utf8')
  for (const name of ['Popover', 'usePopover', 'Menu', 'Picker', 'Panel', 'HoverCard', 'ComboboxList', 'webkitTap'])
    expect(doc).toContain(name)
  expect(doc).toContain('popover.guard.test.ts')
})
