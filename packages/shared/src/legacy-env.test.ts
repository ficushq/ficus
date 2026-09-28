import { expect, test } from 'bun:test'
import {
  bridgeLegacyEnv,
  EnvPrefixConflictError,
  formatLegacyEnvBridge,
  isProtectedEnvSuffix,
  mapManagedKeyList,
  renameEnvPrefix,
  stripLegacyEnv,
  withLegacyAppAliases,
  withLegacyEnvAliases,
} from './legacy-env'

test('moves TAU_ to FICUS_ and deletes the legacy key', () => {
  const env: Record<string, string | undefined> = { TAU_ENCRYPTION_KEY: 'k', PATH: '/bin' }
  expect(bridgeLegacyEnv(env)).toEqual({ moved: ['TAU_ENCRYPTION_KEY'], shadowed: [], conflicts: [] })
  expect(env).toEqual({ FICUS_ENCRYPTION_KEY: 'k', PATH: '/bin' })
})
test('FICUS_ wins over TAU_ and the legacy key is still removed', () => {
  const env: Record<string, string | undefined> = { TAU_TOKEN: 'old', FICUS_TOKEN: 'new' }
  expect(bridgeLegacyEnv(env)).toEqual({ moved: [], shadowed: ['TAU_TOKEN'], conflicts: [] })
  expect(env).toEqual({ FICUS_TOKEN: 'new' })
})
test('a conflicting encryption key keeps the TAU_ value and is reported (N-I2)', () => {
  const env: Record<string, string | undefined> = { TAU_ENCRYPTION_KEY: 'real', FICUS_ENCRYPTION_KEY: 'new' }
  expect(bridgeLegacyEnv(env)).toEqual({
    moved: [],
    shadowed: ['TAU_ENCRYPTION_KEY'],
    conflicts: ['TAU_ENCRYPTION_KEY'],
  })
  expect(env).toEqual({ FICUS_ENCRYPTION_KEY: 'real' })
})
test('a conflicting password is reported; identical values are silent', () => {
  const env: Record<string, string | undefined> = {
    TAU_PASSWORD: 'a',
    FICUS_PASSWORD: 'b',
    TAU_X_PASSWORD: 's',
    FICUS_X_PASSWORD: 's',
  }
  expect(bridgeLegacyEnv(env).conflicts).toEqual(['TAU_PASSWORD'])
  expect(env).toEqual({ FICUS_PASSWORD: 'b', FICUS_X_PASSWORD: 's' })
})
test('renameEnvPrefix refuses conflicting protected values and names only the key', () => {
  const run = () => renameEnvPrefix('TAU_ENCRYPTION_KEY=secret-a\nFICUS_ENCRYPTION_KEY=secret-b\n', 'TAU_', 'FICUS_')
  expect(run).toThrow(EnvPrefixConflictError)
  expect(run).toThrow(/TAU_ENCRYPTION_KEY/)
  expect(run).not.toThrow(/secret-/)
  expect(renameEnvPrefix('TAU_PASSWORD=p\nFICUS_PASSWORD=p\n', 'TAU_', 'FICUS_')).toEqual({
    content: 'FICUS_PASSWORD=p\n',
    renamed: [],
    conflicts: [],
  })
})
test('managed secret key lists are mapped when moved', () => {
  const env: Record<string, string | undefined> = { TAU_MANAGED_SECRET_KEYS: 'TAU_PLATFORM_INSTANCE_TOKEN,SES_KEY' }
  bridgeLegacyEnv(env)
  expect(env.FICUS_MANAGED_SECRET_KEYS).toBe('FICUS_PLATFORM_INSTANCE_TOKEN,SES_KEY')
  expect(mapManagedKeyList('FICUS_A, TAU_B', 'TAU_')).toBe('TAU_A,TAU_B')
})
test('renameEnvPrefix is a hard, idempotent rename that keeps comments and order', () => {
  const src = '# c\nTAU_A=1\nB=2\nexport TAU_C="x y"\nFICUS_D=4\nTAU_D=old\nTAU_MANAGED_SECRET_KEYS=TAU_P,Q\n'
  const once = renameEnvPrefix(src, 'TAU_', 'FICUS_')
  expect(once.content).toBe(
    '# c\nFICUS_A=1\nB=2\nexport FICUS_C="x y"\nFICUS_D=4\nFICUS_MANAGED_SECRET_KEYS=FICUS_P,Q\n'
  )
  expect(once.renamed).toEqual(['TAU_A', 'TAU_C', 'TAU_MANAGED_SECRET_KEYS'])
  expect(once.conflicts).toEqual(['TAU_D'])
  expect(renameEnvPrefix(once.content, 'TAU_', 'FICUS_')).toEqual({ content: once.content, renamed: [], conflicts: [] })
})
test('stripLegacyEnv never throws and returns what it removed', () => {
  const env: Record<string, string | undefined> = { TAU_TOKEN: 'x', FICUS_TOKEN: 'y' }
  expect(stripLegacyEnv(env)).toEqual(['TAU_TOKEN'])
  expect(env).toEqual({ FICUS_TOKEN: 'y' })
})
test('withLegacyAppAliases adds TAU_ aliases only for listed keys', () => {
  expect(withLegacyAppAliases({ FICUS_APP_BASE_PATH: '/', X: '1' }, ['FICUS_APP_BASE_PATH'])).toEqual({
    FICUS_APP_BASE_PATH: '/',
    TAU_APP_BASE_PATH: '/',
    X: '1',
  })
})

