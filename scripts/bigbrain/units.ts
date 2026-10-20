import { z } from 'zod'
import vaultTemplate from '../setup/systemd/ficus-bigbrain@.service.tmpl' with { type: 'text' }
import sliceTemplate from '../setup/systemd/ficus-bigbrain.slice.tmpl' with { type: 'text' }
import gatewayTemplate from '../setup/systemd/ficus-bigbrain-gateway.service.tmpl' with { type: 'text' }
import controlLauncherTemplate from '../setup/systemd/ficus-bigbrainctl.tmpl' with { type: 'text' }
import { managedPaths } from './paths'
import type { StorageReservation } from './storage'
import { managedBigbrainOriginMatchesPolicy } from '@ficus/shared/managed-bigbrain'

const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/)
const artifactRoot = (digest: string) => {
  if (!digestSchema.safeParse(digest).success) throw new Error('invalid_request')
  return `/opt/ficus-bigbrain/releases/${digest.slice(7)}`
}
function render(template: string, values: Record<string, string>): string {
  const rendered = template.replace(/\{\{([A-Z_]+)\}\}/g, (_, key: string) => {
    const value = values[key]
    if (!value || /[\r\n%]/.test(value)) throw new Error('invalid_request')
    return value
  })
  if (rendered.includes('{{')) throw new Error('invalid_request')
  return rendered
}
export function mountUnitName(path: string): string {
  // systemd-escape --path semantics for these fixed ASCII, UUID-derived paths.
  return path.slice(1).replaceAll('-', '\\x2d').replaceAll('/', '-') + '.mount'
}

/** Rendered only by the root controller from recorded resources, never from a user label. */
export async function renderVaultUnits(input: {
  reservation: StorageReservation
  artifactDigest: string
  origin: string
  /** Fixture/operator-only mapping; never sourced from a helper/API request. */
  root?: string
}) {
  const r = input.reservation
  const paths = managedPaths({ vaultId: r.vaultId, root: input.root })
  const zone = input.origin.slice('https://bb-'.length + 33)
  if (
    r.username !== `bbv_${r.vaultId.replaceAll('-', '').slice(0, 24)}` ||
    r.mount !== paths.mount ||
    r.image !== paths.image ||
    !managedBigbrainOriginMatchesPolicy(input.origin, r.vaultId, zone)
  )
    throw new Error('invalid_request')
  const mountName = mountUnitName(paths.mount)
  const service = render(vaultTemplate, {
    VAULT_ID: r.vaultId,
    VAULT_USER: r.username,
    MOUNT_UNIT: mountName,
    ARTIFACT_ROOT: artifactRoot(input.artifactDigest),
    VAULT_PATH: paths.vault,
    MEMBERS_PATH: paths.memberStore,
    ORIGIN: input.origin,
    MOUNT_PATH: paths.mount,
  })
  const mount = `[Unit]\nDescription=Private bounded BigBrain filesystem ${r.vaultId}\nBefore=${paths.unit}\n\n[Mount]\nWhat=${paths.image}\nWhere=${paths.mount}\nType=ext4\nOptions=loop,rw,nodev,nosuid,noexec\nTimeoutSec=30\n\n[Install]\nWantedBy=multi-user.target\n`
  return { service, mount, mountUnitName: mountName, serviceUnitName: paths.unit }
}
export async function renderAggregateUnit(): Promise<string> {
  return sliceTemplate
}
export async function renderGatewayUnit(digest: string): Promise<string> {
  return render(gatewayTemplate, { ARTIFACT_ROOT: artifactRoot(digest) })
}
/** The root controller, including all CLI children, lives in a single bounded transient
 * systemd unit. Losing the SSH waiter cannot free its mutation slot or orphan a writer.
 * The fixed launcher must be installed root:root0750; Core never receives sudo access.
 */
export async function renderControlLauncher(digest: string): Promise<string> {
  return render(controlLauncherTemplate, { ARTIFACT_ROOT: artifactRoot(digest) })
}
