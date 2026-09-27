import { describe, expect, test } from 'bun:test'
import { HOST_RUNTIME_NOTE } from './hostRuntime'

describe('host runtime copy', () => {
  // This paragraph is shown to people USING Ficus (agent panel, settings), not to
  // people reading the repository — a source path is an instruction they cannot
  // follow.
  test('the note points at documentation without citing a repo file path', () => {
    expect(HOST_RUNTIME_NOTE).toContain('host runtime documentation')
    expect(HOST_RUNTIME_NOTE).not.toContain('docs/')
    expect(HOST_RUNTIME_NOTE).not.toContain('.md')
  })

  test('the note still explains what the host runtime means', () => {
    expect(HOST_RUNTIME_NOTE).toContain('Agents run directly on this machine as the Ficus process user')
    expect(HOST_RUNTIME_NOTE).toContain('no sandbox to start or stop')
  })
})
