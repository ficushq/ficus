import { createHash } from 'crypto'

/**
 * `user`/`home` are a plain `string`, not a `'ficus'` literal: a still-running
 * container built before this release reports the legacy identity
 * ({@link LEGACY_DOCKER_COMMAND_IDENTITY_CONTRACT}), and the health check must
 * compare against THAT, not unconditionally against the current release's.
 */
export interface DockerCommandIdentityContract {
  version: 1
  user: string
  home: string
  uid: number
  gid: number
}

export interface ResolvedDockerCommandIdentity {
  user: string
  home: string
  source: 'host' | 'image'
  resolvedUid: number
  resolvedGid: number
  contractDigest: string
}

/**
 * The identity contract every pre-this-release sandbox image baked into
 * `/opt/tau/command-identity.json` and reported over its health endpoint. A // ficus-p5-bridge
 * container built from that image still exists after this release ships (it
 * is adopted, not recreated, while it has an active session — see
 * `connectExecutor`), so this fixed pair is the "expected" identity to
 * validate against for exactly that container, never for a newly created one.
 */
export const LEGACY_DOCKER_COMMAND_IDENTITY_CONTRACT: DockerCommandIdentityContract = {
  version: 1,
  user: 'tau', // ficus-p5-bridge
  home: '/home/tau', // ficus-p5-bridge
  uid: 1000,
  gid: 1000,
}

const MAX_UID = 2 ** 31 - 1
const RESERVED_NOBODY = 65534

function safeId(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= MAX_UID && value !== RESERVED_NOBODY
  )
}

export function canonicalDockerCommandIdentity(contract: DockerCommandIdentityContract): string {
  return JSON.stringify({
    gid: contract.gid,
    home: contract.home,
    uid: contract.uid,
    user: contract.user,
    version: contract.version,
  })
}

export function dockerCommandIdentityDigest(contract: DockerCommandIdentityContract): string {
  return createHash('sha256').update(canonicalDockerCommandIdentity(contract)).digest('hex')
}

export function parseDockerCommandIdentity(input: string): DockerCommandIdentityContract & { digest: string } {
  const value: unknown = JSON.parse(input)
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Docker command identity must be an object')
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  if (
    keys.join(',') !== 'gid,home,uid,user,version' ||
    record.version !== 1 ||
    record.user !== 'ficus' ||
    record.home !== '/home/ficus' ||
    !safeId(record.uid) ||
    !safeId(record.gid)
  ) {
    throw new Error('Invalid Docker command identity contract')
  }
  const contract = value as DockerCommandIdentityContract
  return { ...contract, digest: dockerCommandIdentityDigest(contract) }
}

export function resolveDockerCommandIdentity(
  contract: DockerCommandIdentityContract,
  host: { uid?: unknown; gid?: unknown }
): ResolvedDockerCommandIdentity {
  const useHost = safeId(host.uid) && safeId(host.gid)
  const resolvedUid = useHost ? (host.uid as number) : contract.uid
  const resolvedGid = useHost ? (host.gid as number) : contract.gid
  return {
    user: contract.user,
    home: contract.home,
    source: useHost ? 'host' : 'image',
    resolvedUid,
    resolvedGid,
    contractDigest: dockerCommandIdentityDigest(contract),
  }
}
