/**
 * Root `package.json` names that identify a Core checkout or release tree. Anything that walks up
 * looking for the Core root (the web UI resolver, the CLI's checkout detection) accepts these.
 */
export const CORE_ROOT_PACKAGE_NAMES = ['ficus'] as const

export type CoreRootPackageName = (typeof CORE_ROOT_PACKAGE_NAMES)[number]
