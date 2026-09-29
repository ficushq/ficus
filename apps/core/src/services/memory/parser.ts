/**
 * Markdown parser for memory documents.
 *
 * Handles:
 * - YAML frontmatter extraction
 * - Wikilink parsing ([[Page]], [[Page#Heading]], [[Page|Alias]])
 * - Content chunking for embedding
 * - Content hashing for change detection
 */

import { createHash } from 'crypto'
import * as yaml from 'yaml'

// ============================================================================
// Types
// ============================================================================

export interface ParsedFrontmatter {
  frontmatter: Record<string, unknown>
  content: string
}

export interface WikiLink {
  target: string
  heading?: string
  alias?: string
  raw: string
}

export interface ContentChunk {
  index: number
  content: string
  startLine: number
  endLine: number
  metadata: {
    heading?: string
    headingLevel?: number
  }
}

export interface ChunkOptions {
  maxChunkSize?: number
  minChunkSize?: number
  overlapSize?: number
}

const DEFAULT_CHUNK_OPTIONS: Required<ChunkOptions> = {
  maxChunkSize: 2000,
  minChunkSize: 100,
  overlapSize: 100,
}

// ============================================================================
// Frontmatter Parsing
// ============================================================================

/**
 * Extract YAML frontmatter from markdown content.
 * Returns the parsed frontmatter object and the remaining content.
 */
export function parseFrontmatter(content: string): ParsedFrontmatter {
  if (!content || !content.startsWith('---')) {
    return { frontmatter: {}, content }
  }

  // Find closing delimiter
  const endIndex = content.indexOf('\n---', 3)
  if (endIndex === -1) {
    // No closing delimiter - treat as no frontmatter
    return { frontmatter: {}, content }
  }

  const yamlContent = content.slice(4, endIndex)
  let remainingContent = content.slice(endIndex + 4)

  // Remove leading newlines after frontmatter close (typically 1-2 newlines before content)
  remainingContent = remainingContent.replace(/^\n+/, '')

  try {
    const parsed = yaml.parse(yamlContent)
    return {
      frontmatter: parsed && typeof parsed === 'object' ? parsed : {},
      content: remainingContent,
    }
  } catch {
    // Invalid YAML - treat as no frontmatter
    return { frontmatter: {}, content }
  }
}

// ============================================================================
// Wikilink Parsing
// ============================================================================

/**
 * Wikilink regex: [[target#heading|alias]]
 * - target: required, the page name or path
 * - heading: optional, after #
 * - alias: optional, after |
 */
