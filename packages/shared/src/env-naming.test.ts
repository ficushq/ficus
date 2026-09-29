import { describe, expect, test } from 'bun:test'
import { EnvNamingError, foreignEncryptionKeyNames, isForeignEncryptionKeyName, RENAME_BRIDGE_TAG } from './env-naming'

describe('foreignEncryptionKeyNames', () => {
  test('lists one-segment prefixes other than FICUS, names only', () => {
    expect(foreignEncryptionKeyNames('export OLD_ENCRYPTION_KEY=a\nFICUS_ENCRYPTION_KEY=b\nSES_KEY=c\n')).toEqual([
      'OLD_ENCRYPTION_KEY',
    ])
  })

  test('ignores FICUS_, multi-segment prefixes, comments and spaced assignments', () => {
    const content = [
      'FICUS_ENCRYPTION_KEY=x',
      'MY_APP_ENCRYPTION_KEY=x',
      '# OLD_ENCRYPTION_KEY=x',
      'OLD_ENCRYPTION_KEY = x',
      'ENCRYPTION_KEY=x',
      'old_ENCRYPTION_KEY=x',
    ].join('\n')
    expect(foreignEncryptionKeyNames(content)).toEqual([])
  })

  test('accepts indentation, export, CRLF and digits; lists each name once', () => {
    const content = '  OLD2_ENCRYPTION_KEY=a\r\nexport   OLD2_ENCRYPTION_KEY=b\r\nX_ENCRYPTION_KEY=\r\n'
    expect(foreignEncryptionKeyNames(content)).toEqual(['OLD2_ENCRYPTION_KEY', 'X_ENCRYPTION_KEY'])
  })

  test('never returns a value', () => {
    expect(foreignEncryptionKeyNames('OLD_ENCRYPTION_KEY=secret-value').join()).not.toContain('secret-value')
  })
})

describe('isForeignEncryptionKeyName', () => {
  test('matches the process-env names the same way', () => {
    expect(isForeignEncryptionKeyName('OLD_ENCRYPTION_KEY')).toBe(true)
    expect(isForeignEncryptionKeyName('FICUS_ENCRYPTION_KEY')).toBe(false)
    expect(isForeignEncryptionKeyName('MY_APP_ENCRYPTION_KEY')).toBe(false)
    expect(isForeignEncryptionKeyName('OLD_ENCRYPTION_KEY_2')).toBe(false)
  })
})

describe('EnvNamingError', () => {
  test('names the file, the keys and the bridge release, and says nothing was written', () => {
    const error = new EnvNamingError('/srv/core/.env', ['OLD_ENCRYPTION_KEY'])
    expect(error.name).toBe('EnvNamingError')
    expect(error.names).toEqual(['OLD_ENCRYPTION_KEY'])
    expect(error.message).toBe(
      `/srv/core/.env: settings predate the Ficus naming (found OLD_ENCRYPTION_KEY); update this install ` +
        `through the ${RENAME_BRIDGE_TAG} release first — nothing was written`
    )
    expect(RENAME_BRIDGE_TAG).toBe('ficus-rename-bridge')
  })
})
