/** Markdown reduced to readable plain text, for a clamped preview. */
export function workflowReviewPlainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/[*_~`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Compact gate-kind description, never per-round authorization. */
export function humanGateSubtitle(instructions: string, fallback: string): string {
  const text = workflowReviewPlainText(instructions)
  const sentence =
    [...new Intl.Segmenter(undefined, { granularity: 'sentence' }).segment(text)][0]?.segment.trim() || fallback
  return `Human approval · ${sentence.length <= 160 ? sentence : sentence.slice(0, 160).replace(/\s+\S*$/, '') + '…'}`
}
