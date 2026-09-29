import { describe, it, expect } from 'bun:test'
import { parseFrontmatter, parseWikilinks, chunkMarkdown, computeContentHash, readHeadings } from './parser'

describe('parser', () => {
  describe('parseFrontmatter', () => {
    it('extracts YAML frontmatter from markdown', () => {
      const content = `---
title: Test Document
kind: decision
tags: [auth, backend]
importance: 0.8
---

# Content starts here

Some text.`

      const result = parseFrontmatter(content)

      expect(result.frontmatter).toEqual({
        title: 'Test Document',
        kind: 'decision',
        tags: ['auth', 'backend'],
        importance: 0.8,
      })
      expect(result.content).toBe('# Content starts here\n\nSome text.')
    })

    it('returns empty frontmatter when none exists', () => {
      const content = `# Just a heading

Some content.`

      const result = parseFrontmatter(content)

      expect(result.frontmatter).toEqual({})
      expect(result.content).toBe(content)
    })

    it('handles empty document', () => {
      const result = parseFrontmatter('')

      expect(result.frontmatter).toEqual({})
      expect(result.content).toBe('')
    })

    it('handles frontmatter with no content after', () => {
      const content = `---
title: Metadata Only
---`

      const result = parseFrontmatter(content)

      expect(result.frontmatter).toEqual({ title: 'Metadata Only' })
      expect(result.content).toBe('')
    })

    it('handles malformed frontmatter gracefully', () => {
      const content = `---
title: Missing closing delimiter

# Content starts here`

      // Should treat entire document as content since frontmatter is not closed
      const result = parseFrontmatter(content)

      expect(result.frontmatter).toEqual({})
      expect(result.content).toBe(content)
    })

    it('handles complex nested frontmatter', () => {
      const content = `---
id: mem_01JABCXYZ
title: "JWT Auth Decision"
kind: decision
tags:
  - auth
  - backend
createdAt: 2026-02-22T00:20:00Z
metadata:
  reviewed: true
  reviewer: alice
---

Content here.`

      const result = parseFrontmatter(content)

      expect(result.frontmatter.id).toBe('mem_01JABCXYZ')
      expect(result.frontmatter.title).toBe('JWT Auth Decision')
      expect(result.frontmatter.tags).toEqual(['auth', 'backend'])
      expect(result.frontmatter.metadata).toEqual({ reviewed: true, reviewer: 'alice' })
    })
  })

  describe('parseWikilinks', () => {
    it('extracts basic wikilinks', () => {
      const content = `See [[Page]] and [[Other Page]] for more info.`

      const links = parseWikilinks(content)

      expect(links).toHaveLength(2)
      expect(links[0]).toEqual({ target: 'Page', heading: undefined, alias: undefined, raw: '[[Page]]' })
      expect(links[1]).toEqual({ target: 'Other Page', heading: undefined, alias: undefined, raw: '[[Other Page]]' })
    })

    it('extracts wikilinks with headings', () => {
      const content = `See [[Page#Section]] and [[Doc#Sub Heading]] for details.`

      const links = parseWikilinks(content)

      expect(links).toHaveLength(2)
      expect(links[0]).toEqual({ target: 'Page', heading: 'Section', alias: undefined, raw: '[[Page#Section]]' })
      expect(links[1]).toEqual({ target: 'Doc', heading: 'Sub Heading', alias: undefined, raw: '[[Doc#Sub Heading]]' })
    })

    it('extracts wikilinks with aliases', () => {
      const content = `See [[Page|this page]] and [[Other|another link]].`

      const links = parseWikilinks(content)

      expect(links).toHaveLength(2)
      expect(links[0]).toEqual({ target: 'Page', heading: undefined, alias: 'this page', raw: '[[Page|this page]]' })
      expect(links[1]).toEqual({
        target: 'Other',
        heading: undefined,
        alias: 'another link',
        raw: '[[Other|another link]]',
      })
    })

    it('extracts wikilinks with both heading and alias', () => {
      const content = `See [[Page#Section|the section]] for more.`

      const links = parseWikilinks(content)

      expect(links).toHaveLength(1)
      expect(links[0]).toEqual({
        target: 'Page',
        heading: 'Section',
        alias: 'the section',
        raw: '[[Page#Section|the section]]',
      })
    })

    it('handles multiple links on same line', () => {
      const content = `Links: [[A]], [[B]], [[C]]`

      const links = parseWikilinks(content)

      expect(links).toHaveLength(3)
      expect(links.map((l) => l.target)).toEqual(['A', 'B', 'C'])
    })

    it('handles links with file paths', () => {
      const content = `See [[folder/subfolder/Page]] for details.`

      const links = parseWikilinks(content)

      expect(links).toHaveLength(1)
      expect(links[0].target).toBe('folder/subfolder/Page')
    })

    it('returns empty array when no links', () => {
      const content = `Just plain text without any links.`

      const links = parseWikilinks(content)

      expect(links).toEqual([])
    })

    it('ignores links inside code blocks', () => {
      const content = `Regular [[Link]]

\`\`\`
[[CodeBlock Link]]
\`\`\`

And \`[[inline code]]\` too.

Another [[Regular Link]].`

      const links = parseWikilinks(content)

      // Should only find the two regular links
      expect(links).toHaveLength(2)
      expect(links.map((l) => l.target)).toEqual(['Link', 'Regular Link'])
    })
  })

  describe('chunkMarkdown', () => {
    it('chunks by headings', () => {
      const content = `# Introduction

This is the intro paragraph.
It has multiple lines.

# Methods

The methods section.

## Sub-method

More content here.

# Conclusion

Final thoughts.`

      const chunks = chunkMarkdown(content)

      expect(chunks.length).toBeGreaterThanOrEqual(3)
      expect(chunks[0].content).toContain('Introduction')
      expect(chunks[0].metadata.heading).toBe('Introduction')
    })

    it('respects maximum chunk size', () => {
      // Create a very long paragraph
      const longParagraph = 'Lorem ipsum dolor sit amet. '.repeat(500)
      const content = `# Long Section\n\n${longParagraph}`

      const chunks = chunkMarkdown(content, { maxChunkSize: 1000 })

      // Should be split into multiple chunks
      expect(chunks.length).toBeGreaterThan(1)

      // Each chunk should be under the limit (with some tolerance for heading context)
      for (const chunk of chunks) {
        expect(chunk.content.length).toBeLessThanOrEqual(1200) // Allow some overflow for context
      }
    })

    it('preserves chunk ordering with indices', () => {
      const content = `# A\n\nFirst.\n\n# B\n\nSecond.\n\n# C\n\nThird.`

      const chunks = chunkMarkdown(content)

      for (let i = 0; i < chunks.length; i++) {
        expect(chunks[i].index).toBe(i)
      }
    })

    it('includes line numbers in chunks', () => {
      const content = `# First

Content.

# Second

More content.`

      const chunks = chunkMarkdown(content)

      expect(chunks[0].startLine).toBe(1)
      expect(chunks[0].endLine).toBeGreaterThan(1)
    })

    it('handles empty content', () => {
      const chunks = chunkMarkdown('')

      expect(chunks).toEqual([])
    })

    it('handles content without headings', () => {
      const content = `Just a plain paragraph.

And another one.

With some text.`

      const chunks = chunkMarkdown(content)

      expect(chunks.length).toBeGreaterThanOrEqual(1)
    })
  })

  describe('headings in code fences', () => {
    const content = [
      '# Setup',
      '',
      '```bash',
      '# install deps',
      'bun install',
      '```',
      '',
      '## Run',
      '',
      '~~~',
      '# not a heading either',
      '~~~',
    ].join('\n')

    it('chunkMarkdown does not start a section at a # comment inside a fence', () => {
      const headings = chunkMarkdown(content).map((chunk) => chunk.metadata.heading)
      expect(headings).toEqual(['Setup', 'Run'])
    })

    it('readHeadings lists real headings with their levels and lines', () => {
      expect(readHeadings(content)).toEqual([
        { heading: 'Setup', level: 1, line: 1 },
        { heading: 'Run', level: 2, line: 8 },
      ])
    })
  })

  describe('computeContentHash', () => {
    it('returns consistent hash for same content', () => {
      const content = 'test content'

      const hash1 = computeContentHash(content)
      const hash2 = computeContentHash(content)

      expect(hash1).toBe(hash2)
    })

    it('returns different hash for different content', () => {
      const hash1 = computeContentHash('content 1')
      const hash2 = computeContentHash('content 2')

      expect(hash1).not.toBe(hash2)
    })

    it('returns hex string', () => {
      const hash = computeContentHash('test')

      expect(typeof hash).toBe('string')
      expect(hash).toMatch(/^[a-f0-9]+$/)
    })
  })
})
