import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { acquireDomHarness } from '../../test/domHarness'
import { attachLegacyAltArrowKeys, isMacPlatform, legacyAltArrowSequence } from './altArrowKeys'

const ESC = '\x1b'
const ARROWS = [
  { key: 'ArrowLeft', keyCode: 37, final: 'D' },
  { key: 'ArrowUp', keyCode: 38, final: 'A' },
  { key: 'ArrowRight', keyCode: 39, final: 'C' },
  { key: 'ArrowDown', keyCode: 40, final: 'B' },
] as const

// The bytes xterm 5.5.0 sent for a plain Alt+arrow (the HACK blocks in its
// src/common/input/Keyboard.ts, removed by xtermjs/xterm.js PR 5346).
const XTERM_5_5_ALT_ARROW = {
  linux: { ArrowLeft: `${ESC}[1;5D`, ArrowRight: `${ESC}[1;5C`, ArrowUp: `${ESC}[1;5A`, ArrowDown: `${ESC}[1;5B` },
  mac: { ArrowLeft: `${ESC}b`, ArrowRight: `${ESC}f`, ArrowUp: undefined, ArrowDown: undefined },
} as const

type Modifiers = { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }

const MODIFIER_SETS: Modifiers[] = Array.from({ length: 16 }, (_, bits) => ({
  shiftKey: !!(bits & 1),
  altKey: !!(bits & 2),
  ctrlKey: !!(bits & 4),
  metaKey: !!(bits & 8),
}))

/** xterm 5.5 output on Linux/Windows: its generic modifier formula plus the Alt-only translation. */
function xterm55Bytes(key: (typeof ARROWS)[number]['key'], final: string, modifiers: Modifiers) {
  if (modifiers.metaKey) return [] // Cmd/Win+arrow is left to the browser.
  const bits = (modifiers.shiftKey ? 1 : 0) | (modifiers.altKey ? 2 : 0) | (modifiers.ctrlKey ? 4 : 0)
  if (bits === 2) return [XTERM_5_5_ALT_ARROW.linux[key]]
  return [bits ? `${ESC}[1;${bits + 1}${final}` : `${ESC}[${final}`]
}

/** Drive the real xterm 6 keydown path and capture what onData would send to the shell. */
async function withRealTerminal(
  attach: boolean,
  run: (press: (init: KeyboardEventInit & { keyCode: number }) => string[]) => void
) {
  const harness = await acquireDomHarness({ url: 'https://ficus.test' })
  const { Terminal } = await import('@xterm/xterm')
  const terminal = new Terminal()
  try {
    const container = harness.window.document.createElement('div')
    harness.window.document.body.append(container)
    // Under Bun xterm detects a non-macOS platform, matching Linux/Windows users.
    if (attach) attachLegacyAltArrowKeys(terminal, false)
    terminal.open(container as unknown as HTMLElement)
    let sent: string[] = []
    terminal.onData((data) => sent.push(data))
    run((init) => {
      sent = []
      const event = new harness.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init } as never)
      terminal.textarea!.dispatchEvent(event as never)
      return sent
    })
  } finally {
    terminal.dispose()
    await harness.cleanup()
  }
}

