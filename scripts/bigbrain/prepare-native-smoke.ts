#!/usr/bin/env bun
import { resolve } from 'node:path'
import { prepareBigbrainNativeSmoke } from './artifact'

if (import.meta.main) {
  try {
    const [artifact, destination, ...extra] = process.argv.slice(2)
    if (!artifact || !destination || extra.length) throw new Error('invalid_request')
    await prepareBigbrainNativeSmoke({ artifactDir: resolve(artifact), outDir: resolve(destination) })
    console.log('Pinned native BigBrain fixture dependencies prepared')
  } catch {
    console.error('Native BigBrain fixture preparation failed')
    process.exitCode = 1
  }
}
