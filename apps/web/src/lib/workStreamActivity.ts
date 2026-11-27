/** The Activity page filtered to one stream. */
export function workStreamActivityHref(workStreamId: string): string {
  return `/activity?${new URLSearchParams({ workStream: workStreamId })}`
}
