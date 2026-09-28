import { afterEach, beforeEach, describe, it, expect } from 'bun:test'
import { buildMemorySystemPrompt } from './memory-prompt'
import { boxUnixUser } from '../../services/machines/box-paths'

describe('buildMemorySystemPrompt', () => {
  it('namespaces the memory vault paths under the squad id', () => {
    const p = buildMemorySystemPrompt('sq1', '# map')
    expect(p).toContain('/memory/sq1/map.md')
    expect(p).toContain('/memory/sq1/context.md')
    expect(p).toContain('/memory/sq1')
    expect(p).not.toContain('vault at `/memory`')
  })

  describe('vm runtime', () => {
    let prev: string | undefined
    beforeEach(() => {
      prev = process.env.FICUS_SANDBOX_RUNTIME
      process.env.FICUS_SANDBOX_RUNTIME = 'vm'
    })
    afterEach(() => {
      if (prev === undefined) delete process.env.FICUS_SANDBOX_RUNTIME
      else process.env.FICUS_SANDBOX_RUNTIME = prev
    })

    it('uses the squad box-native memory + workspace paths, no container literals', () => {
      const home = `/home/${boxUnixUser('squad_sq1')}`
      const p = buildMemorySystemPrompt('sq1', '# map')
      expect(p).toContain(`vault at \`${home}/memory\``)
      expect(p).toContain(`${home}/memory/context.md`)
      expect(p).toContain(`${home}/workspace/docs/plans/`)
      expect(p).not.toContain('`/memory')
      expect(p).not.toContain('/memory/sq1')
      expect(p).not.toContain('/workspace/sq1')
    })
  })
})