test('isProtectedEnvSuffix covers encryption keys and passwords only', () => {
  expect(isProtectedEnvSuffix('ENCRYPTION_KEY')).toBe(true)
  expect(isProtectedEnvSuffix('BACKUP_ENCRYPTION_KEY')).toBe(true)
  expect(isProtectedEnvSuffix('SMTP_PASSWORD')).toBe(true)
  expect(isProtectedEnvSuffix('TOKEN')).toBe(false)
})
test('bridgeLegacyEnv maps only moved managed key lists and leaves an existing FICUS_ list alone', () => {
  const env: Record<string, string | undefined> = {
    TAU_MANAGED_SECRET_KEYS: 'TAU_A',
    FICUS_MANAGED_SECRET_KEYS: 'FICUS_B',
  }
  expect(bridgeLegacyEnv(env)).toEqual({ moved: [], shadowed: ['TAU_MANAGED_SECRET_KEYS'], conflicts: [] })
  expect(env).toEqual({ FICUS_MANAGED_SECRET_KEYS: 'FICUS_B' })
})
test('renameEnvPrefix names the source key in the reverse direction and never a value', () => {
  let error: unknown
  try {
    renameEnvPrefix('FICUS_DB_PASSWORD="pw-first"\nTAU_DB_PASSWORD=pw-second\n', 'FICUS_', 'TAU_')
  } catch (caught) {
    error = caught
  }
  expect(error).toBeInstanceOf(EnvPrefixConflictError)
  expect((error as EnvPrefixConflictError).keys).toEqual(['FICUS_DB_PASSWORD'])
  expect((error as Error).message).not.toMatch(/pw-/)
})
test('renameEnvPrefix treats quoting as the same value and sees a later FICUS_ line', () => {
  expect(renameEnvPrefix('TAU_ENCRYPTION_KEY="k"\nFICUS_ENCRYPTION_KEY=k\n', 'TAU_', 'FICUS_')).toEqual({
    content: 'FICUS_ENCRYPTION_KEY=k\n',
    renamed: [],
    conflicts: [],
  })
  expect(renameEnvPrefix('TAU_MANAGED_SECRET_KEYS="TAU_A, B"\n', 'TAU_', 'FICUS_').content).toBe(
    'FICUS_MANAGED_SECRET_KEYS="FICUS_A,B"\n'
  )
})

