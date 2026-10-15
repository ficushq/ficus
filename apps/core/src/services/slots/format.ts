/** Compact human-readable claim timeout, e.g. `45m`, `1h`, `1d`. */
export function formatSlotClaimTimeout(claimTimeoutMs: number): string {
  if (claimTimeoutMs % 86_400_000 === 0) return `${claimTimeoutMs / 86_400_000}d`
  if (claimTimeoutMs % 3_600_000 === 0) return `${claimTimeoutMs / 3_600_000}h`
  if (claimTimeoutMs % 60_000 === 0) return `${claimTimeoutMs / 60_000}m`
  return `${Math.round(claimTimeoutMs / 1_000)}s`
}
