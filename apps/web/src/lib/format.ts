/** Format a token count with appropriate unit suffix (e.g. 847, 45.2k, 1.1M) */
export function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`
  return String(count)
}

/**
 * A context-window percentage to one decimal (e.g. 7.2%), for the detailed
 * readout beside the token counts. On a 1M-token window one agent step adds
 * roughly 0.05-0.5%, so the decimal is what shows a turn's progress there; the
 * compact label beside the composer's ring rounds to whole percents instead.
 */
export function formatContextPercent(percent: number): string {
  return `${percent.toFixed(1)}%`
}
