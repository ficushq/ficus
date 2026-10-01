import { createHash } from 'node:crypto'
import { SANDBOX_IDENTITY_READ } from '../identity-names'
import { DockerSandboxCompatibilityError } from './errors'

export interface DockerSpecInputs {
  imageReference: string
  imageId: string
  runtimeContractVersion: 1
  executorProtocolVersion: 1
  commandIdentityFingerprint: string
  runtime: string
  workspacePath: string
  privateVolumePath: string | null
  squadId: string | null
  lifecycleGeneration?: string | null
  volumes: string[]
  shmSize: string
}

export function computeDockerSpecDigest(inputs: DockerSpecInputs): string {
  const canonical = {
    imageReference: inputs.imageReference,
    imageId: inputs.imageId,
    runtimeContractVersion: inputs.runtimeContractVersion,
    executorProtocolVersion: inputs.executorProtocolVersion,
    commandIdentityFingerprint: inputs.commandIdentityFingerprint,
    runtime: inputs.runtime,
    workspacePath: inputs.workspacePath,
    privateVolumePath: inputs.privateVolumePath,
    squadId: inputs.squadId,
    lifecycleGeneration: inputs.lifecycleGeneration ?? null,
    volumes: [...inputs.volumes].sort(),
    shmSize: inputs.shmSize,
  }
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

/** The image's runtime-contract label keys under one label namespace. */
export function dockerRuntimeLabels(namespace: string) {
  return {
    managed: `${namespace}.managed`,
    runtime: `${namespace}.runtime-contract`,
    executor: `${namespace}.executor-protocol`,
    command: `${namespace}.command-contract`,
  } as const
}

/** Whether the image declares the full runtime contract under one read namespace (never a mix). */
function hasDockerRuntimeContract(labels: Record<string, string>): boolean {
  return SANDBOX_IDENTITY_READ.some((set) => {
    const keys = dockerRuntimeLabels(set.imageLabelNamespace)
    return (
      labels[keys.managed] === 'true' &&
      labels[keys.runtime] === '1' &&
      labels[keys.executor] === '1' &&
      labels[keys.command] === '1'
    )
  })
}

export interface DockerImageContract {
  imageReference: string
  imageId: string
  runtimeContractVersion: 1
  executorProtocolVersion: 1
  commandContractVersion: 1
}

export function parseDockerImageContract(imageReference: string, inspect: unknown): DockerImageContract {
  const row = Array.isArray(inspect) ? inspect[0] : inspect
  const record = row as { Id?: unknown; Config?: { Labels?: Record<string, string> } } | undefined
  const labels = record?.Config?.Labels ?? {}
  if (typeof record?.Id !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(record.Id) || !hasDockerRuntimeContract(labels)) {
    throw new DockerSandboxCompatibilityError({ operation: 'inspect-image', reason: 'IMAGE_REBUILD_REQUIRED' })
  }
  return {
    imageReference,
    imageId: record.Id,
    runtimeContractVersion: 1,
    executorProtocolVersion: 1,
    commandContractVersion: 1,
  }
}

export interface ExpectedDockerCommandIdentity {
  user: 'ficus'
  home: '/home/ficus'
  uid: number
  gid: number
  source: 'host' | 'image'
  contractDigest: string
}

export function validateDockerHealthContract(health: any, expected: ExpectedDockerCommandIdentity): void {
  const contract = health?.runtimeContract
  const required = ['bash', 'bash-cancel', 'command-identity', 'socket-proxy']
  if (!contract) throw new DockerSandboxCompatibilityError({ operation: 'executor-health', reason: 'EXECUTOR_MISSING' })
  if (contract.runtime !== 'docker' || contract.version !== 1 || contract.executorProtocol !== 1)
    throw new DockerSandboxCompatibilityError({ operation: 'executor-health', reason: 'PROTOCOL_MISMATCH' })
  if (!required.every((value) => contract.capabilities?.includes(value)))
    throw new DockerSandboxCompatibilityError({ operation: 'executor-health', reason: 'CAPABILITY_MISSING' })
  const identity = contract.commandIdentity
  if (
    identity?.user !== expected.user ||
    identity?.home !== expected.home ||
    identity?.uid !== expected.uid ||
    identity?.gid !== expected.gid ||
    identity?.source !== expected.source ||
    identity?.contractDigest !== expected.contractDigest
  )
    throw new DockerSandboxCompatibilityError({ operation: 'executor-health', reason: 'IDENTITY_MISMATCH' })
}
