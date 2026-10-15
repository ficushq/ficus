/**
 * Images returned by tool calls (a `read` of a PNG, a browser screenshot, ...).
 *
 * A tool result is the Pi SDK JSON string `{"content":[{"type":"text",...},{"type":"image","mimeType":...,"data":<base64>}]}`.
 * The image parts are turned into `data:` URLs the chat can show as thumbnails; anything that is not a well-formed
 * raster image is skipped, so a malformed part never reaches an `<img>`.
 */

export interface ToolResultImage {
  /** Unique within one tool call (or one group, when prefixed with the tool call id). */
  id: string
  src: string
  alt: string
}

/** Raster types only: a data URL is rendered as-is, and these are the formats tools actually return. */
const IMAGE_MIME_TYPE = /^image\/(png|jpe?g|gif|webp|bmp|avif)$/i
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/
/** Cheap pre-check so the (common) results without images are never JSON-parsed here. */
const HAS_IMAGE_PART = /"type"\s*:\s*"image"/
/** The text the `read` tool puts in front of an image; the thumbnail replaces it. */
const READ_IMAGE_PLACEHOLDER_LINE = /^Read image file \[[^\]\n]*\]\s*$/

/** The `data:` URLs of a result's well-formed image parts, in order. */
export function imageSrcsFromContent(content: unknown): string[] {
  if (!Array.isArray(content)) return []
  const srcs: string[] = []
  for (const part of content) {
    if (!part || typeof part !== 'object') continue
    const { type, mimeType, data } = part as { type?: unknown; mimeType?: unknown; data?: unknown }
    if (type !== 'image' || typeof mimeType !== 'string' || typeof data !== 'string') continue
    if (!IMAGE_MIME_TYPE.test(mimeType)) continue
    const base64 = data.replace(/\s+/g, '')
    if (!base64 || !BASE64.test(base64)) continue
    srcs.push(`data:${mimeType.toLowerCase()};base64,${base64}`)
  }
  return srcs
}

// Image-bearing results are large (tens of KB of base64) and streaming re-renders a group on every delta,
// so the parse is remembered per result string. Bounded: only the most recent results are kept.
const SRC_CACHE_LIMIT = 64
const srcCache = new Map<string, string[]>()

function resultImageSrcs(result: string | undefined | null): string[] {
  if (!result || !HAS_IMAGE_PART.test(result)) return []
  const cached = srcCache.get(result)
  if (cached) return cached
  let srcs: string[] = []
  try {
    srcs = imageSrcsFromContent((JSON.parse(result) as { content?: unknown } | null)?.content)
  } catch {
    srcs = []
  }
  if (srcCache.size >= SRC_CACHE_LIMIT) srcCache.delete(srcCache.keys().next().value!)
  srcCache.set(result, srcs)
  return srcs
}

/** Alt text for a tool's images: the file path it read when there is one, otherwise the tool name. */
export function toolImageAlt(toolName: string, args?: string | null): string {
  if (args) {
    try {
      const parsed = JSON.parse(args) as { path?: unknown } | null
      if (typeof parsed?.path === 'string' && parsed.path.trim()) return parsed.path.trim()
    } catch {
      /* fall through */
    }
  }
  return `Image from ${toolName}`
}

/** The thumbnails for one tool result. `idPrefix` keeps ids unique when several calls share a strip. */
export function extractResultImages(
  result: string | undefined | null,
  { alt = 'Tool result image', idPrefix = '' }: { alt?: string; idPrefix?: string } = {}
): ToolResultImage[] {
  const srcs = resultImageSrcs(result)
  return srcs.map((src, index) => ({
    id: `${idPrefix}${index}`,
    src,
    alt: srcs.length > 1 ? `${alt} (image ${index + 1} of ${srcs.length})` : alt,
  }))
}

/** The images a tool call returned, ready for a thumbnail strip. */
export function toolCallImages(toolCall: {
  toolCallId: string
  toolName: string
  args?: string | null
  result?: string | null
}): ToolResultImage[] {
  if (!toolCall.result || !HAS_IMAGE_PART.test(toolCall.result)) return []
  return extractResultImages(toolCall.result, {
    alt: toolImageAlt(toolCall.toolName, toolCall.args),
    idPrefix: `${toolCall.toolCallId}:`,
  })
}

/** Every image read by a run of tool calls, in order (a collapsed group's thumbnails). */
export function blocksImages(blocks: ReadonlyArray<{ type: string; toolCall?: Parameters<typeof toolCallImages>[0] }>) {
  return blocks.flatMap((block) => (block.type === 'tool_use' && block.toolCall ? toolCallImages(block.toolCall) : []))
}

/** Drop the read tool's "Read image file [image/png]" line; any other text (a resize note, say) stays. */
export function withoutImagePlaceholder(text: string): string {
  if (!text.includes('Read image file [')) return text
  return text
    .split('\n')
    .filter((line) => !READ_IMAGE_PLACEHOLDER_LINE.test(line))
    .join('\n')
}