describe('Alt+arrow keeps the xterm 5.5 bytes on xterm 6', () => {
  test('xterm 6 by itself sends the standard Alt sequences (the upstream change this restores)', async () => {
    await withRealTerminal(false, (press) => {
      expect(press({ key: 'ArrowLeft', keyCode: 37, altKey: true })).toEqual([`${ESC}[1;3D`])
      expect(press({ key: 'ArrowRight', keyCode: 39, altKey: true })).toEqual([`${ESC}[1;3C`])
    })
  })

  test('Linux and Windows: every arrow and modifier combination sends what xterm 5.5 sent', async () => {
    await withRealTerminal(true, (press) => {
      for (const { key, keyCode, final } of ARROWS) {
        for (const modifiers of MODIFIER_SETS) {
          expect({ key, modifiers, sent: press({ key, keyCode, ...modifiers }) }).toEqual({
            key,
            modifiers,
            sent: xterm55Bytes(key, final, modifiers),
          })
        }
      }
    })
  })

  test('macOS: Alt+Left/Right send readline meta-b/f; Alt+Up/Down and other modifiers stay with xterm', () => {
    for (const { key } of ARROWS) {
      for (const modifiers of MODIFIER_SETS) {
        const plainAlt = modifiers.altKey && !modifiers.ctrlKey && !modifiers.metaKey && !modifiers.shiftKey
        const expected = plainAlt ? XTERM_5_5_ALT_ARROW.mac[key] : undefined
        expect(legacyAltArrowSequence({ type: 'keydown', key, isComposing: false, ...modifiers }, true)).toBe(expected)
      }
    }
  })

  test('only plain Alt+arrow keydowns are translated', () => {
    const alt = { altKey: true, ctrlKey: false, metaKey: false, shiftKey: false, isComposing: false }
    expect(legacyAltArrowSequence({ type: 'keyup', key: 'ArrowLeft', ...alt }, false)).toBeUndefined()
    expect(
      legacyAltArrowSequence({ type: 'keydown', key: 'ArrowLeft', ...alt, isComposing: true }, false)
    ).toBeUndefined()
    expect(legacyAltArrowSequence({ type: 'keydown', key: 'b', ...alt }, false)).toBeUndefined()
    expect(legacyAltArrowSequence({ type: 'keydown', key: 'Home', ...alt }, false)).toBeUndefined()
  })

  test('platform detection matches xterm', () => {
    for (const platform of ['Macintosh', 'MacIntel', 'MacPPC', 'Mac68K']) expect(isMacPlatform(platform)).toBe(true)
    for (const platform of ['Linux x86_64', 'Win32', 'iPad', 'iPhone', '']) expect(isMacPlatform(platform)).toBe(false)
  })
})

describe('attachLegacyAltArrowKeys', () => {
  function harness(isMac: boolean) {
    let handler: ((event: KeyboardEvent) => boolean) | undefined
    const sent: Array<[string, boolean | undefined]> = []
    attachLegacyAltArrowKeys(
      {
        attachCustomKeyEventHandler: (next) => {
          handler = next
        },
        input: (data, wasUserInput) => {
          sent.push([data, wasUserInput])
        },
      },
      isMac
    )
    const press = (key: string, modifiers: Partial<Modifiers>, type = 'keydown') => {
      const calls = { preventDefault: 0, stopPropagation: 0 }
      const event = {
        type,
        key,
        isComposing: false,
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        ...modifiers,
        preventDefault: () => calls.preventDefault++,
        stopPropagation: () => calls.stopPropagation++,
      }
      return { handled: handler!(event as unknown as KeyboardEvent), calls }
    }
    return { press, sent }
  }

  test('sends the legacy bytes as user input and cancels the browser default (Alt+Left is history Back)', () => {
    const { press, sent } = harness(false)
    const result = press('ArrowLeft', { altKey: true })
    expect(result.handled).toBe(false)
    expect(result.calls).toEqual({ preventDefault: 1, stopPropagation: 1 })
    expect(sent).toEqual([[`${ESC}[1;5D`, true]])
  })

  test('macOS Alt+Left/Right send readline meta-b/f', () => {
    const { press, sent } = harness(true)
    press('ArrowLeft', { altKey: true })
    press('ArrowRight', { altKey: true })
    expect(sent).toEqual([
      [`${ESC}b`, true],
      [`${ESC}f`, true],
    ])
  })

  test('leaves every other key to xterm', () => {
    const { press, sent } = harness(false)
    for (const result of [
      press('ArrowLeft', {}),
      press('ArrowLeft', { altKey: true, shiftKey: true }),
      press('ArrowLeft', { altKey: true }, 'keyup'),
      press('a', { altKey: true }),
    ]) {
      expect(result.handled).toBe(true)
      expect(result.calls).toEqual({ preventDefault: 0, stopPropagation: 0 })
    }
    expect(sent).toEqual([])
  })

  test('the interactive terminal attaches it before opening', () => {
    const source = readFileSync(new URL('./Terminal.tsx', import.meta.url), 'utf8')
    const attach = source.indexOf('attachLegacyAltArrowKeys(terminal)')
    expect(attach).toBeGreaterThan(-1)
    expect(attach).toBeLessThan(source.indexOf('terminal.open(container)'))
  })
})
