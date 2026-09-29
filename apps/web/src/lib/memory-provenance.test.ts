import { describe, expect, it } from 'bun:test'
import { MEMORY_PROVENANCE_MARKER, parseMemoryProvenance, stripProvenanceBlock } from './memory-provenance'

const block =
  '<!--ficus:memory-provenance [{"sourceSquadId":"squad-aaaa","path":"/memory/a.md","title":"A","sourceType":"memory_file","sensitivity":"internal","score":0.9,"documentId":"d1"}] -->'

describe('parseMemoryProvenance', () => {
  it('extracts the provenance array', () => {
    const result = `Found 1 result(s):\n\n**1. /memory/a.md**\n${block}`
    const p = parseMemoryProvenance(result)
    expect(p).toHaveLength(1)
    expect(p![0].sourceSquadId).toBe('squad-aaaa')
    expect(p![0].sensitivity).toBe('internal')
  })

  it('returns null when no block is present', () => {
    expect(parseMemoryProvenance('No matching documents found.')).toBeNull()
  })

  it('returns null on malformed JSON (fails closed)', () => {
    expect(parseMemoryProvenance('<!--ficus:memory-provenance [not json] -->')).toBeNull()
  })
})

describe('stripProvenanceBlock', () => {
  it('removes the comment so human text renders clean', () => {
    expect(stripProvenanceBlock(`hi\n${block}`).trim()).toBe('hi')
  })
})

describe('the provenance marker', () => {
  it('is the ficus one', () => {
    expect(MEMORY_PROVENANCE_MARKER).toBe('ficus:memory-provenance')
    expect(block).toStartWith('<!--ficus:memory-provenance ')
  })

  it('is the only one read: Core migration 0196 rewrote the pre-rename marker in stored results (Task 36c)', () => {
    const preRename = block.replace('<!--ficus:', '<!--tau:') // ficus-negative-test
    expect(parseMemoryProvenance(`Found 1 result(s):\n${preRename}`)).toBeNull()
  })
})
