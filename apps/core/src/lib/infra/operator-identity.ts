/**
 * Who may run Core's operator entrypoints (box control, machine bootstrap, box reprovision and the
 * system-token entrypoint, bundled under `dist/`): the account that owns Core's HOME,
 * which is the account the services run as. On a root host that is root; on a host where Core
 * runs as its service user it is that user, and the platform runs the entrypoint through
 * `scripts/setup/run-core-operator.sh` (root loads `<dest>/.env`, then drops to the user).
 *
 * The entrypoints write under HOME (machine keys, ControlMaster sockets, the reprovision
 * journal). Run as any other account they would leave files the services cannot use, so they
 * refuse instead: nothing under the service user's HOME is ever root-owned, and nothing is
 * chowned after the fact. The TypeScript sources (dev and tests; artifacts ship no `src/`) are
 * not gated.
 */
import { statSync } from 'node:fs'

export const OPERATOR_WRAPPER = 'scripts/setup/run-core-operator.sh'

export interface OperatorIdentityDeps {
  /** The owner uid of PATH; throws when it does not exist. */
  ownerOf?: (path: string) => number
}

/** Why NAME must not run here, or null. */
export function operatorIdentityRefusal(
  name: string,
  entryPath: string,
  homeDir: string,
  euid: number | undefined,
  deps: OperatorIdentityDeps = {}
): string | null {
  if (entryPath.endsWith('.ts')) return null
  if (euid === undefined) return `${name}: cannot determine the effective uid`
  let owner: number
  try {
    owner = (deps.ownerOf ?? ((path) => statSync(path).uid))(homeDir)
  } catch {
    return `${name}: Core's HOME ${homeDir} does not exist on this host`
  }
  if (owner === euid) return null
  return (
    `${name} must run as the account that owns ${homeDir} (uid ${owner}), the one Core runs as — ` +
    `not uid ${euid}; run it through ${OPERATOR_WRAPPER}`
  )
}
