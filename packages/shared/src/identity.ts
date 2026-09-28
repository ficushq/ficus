/**
 * Root `package.json` names that identify a Core checkout or release tree.
 *
 * The monorepo root is named `ficus`; `tau` is the pre-rename name, still
 * found in older checkouts and in release artifacts built before the rename.
 * Anything that walks up looking for the Core root (the web UI resolver, the
 * CLI's checkout detection) accepts either.
 */
export const CORE_ROOT_PACKAGE_NAMES = ['ficus', 'tau'] as const

export type CoreRootPackageName = (typeof CORE_ROOT_PACKAGE_NAMES)[number]
