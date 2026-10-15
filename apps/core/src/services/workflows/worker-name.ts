/** Longest work stream title (in characters, ellipsis included) carried into a flow worker's name. */
export const FLOW_WORKER_TITLE_MAX = 60

/**
 * Shortens a title to at most `max` characters. A long title ends with an
 * ellipsis at a word boundary, so names never stop mid-word with no sign
 * they were cut (a single overlong word is still cut, with the ellipsis).
 */
export function shortenTitle(title: string, max = FLOW_WORKER_TITLE_MAX): string {
  const trimmed = title.trim()
  // Code points, so a cut never splits an emoji or other surrogate pair.
  const chars = Array.from(trimmed)
  if (chars.length <= max) return trimmed
  let cut = chars.slice(0, max - 1).join('')
  // Back up to the last word break unless that throws away most of the room.
  const lastSpace = cut.search(/\s\S*$/)
  if (lastSpace >= Math.floor(max / 2)) cut = cut.slice(0, lastSpace)
  return `${cut.replace(/[\s,.;:·\-–—]+$/u, '')}…`
}

/** The display name for a flow worker created for one participant of a work stream. */
export function flowWorkerName(participant: string, streamTitle: string): string {
  return `${participant} · ${shortenTitle(streamTitle)}`
}
