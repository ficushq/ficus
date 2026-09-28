import { ACTIVE_THEME_TOKENS } from '@ficus/shared/theme-schema'

export type ThemeColors = Readonly<Record<string, string | undefined>>

/** Expand Number's shortest round-trippable representation without rounding.
 * tinycolor2 and xterm's fast parser do not accept scientific notation, even
 * though CSS does. Fixed precision would erase valid tiny alpha/products.
 * Called only for finite numbers; retaining all digits also covers subnormals.
 */
function decimalNumber(value: number): string {
  const [mantissa, exponent] = String(value).split('e')
  if (exponent === undefined) return mantissa!
  const sign = value < 0 ? '-' : ''
  const [integer, fraction = ''] = mantissa!.replace('-', '').split('.')
  const digits = integer! + fraction
  const point = integer!.length + Number(exponent)
  if (point <= 0) return `${sign}0.${'0'.repeat(-point)}${digits}`
  if (point >= digits.length) return sign + digits + '0'.repeat(point - digits.length)
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`
}

/** Concrete comma-form colors work in Canvas2D, Three/tinycolor, xterm and Vega.
 * Alpha in channel values and separate intrinsic-opacity metadata MULTIPLY;
 * sentinels deliberately remain absent rather than becoming invalid colors.
 */
export function tokenColor(channels: string, intrinsicOpacity = '1'): string | undefined {
  if (!channels || channels === 'none' || channels === 'auto') return undefined
  const [rgb, alpha = '1'] = channels.split('/').map((part) => part.trim())
  const parts = rgb!.split(/\s+/).map(Number)
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return undefined
  const opacity = (alpha.endsWith('%') ? Number.parseFloat(alpha) / 100 : Number(alpha)) * Number(intrinsicOpacity)
  if (!Number.isFinite(opacity)) return undefined
  const concrete = parts.map(decimalNumber).join(', ')
  return opacity === 1 ? `rgb(${concrete})` : `rgba(${concrete}, ${decimalNumber(opacity)})`
}

export function readTokenColor(style: Pick<CSSStyleDeclaration, 'getPropertyValue'>, token: string) {
  const metadata = `--opacity-${token.replace(/^--(?:color-)?/, '')}`
  return tokenColor(style.getPropertyValue(token).trim(), style.getPropertyValue(metadata).trim() || '1')
}

/** One computed-style read per applied scope/override revision, shared by JS
 * consumers. The root attributes are the phase-0 applyResolvedTheme surface.
 * Observing them also catches inline custom overrides, without a React provider
 * ordering race. Signatures make imperative reads synchronous even before the
 * observer fires. No observer survives the last subscriber.
 */
export function createTokenReader(root: Element) {
  const view = root.ownerDocument.defaultView!
  const attributes = ['class', 'style', 'data-theme', 'data-appearance']
  let signature: string | undefined
  let snapshot: ThemeColors
  let observer: MutationObserver | undefined
  const listeners = new Set<() => void>()
  const getSnapshot = (): ThemeColors => {
    const next = JSON.stringify(attributes.map((attribute) => root.getAttribute(attribute)))
    if (!snapshot || next !== signature) {
      signature = next
      const style = view.getComputedStyle(root)
      snapshot = Object.freeze(
        Object.fromEntries(ACTIVE_THEME_TOKENS.map((token) => [token, readTokenColor(style, token)]))
      )
    }
    return snapshot
  }
  const subscribe = (listener: () => void) => {
    listeners.add(listener)
    if (!observer) {
      observer = new view.MutationObserver(() => {
        getSnapshot()
        listeners.forEach((notify) => notify())
      })
      observer.observe(root, { attributes: true, attributeFilter: attributes })
    }
    return () => {
      listeners.delete(listener)
      if (!listeners.size) {
        observer?.disconnect()
        observer = undefined
      }
    }
  }
  return { getSnapshot, subscribe }
}

const readers = new WeakMap<Element, ReturnType<typeof createTokenReader>>()
export function themeTokenReader(root: Element) {
  let reader = readers.get(root)
  if (!reader) {
    reader = createTokenReader(root)
    readers.set(root, reader)
  }
  return reader
}
