import { expect, test } from 'bun:test'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
const src = join(import.meta.dir, '../..')
test('active entrypoints have no automated transcript projector, route or delivery worker', async () => {
  for (const file of [
    'index.ts',
    'worker.ts',
    'services/integrations/runtime.ts',
    'services/integrations/plugin.ts',
    'services/integrations/bigbrain/plugin.ts',
  ]) {
    const source = await readFile(join(src, file), 'utf8')
    expect(source).not.toMatch(
      /integration-export|external-export|ExportCompletionProjector|conversationExport|conversation_export|sendBigbrainSession/
    )
  }
  expect(await readdir(import.meta.dir)).not.toContain('export')
})
test('API and worker shutdown both reap local BigBrain processes', async () => {
  for (const file of ['index.ts', 'worker.ts'])
    expect(await readFile(join(src, file), 'utf8')).toContain('stopAllBigbrainProcesses')
})