const WIKILINK_REGEX = /\[\[([^\]#|]+)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]/g

/**
 * Code block patterns to filter out links inside code
 */
const FENCED_CODE_BLOCK_REGEX = /```[\s\S]*?```/g
const INLINE_CODE_REGEX = /`[^`]+`/g

/**
 * Parse wikilinks from markdown content.
 * Ignores links inside code blocks.
 */
export function parseWikilinks(content: string): WikiLink[] {
  // Remove code blocks before searching for links
  const cleanedContent = content.replace(FENCED_CODE_BLOCK_REGEX, '').replace(INLINE_CODE_REGEX, '')

  const links: WikiLink[] = []
  let match: RegExpExecArray | null

  while ((match = WIKILINK_REGEX.exec(cleanedContent)) !== null) {
    links.push({
      target: match[1].trim(),
      heading: match[2]?.trim(),
      alias: match[3]?.trim(),
      raw: match[0],
    })
  }

  return links
}

// ============================================================================
// Content Chunking
// ============================================================================

/**
 * Heading regex - matches # Heading, ## Heading, etc.
 */
const HEADING_REGEX = /^(#{1,6})\s+(.+)$/

/** A code fence line; `# comment` lines inside a fence are not headings. */
const FENCE_REGEX = /^\s{0,3}(```|~~~)/

export interface MarkdownHeading {
  heading: string
  level: number
  /** 1-based line number within the content. */
  line: number
}

/**
 * The headings of a markdown body, in order, skipping fenced code.
 */
export function readHeadings(content: string): MarkdownHeading[] {
  const headings: MarkdownHeading[] = []
  let inFence = false
  content.split('\n').forEach((line, index) => {
    if (FENCE_REGEX.test(line)) {
      inFence = !inFence
      return
    }
    const match = inFence ? null : line.match(HEADING_REGEX)
    if (match) headings.push({ heading: match[2].trim(), level: match[1].length, line: index + 1 })
  })
  return headings
}

/**
 * Chunk markdown content for embedding.
 *
 * Strategy:
 * 1. Split by headings first
 * 2. If sections exceed maxChunkSize, split further by paragraphs
 * 3. Preserve heading context in chunk metadata
 */
export function chunkMarkdown(content: string, options: ChunkOptions = {}): ContentChunk[] {
  const opts = { ...DEFAULT_CHUNK_OPTIONS, ...options }

  if (!content.trim()) {
    return []
  }

  const lines = content.split('\n')
  const chunks: ContentChunk[] = []

  let currentChunk: string[] = []
  let currentHeading: string | undefined
  let currentHeadingLevel: number | undefined
  let chunkStartLine = 1
  let lineNumber = 1

  const flushChunk = () => {
    const chunkContent = currentChunk.join('\n').trim()
    if (chunkContent) {
      // If chunk is too large, split it further
      const subChunks = splitLargeChunk(chunkContent, opts.maxChunkSize, chunkStartLine)
      for (const subChunk of subChunks) {
        chunks.push({
          index: chunks.length,
          content: subChunk.content,
          startLine: subChunk.startLine,
          endLine: subChunk.endLine,
          metadata: {
            heading: currentHeading,
            headingLevel: currentHeadingLevel,
          },
        })
      }
    }
    currentChunk = []
    chunkStartLine = lineNumber
  }

  let inFence = false

  for (const line of lines) {
    if (FENCE_REGEX.test(line)) inFence = !inFence
    const headingMatch = inFence ? null : line.match(HEADING_REGEX)

    if (headingMatch) {
      // Flush current chunk before starting new section
      flushChunk()

      currentHeading = headingMatch[2]
      currentHeadingLevel = headingMatch[1].length
      chunkStartLine = lineNumber
    }

    currentChunk.push(line)
    lineNumber++
  }

  // Flush final chunk
  flushChunk()

  return chunks
}

/**
 * Split text by sentences or word boundaries when it exceeds maxSize.
 */
function splitBySentences(
  content: string,
  maxSize: number,
  startLine: number
): Array<{ content: string; startLine: number; endLine: number }> {
  const result: Array<{ content: string; startLine: number; endLine: number }> = []
  let remaining = content
  let currentLine = startLine

  while (remaining.length > 0) {
    let splitPoint = maxSize

    if (remaining.length <= maxSize) {
      const lineCount = remaining.split('\n').length
      result.push({
        content: remaining,
        startLine: currentLine,
        endLine: currentLine + lineCount - 1,
      })
      break
    }

    // Try to find a sentence boundary (. ! ?)
    const sentenceEnd = remaining.slice(0, maxSize).lastIndexOf('. ')
    if (sentenceEnd > maxSize / 2) {
      splitPoint = sentenceEnd + 2
    } else {
      // Fall back to word boundary (space)
      const spaceEnd = remaining.slice(0, maxSize).lastIndexOf(' ')
      if (spaceEnd > maxSize / 2) {
        splitPoint = spaceEnd + 1
      }
    }

    const chunk = remaining.slice(0, splitPoint).trim()
    const chunkLines = chunk.split('\n').length

    result.push({
      content: chunk,
      startLine: currentLine,
      endLine: currentLine + chunkLines - 1,
    })

    currentLine += chunkLines
    remaining = remaining.slice(splitPoint).trim()
  }

  return result
}

/**
 * Split a large chunk into smaller pieces by paragraph breaks, sentences, or words.
 */
function splitLargeChunk(
  content: string,
  maxSize: number,
  startLine: number
): Array<{ content: string; startLine: number; endLine: number }> {
  if (content.length <= maxSize) {
    const lineCount = content.split('\n').length
    return [{ content, startLine, endLine: startLine + lineCount - 1 }]
  }

  // First try splitting by paragraphs
  const paragraphs = content.split(/\n\n+/)

  if (paragraphs.length > 1) {
    const result: Array<{ content: string; startLine: number; endLine: number }> = []
    let currentContent = ''
    let currentStartLine = startLine
    let currentLineCount = 0

    const flushAccumulated = () => {
      if (!currentContent) return

      // If accumulated content is still too large, split by sentences
      if (currentContent.length > maxSize) {
        const subChunks = splitBySentences(currentContent, maxSize, currentStartLine)
        result.push(...subChunks)
      } else {
        result.push({
          content: currentContent,
          startLine: currentStartLine,
          endLine: currentStartLine + currentLineCount - 1,
        })
      }
    }

    for (const para of paragraphs) {
      const paraLines = para.split('\n').length
      const potentialContent = currentContent ? `${currentContent}\n\n${para}` : para

      if (potentialContent.length > maxSize && currentContent) {
        // Flush current accumulated content
        flushAccumulated()

        currentContent = para
        currentStartLine = currentStartLine + currentLineCount + 1
        currentLineCount = paraLines
      } else {
        currentContent = potentialContent
        currentLineCount += (currentContent === para ? 0 : 1) + paraLines
      }
    }

    // Flush remaining content
    flushAccumulated()

    if (result.length > 0) {
      return result
    }
  }

  // Fallback: split by sentences or word boundaries
  return splitBySentences(content, maxSize, startLine)
}

// ============================================================================
// Line-Based Chunking (non-markdown files)
// ============================================================================

export interface LineChunkOptions {
  maxLines?: number
}

const DEFAULT_MAX_LINES = 80

/**
 * Chunk content by line count. Splits on blank lines when possible,
 * hard-splits at maxLines otherwise. For non-markdown files.
 */
export function chunkByLines(content: string, options: LineChunkOptions = {}): ContentChunk[] {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES

  if (!content.trim()) {
    return []
  }

  const lines = content.split('\n')
  const chunks: ContentChunk[] = []

  let start = 0

  while (start < lines.length) {
    let end = Math.min(start + maxLines, lines.length)

    if (end < lines.length) {
      // Look backward for a blank line to split on (within the last 30% of the chunk)
      const searchStart = Math.max(start + Math.floor(maxLines * 0.7), start)
      let bestSplit = -1
      for (let i = end - 1; i >= searchStart; i--) {
        if (lines[i].trim() === '') {
          bestSplit = i + 1
          break
        }
      }
      if (bestSplit > start) {
        end = bestSplit
      }
    }

    const chunkLines = lines.slice(start, end)
    const chunkContent = chunkLines.join('\n').trimEnd()

    if (chunkContent) {
      chunks.push({
        index: chunks.length,
        content: chunkContent,
        startLine: start + 1,
        endLine: start + chunkLines.length,
        metadata: {},
      })
    }

    start = end
  }

  return chunks
}

// ============================================================================
// Binary Detection
// ============================================================================

/**
 * Check if content appears to be binary by looking for null bytes
 * in the first 512 bytes.
 */
export function isBinaryContent(buffer: Buffer): boolean {
  const checkLength = Math.min(buffer.length, 512)
  for (let i = 0; i < checkLength; i++) {
    if (buffer[i] === 0) return true
  }
  return false
}

// ============================================================================
// Hashing
// ============================================================================

/**
 * Compute a stable hash of content for change detection.
 */
export function computeContentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}
