import { describe, expect, it } from 'bun:test'
import { buildSections, findSections, formatTrail, outlineMarkdown, sliceSection } from './outline'

const doc = [
  '# Deploy', //                     1
  'How we ship.', //                 2
  '## Staging', //                   3
  'Push to staging first.', //       4
  '### Rollout', //                  5
  'Staging rollout is instant.', //  6
  '## Production', //                7
  '### Rollout', //                  8
  'Production rolls out by 10%.', // 9
  '# Appendix', //                   10
  'Links.', //                       11
].join('\n')

describe('outline', () => {
  it('builds nested sections that run until the next same-or-higher heading', () => {
    const sections = outlineMarkdown(doc)
    expect(sections.map((s) => [formatTrail(s.trail), s.startLine, s.endLine])).toEqual([
      ['Deploy', 1, 9],
      ['Deploy › Staging', 3, 6],
      ['Deploy › Staging › Rollout', 5, 6],
      ['Deploy › Production', 7, 9],
      ['Deploy › Production › Rollout', 8, 9],
      ['Appendix', 10, 11],
    ])
  })

  it('handles a document that starts below level 1 and skips levels', () => {
    const sections = buildSections(
      [
        { heading: 'Notes', level: 2, startLine: 1 },
        { heading: 'Deep', level: 4, startLine: 3 },
        { heading: 'Next', level: 2, startLine: 5 },
      ],
      6
    )
    expect(sections.map((s) => [formatTrail(s.trail), s.endLine])).toEqual([
      ['Notes', 4],
      ['Notes › Deep', 4],
      ['Next', 6],
    ])
  })

  it('finds sections by heading or trail suffix, case-insensitively', () => {
    const sections = outlineMarkdown(doc)
    expect(findSections(sections, 'rollout').map((s) => s.startLine)).toEqual([5, 8])
    expect(findSections(sections, 'Production > Rollout').map((s) => s.startLine)).toEqual([8])
    expect(findSections(sections, 'Deploy › Production › Rollout').map((s) => s.startLine)).toEqual([8])
    expect(findSections(sections, '## Staging').map((s) => s.startLine)).toEqual([3])
    expect(findSections(sections, 'Missing')).toEqual([])
    expect(findSections(sections, ' > ')).toEqual([])
  })

  it('slices a section with its subsections', () => {
    const [production] = findSections(outlineMarkdown(doc), 'Production')
    expect(sliceSection(doc, production)).toBe('## Production\n### Rollout\nProduction rolls out by 10%.')
  })
})
