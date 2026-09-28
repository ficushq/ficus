import { extractAgentAttachmentReferences } from '@ficus/shared'

export interface TextSelection {
  start: number
  end: number
}

export function insertAttachmentReference(
  text: string,
  reference: string,
  selection?: TextSelection
): { text: string; caret: number } {
  const start = selection?.start ?? text.length
  const end = selection?.end ?? text.length
  const before = text.slice(0, start)
  const after = text.slice(end)
  const leading = before && !/\s$/.test(before) ? ' ' : ''
  const trailing = after && /^\s/.test(after) ? '' : ' '
  const inserted = `${leading}${reference}${trailing}`
  return { text: before + inserted + after, caret: start + inserted.length }
}

export function removeAttachmentReferences(text: string, reference: string): string {
  const path = reference.startsWith('@') ? reference.slice(1) : reference
  const matches = extractAgentAttachmentReferences(text).filter((candidate) => candidate.path === path)
  let result = text
  for (const match of matches.reverse()) {
    result = result.slice(0, match.start) + result.slice(match.end)
  }
  return result
}

export function repairAttachmentReference(text: string, staleReference: string, canonicalReference: string): string {
  const stalePath = staleReference.startsWith('@') ? staleReference.slice(1) : staleReference
  const matches = extractAgentAttachmentReferences(text).filter((candidate) => candidate.path === stalePath)
  let result = text
  for (const match of matches.reverse()) {
    result = result.slice(0, match.start) + canonicalReference + result.slice(match.end)
  }
  return result
}
