import { describe, expect, test } from 'bun:test'
import {
  EnvNamingError,
  foreignEncryptionKeyNames,
  isForeignEncryptionKeyName,
  PRE_FICUS_ENCRYPTION_KEY,
  PRE_FICUS_ENV_PREFIX,
  RENAME_BRIDGE_TAG,
  renameBridgeRemedy,
} from './env-naming'

const OLD = PRE_FICUS_ENCRYPTION_KEY

describe('foreignEncryptionKeyNames', () => {
  test('lists the pre-Ficus encryption key, names only', () => {
    expect(foreignEncryptionKeyNames(`export ${OLD}=a\nFICUS_ENCRYPTION_KEY=b\nSES_KEY=c\n`)).toEqual([OLD])
  })

  test("ignores FICUS_, an app's own encryption keys, comments and spaced assignments", () => {
    const content = [
      'FICUS_ENCRYPTION_KEY=x',
      'APP_ENCRYPTION_KEY=x',
      'X_ENCRYPTION_KEY=x',
      'MY_APP_ENCRYPTION_KEY=x',
      `# ${OLD}=x`,
      `${OLD} = x`,
      'ENCRYPTION_KEY=x',
      `${PRE_FICUS_ENV_PREFIX.toLowerCase()}_ENCRYPTION_KEY=x`,
    ].join('\n')
    expect(foreignEncryptionKeyNames(content)).toEqual([])
  })

  test('accepts indentation, export and CRLF; lists the name once', () => {
    const content = `  ${OLD}=a\r\nexport   ${OLD}=b\r\nAPP_ENCRYPTION_KEY=\r\n`
    expect(foreignEncryptionKeyNames(content)).toEqual([OLD])
  })

  test('never returns a value', () => {
    expect(foreignEncryptionKeyNames(`${OLD}=secret-value`).join()).not.toContain('secret-value')
  })
})

describe('isForeignEncryptionKeyName', () => {
  test('matches only the pre-Ficus encryption key', () => {
    expect(isForeignEncryptionKeyName(OLD)).toBe(true)
    expect(isForeignEncryptionKeyName('FICUS_ENCRYPTION_KEY')).toBe(false)
    expect(isForeignEncryptionKeyName('APP_ENCRYPTION_KEY')).toBe(false)
    expect(isForeignEncryptionKeyName(`${OLD}_2`)).toBe(false)
  })
})

describe('EnvNamingError', () => {
  test('names the file and keys, gives a route that bypasses this release, and says nothing was written', () => {
    const error = new EnvNamingError('/srv/core/.env', [OLD])
    expect(error.name).toBe('EnvNamingError')
    expect(error.names).toEqual([OLD])
    expect(error.message).toBe(
      `/srv/core/.env: settings predate the Ficus naming (found ${OLD}); ` +
        `${renameBridgeRemedy('/srv/core')} — nothing was written`
    )
    // The route runs the bridge release's own setup in the checkout, never this release's CLI.
    expect(renameBridgeRemedy('/srv/core')).toBe(
      'rename it with the ficus-rename-bridge release: in /srv/core, run ' +
        '`git fetch --tags origin && git checkout ficus-rename-bridge && bun install && bun run setup`, ' +
        'then update as usual'
    )
    expect(RENAME_BRIDGE_TAG).toBe('ficus-rename-bridge')
  })
})
