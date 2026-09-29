import { describe, expect, it } from 'bun:test'
import type { ContentBlock } from '@ficus/shared'
import { groupBlocks, groupSummary, resultText, thinkingLabel, toolSummary } from './blocks'

const tool = (id: string, toolName = 'bash', args = '{}'): ContentBlock => ({
  type: 'tool_use',
  id,
  toolCall: { toolCallId: id, toolName, args, result: 'ok', isError: false },
})

describe('groupBlocks', () => {
  it('collapses runs of tool/thinking blocks between text blocks', () => {
    const blocks: ContentBlock[] = [
      { type: 'thinking', id: 't1', content: 'hmm' },
      tool('b1'),
      { type: 'text', id: 'x1', content: 'Done' },
      tool('b2'),
    ]
    const groups = groupBlocks(blocks)
    expect(groups.map((g) => g.type)).toEqual(['group', 'single', 'single'])
    expect(groupSummary(groups[0].type === 'group' ? groups[0].blocks : [])).toBe('1 tool • 1 thinking')
  })
})

describe('toolSummary', () => {
  it('summarises well-known tools like the web', () => {
    expect(toolSummary('bash', JSON.stringify({ command: 'ls -la' }))).toBe('ls -la')
    expect(toolSummary('read', JSON.stringify({ path: 'src/a.ts', offset: 10, limit: 5 }))).toBe('src/a.ts:10-15')
    expect(toolSummary('edit', JSON.stringify({ path: 'src/deep/file.ts' }))).toBe('file.ts')
    expect(toolSummary('ask_human', JSON.stringify({ questions: [{}, {}] }))).toBe('2 questions')
    expect(toolSummary('grep', JSON.stringify({ pattern: 'TODO', path: 'src' }))).toBe('"TODO" src')
  })

  it('returns null for unknown tools or unparseable args, and truncates long summaries', () => {
    expect(toolSummary('mystery', '{}')).toBeNull()
    expect(toolSummary('bash', '{not json')).toBeNull()
    expect(toolSummary('bash', JSON.stringify({ command: 'x'.repeat(80) }))).toBe(`${'x'.repeat(50)}...`)
  })
})

describe('resultText / thinkingLabel', () => {
  it('unwraps text content results', () => {
    expect(
      resultText(
        JSON.stringify({ content: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }] })
      )
    ).toBe('a\nb')
    expect(resultText('plain')).toBe('plain')
  })

  it('labels thinking like the web', () => {
    expect(thinkingLabel(2345)).toBe('Thought for 2.3s')
    expect(thinkingLabel(undefined)).toBe('Thought for a moment')
    expect(thinkingLabel(undefined, 4)).toBe('Thinking for 4s…')
  })
})
