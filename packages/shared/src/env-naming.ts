/**
 * Settings naming guard. Every setting this Core reads is `FICUS_*`. An install whose `.env` still
 * carries the encryption key under the pre-Ficus prefix predates that naming: starting it, or
 * writing a fresh `FICUS_ENCRYPTION_KEY` beside the old one, would orphan every stored secret. The
 * callers refuse instead, and say how to rename such an install. Any other `<P>_ENCRYPTION_KEY`
 * (an app's own setting) is not this Core's business and passes.
 *
 * Nothing here ever returns, logs or throws a value: results and messages carry names only.
 */

/** The Core release tag that renames the settings of installs from before the Ficus naming. */
export const RENAME_BRIDGE_TAG = 'ficus-rename-bridge'

/** The settings prefix Core used before the Ficus naming; the guards look for nothing else. */
export const PRE_FICUS_ENV_PREFIX = 'TAU' // ficus-p5-bridge: detects installs from before the rename

/** The encryption key an install from before the Ficus naming carries. */
export const PRE_FICUS_ENCRYPTION_KEY = `${PRE_FICUS_ENV_PREFIX}_ENCRYPTION_KEY`

const ENCRYPTION_KEY_LINE = /^\s*(?:export\s+)?([A-Z][A-Z0-9]*)_ENCRYPTION_KEY=/

/**
 * Names of dotenv lines `<P>_ENCRYPTION_KEY=` (optionally `export `) whose prefix <P> is the
 * pre-Ficus one — settings from before the Ficus naming. Never returns values. Each name is listed
 * once, in file order.
 */
export function foreignEncryptionKeyNames(content: string): string[] {
  const names: string[] = []
  for (const line of content.split('\n')) {
    const match = ENCRYPTION_KEY_LINE.exec(line)
    if (!match || match[1] !== PRE_FICUS_ENV_PREFIX) continue
    const name = `${match[1]}_ENCRYPTION_KEY`
    if (!names.includes(name)) names.push(name)
  }
  return names
}

/** Is this environment name the pre-Ficus encryption key? The process-env twin of foreignEncryptionKeyNames. */
export function isForeignEncryptionKeyName(name: string): boolean {
  return name === PRE_FICUS_ENCRYPTION_KEY
}

/**
 * How to rename an install from before the Ficus naming, for the checkout at ROOT: that release's
 * own setup renames the settings. (This release's `ficus server update` refuses such an install
 * before it checks anything out, so it cannot be the route.)
 */
export function renameBridgeRemedy(root: string): string {
  return (
    `rename it with the ${RENAME_BRIDGE_TAG} release: in ${root}, run ` +
    `\`git fetch --tags origin && git checkout ${RENAME_BRIDGE_TAG} && bun install && bun run setup\`, ` +
    `then update as usual`
  )
}

/** A refusal to touch an install whose settings predate the Ficus naming. Names only, never values. */
export class EnvNamingError extends Error {
  readonly file: string
  readonly names: string[]

  constructor(file: string, names: string[]) {
    super(
      `${file}: settings predate the Ficus naming (found ${names.join(', ')}); ` +
        `${renameBridgeRemedy(file.replace(/\/[^/]*$/, '') || '.')} — nothing was written`
    )
    this.name = 'EnvNamingError'
    this.file = file
    this.names = names
  }
}
