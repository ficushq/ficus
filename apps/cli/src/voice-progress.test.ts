import { expect, test } from 'bun:test'
import { formatVoiceProgress, withDerivationSignals, VoiceDerivationCancelled } from './voice-progress'
test('progress prints plain readable lines without terminal control characters', () => {
  expect(
    formatVoiceProgress({
      version: 1,
      runId: 'fixture',
      seq: 1,
      type: 'repositories',
      repositories: [{ name: 'example/library', activity: 'reading_commits' }],
    })
  ).toEqual(['Reading commits in example/library.'])
  expect(
    formatVoiceProgress({
      version: 1,
      runId: 'fixture',
      seq: 2,
      type: 'finding',
      index: 0,
      text: 'Use \u001b[31mshort sentences.',
    })[0]
  ).not.toContain('\u001b')
})
test('signals abort the request and restore listeners with conventional exit codes', async () => {
  const handlers = new Map<string, () => void>()
  const pending = withDerivationSignals(
    async (signal) => {
      handlers.get('SIGTERM')!()
      expect(signal.aborted).toBe(true)
      return 1
    },
    {
      on: (name, fn) => {
        handlers.set(name, fn)
      },
      off: (name) => {
        handlers.delete(name)
      },
    }
  )
  await expect(pending).rejects.toMatchObject({ exitCode: 143 })
  expect(handlers.size).toBe(0)
  expect(new VoiceDerivationCancelled(130).message).toContain('Nothing was saved')
})
