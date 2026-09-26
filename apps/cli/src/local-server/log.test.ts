import { describe, expect, it } from 'bun:test'
import { colorEnabled, styleNarration } from './log'

const BLUE = '\x1b[94m'
const BOLD = '\x1b[1m'
const YELLOW = '\x1b[33m'
const RESET = '\x1b[0m'

describe('styleNarration', () => {
  it('tints step headers bold light blue and plan details light blue', () => {
    expect(styleNarration('▸ Build', true)).toBe(`${BOLD}${BLUE}▸ Build${RESET}`)
    expect(styleNarration('Preflight (host, compose database, port 3000)', true)).toStartWith(`${BOLD}${BLUE}`)
    expect(styleNarration('Plan:', true)).toBe(`${BOLD}${BLUE}Plan:${RESET}`)
    expect(styleNarration('Dry run — nothing will be changed. Plan:', true)).toStartWith(`${BOLD}${BLUE}`)
    expect(styleNarration('    bun run build:core', true)).toBe(`${BLUE}    bun run build:core${RESET}`)
  })
  it('paints warnings yellow and leaves other lines untouched', () => {
    expect(styleNarration('  warning: tmux is not installed', true)).toBe(
      `${YELLOW}  warning: tmux is not installed${RESET}`
    )
    expect(styleNarration('Ficus is running at http://localhost:3000', true)).toBe(
      'Ficus is running at http://localhost:3000'
    )
    expect(styleNarration('', true)).toBe('')
  })
  it('is the identity when colour is off', () => {
    expect(styleNarration('▸ Build', false)).toBe('▸ Build')
    expect(styleNarration('    bun run build:core', false)).toBe('    bun run build:core')
  })
})

describe('colorEnabled', () => {
  it('needs a TTY and no NO_COLOR/dumb TERM', () => {
    expect(colorEnabled({}, true)).toBe(true)
    expect(colorEnabled({}, false)).toBe(false)
    expect(colorEnabled({ NO_COLOR: '1' }, true)).toBe(false)
    expect(colorEnabled({ TERM: 'dumb' }, true)).toBe(false)
  })
})
