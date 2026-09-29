import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  effectiveMachineScripts,
  isArtifactDeployment,
  readArtifactManifest,
  readPrebuiltMachineFile,
  readPrebuiltMachineText,
} from './machine-prebuilt'

describe('machine-prebuilt', () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'machine-prebuilt-'))
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  describe('readPrebuiltMachineFile / readPrebuiltMachineText — explicit dir', () => {
    it('present file → returns bytes; text variant returns string', () => {
      writeFileSync(join(tmp, 'server.js'), 'console.log(1)')
      const bytes = readPrebuiltMachineFile('server.js', { dir: tmp })
      expect(bytes).not.toBeNull()
      expect(new TextDecoder().decode(bytes as Uint8Array)).toBe('console.log(1)')

      const text = readPrebuiltMachineText('server.js', { dir: tmp })
      expect(text).toBe('console.log(1)')
    })

    it('missing file → returns null (no throw), even when the fixture root has artifact.json', () => {
      writeFileSync(join(tmp, 'artifact.json'), '{}')
      const result = readPrebuiltMachineFile('server.js', { dir: tmp })
      expect(result).toBeNull()
    })

    it('empty (0 byte) file → throws, message contains the path', () => {
      const path = join(tmp, 'server.js')
      writeFileSync(path, '')
      expect(() => readPrebuiltMachineFile('server.js', { dir: tmp })).toThrow(path)
    })
  })

  describe('readPrebuiltMachineFile — no dir, root-based', () => {
    it('root WITHOUT artifact.json but <root>/machine/bootstrap.sh exists → returns null (dev checkout ignores stray machine/)', () => {
      mkdirSync(join(tmp, 'machine'), { recursive: true })
      writeFileSync(join(tmp, 'machine', 'bootstrap.sh'), '#!/bin/sh\necho hi\n')
      const result = readPrebuiltMachineFile('bootstrap.sh', { root: tmp })
      expect(result).toBeNull()
    })

    it('root WITH artifact.json and <root>/machine/<name> present → returns the file bytes', () => {
      writeFileSync(join(tmp, 'artifact.json'), '{}')
      mkdirSync(join(tmp, 'machine'), { recursive: true })
      writeFileSync(join(tmp, 'machine', 'bootstrap.sh'), '#!/bin/sh\necho hi\n')
      const result = readPrebuiltMachineFile('bootstrap.sh', { root: tmp })
      expect(result).not.toBeNull()
      expect(new TextDecoder().decode(result as Uint8Array)).toBe('#!/bin/sh\necho hi\n')
    })

    it('root WITH artifact.json, file missing → throws with the path and the word "artifact"', () => {
      writeFileSync(join(tmp, 'artifact.json'), '{}')
      const expectedPath = join(tmp, 'machine', 'bootstrap.sh')
      expect(() => readPrebuiltMachineFile('bootstrap.sh', { root: tmp })).toThrow(
        expect.objectContaining({
          message: expect.stringContaining(expectedPath),
        })
      )
      try {
        readPrebuiltMachineFile('bootstrap.sh', { root: tmp })
        throw new Error('expected throw')
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        expect(message).toContain(expectedPath)
        expect(message.toLowerCase()).toContain('artifact')
      }
    })

    it('root WITH artifact.json, file empty → throws', () => {
      writeFileSync(join(tmp, 'artifact.json'), '{}')
      mkdirSync(join(tmp, 'machine'), { recursive: true })
      writeFileSync(join(tmp, 'machine', 'bootstrap.sh'), '')
      expect(() => readPrebuiltMachineFile('bootstrap.sh', { root: tmp })).toThrow()
    })
  })

  describe('isArtifactDeployment', () => {
    it('true when <root>/artifact.json exists', () => {
      writeFileSync(join(tmp, 'artifact.json'), '{}')
      expect(isArtifactDeployment(tmp)).toBe(true)
    })

    it('false when <root>/artifact.json is absent', () => {
      expect(isArtifactDeployment(tmp)).toBe(false)
    })
  })

  describe('readArtifactManifest', () => {
    const SHA = 'a'.repeat(40)

    it('parses commit + digest from artifact.json', () => {
      writeFileSync(join(tmp, 'artifact.json'), JSON.stringify({ commit: SHA, digest: 'sha256:x' }))
      expect(readArtifactManifest(tmp)).toEqual({ commit: SHA, digest: 'sha256:x' })
    })

    it('parses a manifest with or without hostLayout the same way', () => {
      writeFileSync(join(tmp, 'artifact.json'), JSON.stringify({ commit: SHA, digest: 'sha256:x', hostLayout: 2 }))
      expect(readArtifactManifest(tmp)).toEqual({ commit: SHA, digest: 'sha256:x' })
      writeFileSync(join(tmp, 'artifact.json'), JSON.stringify({ commit: SHA, digest: 'sha256:y', envPrefix: 'FICUS' }))
      expect(readArtifactManifest(tmp)).toEqual({ commit: SHA, digest: 'sha256:y' })
    })

    it('returns null when artifact.json is missing', () => {
      expect(readArtifactManifest(tmp)).toBeNull()
    })

    it('returns null (never throws) on malformed JSON', () => {
      writeFileSync(join(tmp, 'artifact.json'), 'not json')
      expect(() => readArtifactManifest(tmp)).not.toThrow()
      expect(readArtifactManifest(tmp)).toBeNull()
    })

    it('returns undefined fields (not a throw) when commit/digest are absent or non-string', () => {
      writeFileSync(join(tmp, 'artifact.json'), JSON.stringify({ schema: 1, commit: 42 }))
      expect(readArtifactManifest(tmp)).toEqual({ commit: undefined, digest: undefined })
    })
  })

  describe('effectiveMachineScripts', () => {
    it('no opts in a non-artifact root → returns the inlined scripts', () => {
      const { bootstrapScript, boxProvisionScript } = effectiveMachineScripts()
      expect(bootstrapScript.length).toBeGreaterThan(1000)
      expect(bootstrapScript.startsWith('#!')).toBe(true)
      expect(bootstrapScript).toMatch(/install_browser/)
      expect(boxProvisionScript.length).toBeGreaterThan(1000)
      expect(boxProvisionScript.startsWith('#!')).toBe(true)
    })

    it('with { root: artifactRoot } holding sentinel scripts → returns exactly those sentinel strings', () => {
      writeFileSync(join(tmp, 'artifact.json'), '{}')
      mkdirSync(join(tmp, 'machine'), { recursive: true })
      writeFileSync(join(tmp, 'machine', 'bootstrap.sh'), '#!SENTINEL-BOOTSTRAP\n')
      writeFileSync(join(tmp, 'machine', 'box-provision.sh'), '#!SENTINEL-BOX-PROVISION\n')

      const { bootstrapScript, boxProvisionScript } = effectiveMachineScripts({ root: tmp })
      expect(bootstrapScript).toBe('#!SENTINEL-BOOTSTRAP\n')
      expect(boxProvisionScript).toBe('#!SENTINEL-BOX-PROVISION\n')
    })
  })
})
