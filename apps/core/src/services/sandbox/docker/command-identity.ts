import { createHash } from 'crypto'

export interface DockerCommandIdentityContract {
  version: 1
  user: 'ficus'
  home: '/home/ficus'
  uid: number
  gid: number
}

export interface ResolvedDockerCommandIdentity {
  user: 'ficus'
  home: '/home/ficus'
  source: 'host' | 'image'
  resolvedUid: number
  resolvedGid: number
  contractDigest: string
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
