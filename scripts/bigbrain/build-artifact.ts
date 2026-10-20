#!/usr/bin/env bun
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { buildBigbrainArtifact } from './artifact'

if (import.meta.main) {
  try {
    const args = process.argv.slice(2)
    if (args.length !== 2 || args[0] !== '--out-dir' || !args[1]) throw new Error('invalid_request')
    const bunVersion = (await readFile(new URL('../../.bun-version', import.meta.url), 'utf8')).trim()
    const result = await buildBigbrainArtifact({ outDir: resolve(args[1]), bunVersion })
    console.log(`BIGBRAIN_ARTIFACT_DIGEST=${result.digest}`)
  } catch {
    console.error('BigBrain artifact build failed')
    process.exitCode = 1
  }
}
