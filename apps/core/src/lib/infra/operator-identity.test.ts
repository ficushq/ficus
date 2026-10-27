import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { operatorIdentityRefusal } from './operator-identity'

const bundle = '/opt/ficus-core/current/apps/core/dist/box-control.js'

describe('operator entrypoints run as the account that owns Core HOME', () => {
  test('the owner of HOME passes, whoever it is', () => {
    const home = mkdtempSync(join(tmpdir(), 'operator-identity-'))
    try {
      expect(operatorIdentityRefusal('box-control', bundle, home, process.geteuid!())).toBeNull()
      expect(operatorIdentityRefusal('box-control', bundle, home, process.geteuid!() + 1)).toMatch(
        /^box-control must run as the account that owns .* not uid \d+; run it through scripts\/setup\/run-core-operator\.sh$/
      )
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('root is refused when the service user owns HOME: nothing under it may become root-owned', () => {
    expect(
      operatorIdentityRefusal('machine-bootstrap', bundle, '/home/ficus/.ficus', 0, { ownerOf: () => 998 })
    ).toMatch(/machine-bootstrap must run as the account that owns \/home\/ficus\/\.ficus \(uid 998\)/)
  })

  test('a missing HOME or an unknown uid refuses', () => {
    expect(operatorIdentityRefusal('box-reprovision', bundle, '/nonexistent/.ficus', 0)).toMatch(/does not exist/)
    expect(operatorIdentityRefusal('box-reprovision', bundle, '/root/.ficus', undefined, { ownerOf: () => 0 })).toMatch(
      /cannot determine the effective uid/
    )
  })

  test('the TypeScript sources (dev and tests; artifacts ship no src/) are not gated', () => {
    expect(operatorIdentityRefusal('box-control', '/repo/apps/core/src/box-control.ts', '/nonexistent', 501)).toBeNull()
  })
})