// Fix round 1: empty values never overwrite or erase a real one.
test('an empty TAU_ value never overwrites a FICUS_ value (protected and unprotected)', () => {
  const env: Record<string, string | undefined> = {
    TAU_ENCRYPTION_KEY: '',
    FICUS_ENCRYPTION_KEY: 'k',
    TAU_TOKEN: '',
    FICUS_TOKEN: 't',
  }
  expect(bridgeLegacyEnv(env)).toEqual({ moved: [], shadowed: ['TAU_ENCRYPTION_KEY', 'TAU_TOKEN'], conflicts: [] })
  expect(env).toEqual({ FICUS_ENCRYPTION_KEY: 'k', FICUS_TOKEN: 't' })
})
test('an empty FICUS_ value counts as unset, so a non-empty TAU_ value moves over (protected and unprotected)', () => {
  const env: Record<string, string | undefined> = {
    TAU_ENCRYPTION_KEY: 'k',
    FICUS_ENCRYPTION_KEY: '',
    TAU_TOKEN: 't',
    FICUS_TOKEN: '',
  }
  expect(bridgeLegacyEnv(env)).toEqual({ moved: ['TAU_ENCRYPTION_KEY', 'TAU_TOKEN'], shadowed: [], conflicts: [] })
  expect(env).toEqual({ FICUS_ENCRYPTION_KEY: 'k', FICUS_TOKEN: 't' })
})
test('an empty TAU_ value with no FICUS_ value still moves, and two empty values are silent', () => {
  const env: Record<string, string | undefined> = { TAU_A: '', TAU_PASSWORD: '', FICUS_PASSWORD: '' }
  expect(bridgeLegacyEnv(env)).toEqual({ moved: ['TAU_A'], shadowed: ['TAU_PASSWORD'], conflicts: [] })
  expect(env).toEqual({ FICUS_A: '', FICUS_PASSWORD: '' })
})
test('renameEnvPrefix: an empty source line never replaces a value and is not a conflict', () => {
  expect(
    renameEnvPrefix('TAU_ENCRYPTION_KEY=\nFICUS_ENCRYPTION_KEY=k\nTAU_T=""\nFICUS_T=t\n', 'TAU_', 'FICUS_')
  ).toEqual({
    content: 'FICUS_ENCRYPTION_KEY=k\nFICUS_T=t\n',
    renamed: [],
    conflicts: [],
  })
})
test('renameEnvPrefix: an empty target line counts as unset, so the source value moves over', () => {
  const once = renameEnvPrefix('FICUS_ENCRYPTION_KEY=\nTAU_ENCRYPTION_KEY=k\nFICUS_T=\nTAU_T=t\n', 'TAU_', 'FICUS_')
  expect(once).toEqual({
    content: 'FICUS_ENCRYPTION_KEY=k\nFICUS_T=t\n',
    renamed: ['TAU_ENCRYPTION_KEY', 'TAU_T'],
    conflicts: [],
  })
  expect(renameEnvPrefix(once.content, 'TAU_', 'FICUS_')).toEqual({ content: once.content, renamed: [], conflicts: [] })
})
test('renameEnvPrefix keeps CRLF line endings', () => {
  const once = renameEnvPrefix(
    '# c\r\nTAU_A=1\r\nFICUS_B=2\r\nTAU_B=2\r\nTAU_MANAGED_SECRET_KEYS=TAU_P\r\n',
    'TAU_',
    'FICUS_'
  )
  expect(once).toEqual({
    content: '# c\r\nFICUS_A=1\r\nFICUS_B=2\r\nFICUS_MANAGED_SECRET_KEYS=FICUS_P\r\n',
    renamed: ['TAU_A', 'TAU_MANAGED_SECRET_KEYS'],
    conflicts: [],
  })
  expect(() => renameEnvPrefix('TAU_PASSWORD=a\r\nFICUS_PASSWORD=a\r\n', 'TAU_', 'FICUS_')).not.toThrow()
})
test('renameEnvPrefix lists a duplicated key once', () => {
  expect(renameEnvPrefix('TAU_A=1\nTAU_A=2\nFICUS_B=x\nTAU_B=y\nTAU_B=z\n', 'TAU_', 'FICUS_')).toEqual({
    content: 'FICUS_A=1\nFICUS_A=2\nFICUS_B=x\n',
    renamed: ['TAU_A'],
    conflicts: ['TAU_B'],
  })
})
test('renameEnvPrefix never rewrites lines inside a multi-line quoted value', () => {
  const src = 'TAU_CERT="-----BEGIN-----\nTAU_INNER=not-a-key\n-----END-----"\nTAU_NEXT=1\n'
  expect(renameEnvPrefix(src, 'TAU_', 'FICUS_')).toEqual({
    content: 'FICUS_CERT="-----BEGIN-----\nTAU_INNER=not-a-key\n-----END-----"\nFICUS_NEXT=1\n',
    renamed: ['TAU_CERT', 'TAU_NEXT'],
    conflicts: [],
  })
  const quotedOther = "B='line1\nTAU_INNER=x\nline3'\nTAU_A=1\n"
  expect(renameEnvPrefix(quotedOther, 'TAU_', 'FICUS_').content).toBe("B='line1\nTAU_INNER=x\nline3'\nFICUS_A=1\n")
})
test('renameEnvPrefix compares whole multi-line values', () => {
  const run = () => renameEnvPrefix('TAU_ENCRYPTION_KEY="a\nb"\nFICUS_ENCRYPTION_KEY="a\nc"\n', 'TAU_', 'FICUS_')
  expect(run).toThrow(EnvPrefixConflictError)
  expect(renameEnvPrefix('TAU_ENCRYPTION_KEY="a\nb"\nFICUS_ENCRYPTION_KEY="a\nb"\n', 'TAU_', 'FICUS_').content).toBe(
    'FICUS_ENCRYPTION_KEY="a\nb"\n'
  )
})
test('renameEnvPrefix only rewrites KEY= lines with no space around =', () => {
  expect(renameEnvPrefix('TAU_A = 1\nTAU_B =2\nTAU_C= 3\n', 'TAU_', 'FICUS_')).toEqual({
    content: 'TAU_A = 1\nTAU_B =2\nFICUS_C= 3\n',
    renamed: ['TAU_C'],
    conflicts: [],
  })
})
test('formatLegacyEnvBridge single-sources the log lines, names only', () => {
  expect(formatLegacyEnvBridge({ moved: [], shadowed: [], conflicts: [] })).toEqual({
    warn: null,
    debug: null,
    error: null,
  })
  expect(
    formatLegacyEnvBridge({
      moved: ['TAU_A', 'TAU_B'],
      shadowed: ['TAU_ENCRYPTION_KEY'],
      conflicts: ['TAU_ENCRYPTION_KEY'],
    })
  ).toEqual({
    warn: 'legacy TAU_* environment moved to FICUS_*: TAU_A, TAU_B (rename them; TAU_* is ignored from the next release)',
    debug: 'legacy TAU_* variables ignored (FICUS_ already set): 1',
    error:
      'legacy TAU_* and FICUS_* disagree for: TAU_ENCRYPTION_KEY; kept TAU_ for *ENCRYPTION_KEY*, FICUS_ otherwise — remove the wrong one',
  })
})
test('withLegacyAppAliases skips undefined values', () => {
  expect(
    withLegacyAppAliases({ FICUS_APP_BASE_PATH: '/', FICUS_LOCAL_DEPLOYMENT_ID: undefined, X: undefined }, [
      'FICUS_APP_BASE_PATH',
      'FICUS_LOCAL_DEPLOYMENT_ID',
    ])
  ).toEqual({ FICUS_APP_BASE_PATH: '/', TAU_APP_BASE_PATH: '/' })
})
test('withLegacyEnvAliases aliases every FICUS_ key that has no TAU_ twin', () => {
  const env = { FICUS_A: '1', FICUS_B: '2', TAU_B: 'kept', FICUS_C: undefined, PATH: '/bin' }
  expect(withLegacyEnvAliases(env)).toEqual({ FICUS_A: '1', TAU_A: '1', FICUS_B: '2', TAU_B: 'kept', PATH: '/bin' })
  expect(env).toEqual({ FICUS_A: '1', FICUS_B: '2', TAU_B: 'kept', FICUS_C: undefined, PATH: '/bin' })
})
