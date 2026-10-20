import { describe, expect, test } from 'bun:test'
import { FICUS_DARK_ICON_COLORS, parseThemeIconColor, recolorMark, themeIconColors } from './theme-icon'

/** The built-in Ficus light pair, as the theme CSS defines it. */
const FICUS_LIGHT = {
  tile: '241 233 219',
  primary: '63 107 79',
  primaryHover: '74 126 93',
  primaryLight: '74 126 93',
  text: '41 36 30',
  secondary: '176 88 47',
  tertiary: '138 154 91',
}

/** moegiiro: a three-color theme whose secondary swatch is its own background. */
const MOEGIIRO = {
  tile: '40 106 60',
  primary: '255 218 82',
  primaryHover: '255 237 69',
  primaryLight: '255 255 198',
  text: '247 234 248',
  secondary: '40 106 60',
  tertiary: '247 234 248',
}

describe('themeIconColors', () => {
  test('Ficus light reproduces the brand mark on linen', () => {
    expect(themeIconColors(FICUS_LIGHT, { themeId: 'ficus', appearance: 'light' })).toEqual({
      tile: '#f1e9db',
      leaf: '#3f6b4f',
      pot: '#b0582f',
      sideLeaves: '#8a9a5b',
    })
  })

  test('built-in Ficus dark keeps the bundled dark icon, whatever its tokens', () => {
    expect(themeIconColors(FICUS_LIGHT, { themeId: 'ficus', appearance: 'dark' })).toEqual(FICUS_DARK_ICON_COLORS)
  })

  test('a custom theme gets no built-in exception', () => {
    expect(themeIconColors(FICUS_LIGHT)?.leaf).toBe('#3f6b4f')
  })

  test('a primary too dark for its tile gives way to a lighter shade', () => {
    // Iris dark: primary #5b21b6 and its hover fall short of 3:1 on #090a12.
    const colors = themeIconColors({
      tile: '9 10 18',
      primary: '91 33 182',
      primaryHover: '109 40 217',
      primaryLight: '196 181 253',
      text: '226 232 240',
      secondary: '168 85 247',
      tertiary: '196 181 253',
    })
    expect(colors?.leaf).toBe('#c4b5fd')
    // The tertiary swatch would merge with that leaf, so the side leaves blend the leaf into the tile.
    expect(colors?.sideLeaves).toBe('#706893')
  })

  test('a three-color theme gets a darkened-leaf pot, never its near-white text color', () => {
    expect(themeIconColors(MOEGIIRO)).toEqual({
      tile: '#286a3c',
      leaf: '#ffda52',
      pot: '#a68e35',
      sideLeaves: '#9ea848',
    })
  })

  test('on a near-black tile the derived pot lightens instead, so it stays visible', () => {
    // nurebairo: the leaf darkened 35% still clears the tile, so it is kept.
    expect(
      themeIconColors({
        tile: '33 25 31',
        primary: '207 113 122',
        primaryHover: '235 125 136',
        primaryLight: '255 240 243',
        text: '221 233 244',
        secondary: '33 25 31',
        tertiary: '221 233 244',
      })?.pot
    ).toBe('#87494f')
    const dim = themeIconColors({
      tile: '0 0 0',
      primary: '85 85 85',
      primaryHover: '85 85 85',
      primaryLight: '85 85 85',
      text: '85 85 85',
      secondary: '0 0 0',
      tertiary: '255 255 255',
    })
    // Darkened, a gray-85 leaf's pot would all but vanish on black, so it is lightened.
    expect(dim?.pot).toBe('#919191')
  })

  test('a missing or unreadable token yields no icon', () => {
    expect(themeIconColors({ ...FICUS_LIGHT, secondary: undefined })).toBeNull()
    expect(themeIconColors({ ...FICUS_LIGHT, secondary: 'var(--x)' })).toBeNull()
  })
})

describe('parseThemeIconColor', () => {
  test('reads channels, alpha channels and hex', () => {
    expect(parseThemeIconColor('63 107 79')).toEqual([63, 107, 79])
    expect(parseThemeIconColor('63.4 107.6 79 / 0.5')).toEqual([63, 108, 79])
    expect(parseThemeIconColor('#3F6B4F')).toEqual([63, 107, 79])
    expect(parseThemeIconColor('300 -2 0')).toEqual([255, 0, 0])
    expect(parseThemeIconColor('63 107')).toBeNull()
  })
})

describe('recolorMark', () => {
  test('recolors each brand fill once, even when a new color is another part’s brand fill', () => {
    const markup = '<path fill="#3f6b4f"/><path fill="#8A9A5B"/><path fill="#b0582f"/>'
    expect(recolorMark(markup, { leaf: '#b0582f', sideLeaves: '#3f6b4f', pot: '#111111' })).toBe(
      '<path fill="#b0582f"/><path fill="#3f6b4f"/><path fill="#111111"/>'
    )
  })
})
