/** Whether a resolved token color (`rgb(...)` or `rgba(...)`) is a dark surface. */
export function isDarkColor(color: string | undefined): boolean {
  const channels = color
    ?.match(/^rgba?\(([^)]+)\)$/)?.[1]
    ?.split(',')
    .map(Number)
  if (!channels || channels.length < 3 || channels.slice(0, 3).some((value) => !Number.isFinite(value))) return false
  const [red, green, blue] = channels.map((value) => {
    const unit = value / 255
    return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4
  })
  // Below this luminance, light text contrasts better than dark text.
  return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue! < 0.179
}
