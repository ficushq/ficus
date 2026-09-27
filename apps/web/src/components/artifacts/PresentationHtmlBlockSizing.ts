import { PRESENTATION_HTML_HEIGHT_MESSAGE } from '@ficus/shared/browser-keys'

export function getPresentationHtmlHeightMessageType(): string {
  return PRESENTATION_HTML_HEIGHT_MESSAGE
}

export function clampHtmlBlockHeight(height: number, minHeight: number, maxHeight: number): number {
  const upperBound = Math.max(minHeight, maxHeight)
  return Math.max(minHeight, Math.min(upperBound, Math.ceil(height)))
}

export function isPresentationHtmlHeightMessage(data: unknown, blockId: string): data is { height: number } {
  if (!data || typeof data !== 'object') return false

  const message = data as { type?: unknown; blockId?: unknown; height?: unknown }
  return (
    message.type === PRESENTATION_HTML_HEIGHT_MESSAGE &&
    message.blockId === blockId &&
    typeof message.height === 'number' &&
    Number.isFinite(message.height)
  )
}
