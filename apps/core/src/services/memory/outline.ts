/**
 * Document outlines: the heading tree of an indexed document.
 *
 * Agents browse this map to find the section they need, then read just that
 * section, instead of relying on similarity search to guess it.
 */

import { readHeadings } from './parser'

export interface OutlineHeading {
  heading: string
  level: number
  /** 1-based first line of the section (the heading line). */
  startLine: number
}

export interface OutlineSection extends OutlineHeading {
  /** Last line of the section, including its subsections. */
  endLine: number
  /** Ancestor headings, outermost first, ending with this heading. */
  trail: string[]
}

/**
 * Turn ordered headings into sections. A section runs until the next heading
 * at the same or a higher level.
 */
export function buildSections(headings: OutlineHeading[], lastLine: number): OutlineSection[] {
  const stack: OutlineSection[] = []
  const sections: OutlineSection[] = []
  for (const heading of headings) {
    while (stack.length > 0 && stack[stack.length - 1].level >= heading.level) {
      stack.pop()!.endLine = heading.startLine - 1
    }
    const section: OutlineSection = {
      ...heading,
      endLine: lastLine,
      trail: [...stack.map((parent) => parent.heading), heading.heading],
    }
    stack.push(section)
    sections.push(section)
  }
  for (const open of stack) open.endLine = Math.max(open.startLine, lastLine)
  return sections
}

/** Sections of a markdown body, computed from its text. */
export function outlineMarkdown(content: string): OutlineSection[] {
  const headings = readHeadings(content).map(({ heading, level, line }) => ({ heading, level, startLine: line }))
  return buildSections(headings, content.split('\n').length)
}

const TRAIL_SEPARATOR = /\s*(?:>|›|»)\s*/

function normalizeHeading(value: string): string {
  return value
    .replace(/^#+\s*/, '')
    .trim()
    .toLowerCase()
}

/**
 * Sections whose heading trail ends with the requested one. `section` is a
 * heading ("Rollout") or a trail suffix ("Deploy > Rollout"), matched
 * case-insensitively.
 */
export function findSections(sections: OutlineSection[], section: string): OutlineSection[] {
  const wanted = section.split(TRAIL_SEPARATOR).map(normalizeHeading).filter(Boolean)
  if (wanted.length === 0) return []
  return sections.filter((candidate) => {
    if (candidate.trail.length < wanted.length) return false
    const tail = candidate.trail.slice(-wanted.length).map(normalizeHeading)
    return tail.every((heading, index) => heading === wanted[index])
  })
}

/** The lines of `content` covered by `section`. */
export function sliceSection(content: string, section: OutlineSection): string {
  return content
    .split('\n')
    .slice(section.startLine - 1, section.endLine)
    .join('\n')
    .trimEnd()
}

export function formatTrail(trail: string[]): string {
  return trail.join(' › ')
}
