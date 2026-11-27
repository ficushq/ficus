/**
 * Escape a sender-supplied attachment name or type for display to a model: no markup, no control
 * characters. Inbox delivery, `read_attachment` and assignment manifests all use it for inbox files.
 */
export function sanitizeAttachmentDisplayText(value: string): string {
  return value.replace(/[\\`*_{}[\]()<>#+!|~]/g, '\\$&').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (character) => {
    if (character === '\n') return '\\n'
    if (character === '\r') return '\\r'
    if (character === '\t') return '\\t'
    return `\\u${character.codePointAt(0)!.toString(16).padStart(4, '0')}`
  })
}
