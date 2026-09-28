import { readFileSync } from 'node:fs'
import postcss from 'postcss'
import { BUILT_IN_THEMES, IRIS_THEME } from '../registry'
export { resolveToken, tokenRgba, composite, contrast, contrastPairs, pairRatio } from '../contrast'

export interface Palette {
  id: string
  appearance: 'light' | 'dark' | 'constant'
  selector: string
  tokens: Record<string, string>
}
export const palettes: Palette[] = BUILT_IN_THEMES.flatMap((theme) =>
  (theme.kind === 'unified' ? (['constant'] as const) : (['light', 'dark'] as const)).map((appearance) => {
    const selector =
      theme.id === IRIS_THEME.id
        ? appearance === 'dark'
          ? '.dark'
          : ':root'
        : `:root[data-theme="${theme.id}"]${appearance === 'constant' ? '' : `[data-appearance="${appearance}"]`}`
    const css = postcss.parse(
      readFileSync(new URL(theme.id === IRIS_THEME.id ? '../../index.css' : '../builtins.css', import.meta.url), 'utf8')
    )
    const tokens: Record<string, string> = {}
    css.walkRules((rule) => {
      if (rule.selector.split(',')[0]!.trim().replaceAll("'", '"') !== selector) return
      rule.walkDecls((decl) => {
        tokens[decl.prop] = decl.value
      })
    })
    return { id: theme.id, appearance, selector, tokens }
  })
)
