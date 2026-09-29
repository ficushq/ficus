/**
 * Settings naming guard. Every setting this Core reads is `FICUS_*`. An install whose `.env` still
 * carries an encryption key under another one-segment prefix predates that naming: starting it, or
 * writing a fresh `FICUS_ENCRYPTION_KEY` beside the old one, would orphan every stored secret. The
 * callers refuse instead, and point at the release that renames such installs.
 *
 * Nothing here ever returns, logs or throws a value: results and messages carry names only.
 */

/** The Core release tag that renames the settings of installs from before the Ficus naming. */
export const RENAME_BRIDGE_TAG = 'ficus-rename-bridge'

const ENCRYPTION_KEY_LINE = /^\s*(?:export\s+)?([A-Z][A-Z0-9]*)_ENCRYPTION_KEY=/

/**
 * Names of dotenv lines `<P>_ENCRYPTION_KEY=` (optionally `export `) whose prefix <P> is one segment
 * ([A-Z][A-Z0-9]*) other than FICUS — settings from before the Ficus naming. Never returns values.
 * Each name is listed once, in file order.
 */
export function foreignEncryptionKeyNames(content: string): string[] {
  const names: string[] = []
  for (const line of content.split('\n')) {
    const match = ENCRYPTION_KEY_LINE.exec(line)
    if (!match || match[1] === 'FICUS') continue
    const name = `${match[1]}_ENCRYPTION_KEY`
    if (!names.includes(name)) names.push(name)
  }
  return names
}

/**
 * An environment name `<P>_ENCRYPTION_KEY` whose prefix is one segment other than FICUS, or null.
 * The process-env twin of foreignEncryptionKeyNames.
 */
export function isForeignEncryptionKeyName(name: string): boolean {
  const match = /^([A-Z][A-Z0-9]*)_ENCRYPTION_KEY$/.exec(name)
  return match !== null && match[1] !== 'FICUS'
}

/** A refusal to touch an install whose settings predate the Ficus naming. Names only, never values. */
export class EnvNamingError extends Error {
  readonly file: string
  readonly names: string[]

  constructor(file: string, names: string[]) {
    super(
      `${file}: settings predate the Ficus naming (found ${names.join(', ')}); update this install ` +
        `through the ${RENAME_BRIDGE_TAG} release first — nothing was written`
    )
    this.name = 'EnvNamingError'
    this.file = file
    this.names = names
  }
}
