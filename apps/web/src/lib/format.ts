/** Format a token count with appropriate unit suffix (e.g. 847, 45.2k, 1.1M) */
export function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`
  return String(count)
}

/**
 * A context-window percentage to one decimal (e.g. 7.2%). Whole percents hide a
 * turn's progress on large windows: on a 1M-token window one agent step adds
 * roughly 0.05-0.5%, so a rounded label sits on the same number for many steps
 * and looks frozen even though the value behind it updates after every message.
 */
export function formatContextPercent(percent: number): string {
  return `${percent.toFixed(1)}%`
}
