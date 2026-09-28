import type { CreateLocalDeploymentInput } from '@ficus/shared'
import { normalizeAttachedLogPathInput } from './local-deployment-log-path'

export function validateLocalDeploymentPort(port: number): number {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('Port must be between 1024 and 65535')
  }
  return port
}

export function normalizeLocalDeploymentName(name: string): string {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100)
  if (!normalized) throw new Error('LocalDeployment name is required')
  return normalized
}

/**
 * Normalize and validate a create payload. The `squadId` context is REQUIRED:
 * an attached `logPath` is validated against that squad's workspace mount, and
 * a deployment always belongs to a squad, so there is no safe default root.
 */
export function normalizeLocalDeploymentInput(
  input: CreateLocalDeploymentInput,
  ctx: { squadId: string }
): Required<Pick<CreateLocalDeploymentInput, 'name' | 'visibility' | 'mode' | 'restartPolicy'>> &
  Omit<CreateLocalDeploymentInput, 'name' | 'port' | 'visibility' | 'mode' | 'restartPolicy'> & {
    port?: number
  } {
  const mode = input.mode ?? 'managed'
  const restartPolicy = input.restartPolicy ?? (mode === 'managed' ? 'always' : 'never')
  if (mode === 'managed' && !input.command?.trim()) {
    throw new Error('Managed localDeployments require a command')
  }
  if (input.visibility === 'public') {
    throw new Error('Public localDeployments are not supported yet')
  }
  if (input.logPath !== undefined && input.logPath !== null && input.logPath.trim() !== '' && mode !== 'attached') {
    throw new Error('logPath applies only to attached localDeployments')
  }
  return {
    ...input,
    name: normalizeLocalDeploymentName(input.name),
    ...(input.port === undefined ? {} : { port: validateLocalDeploymentPort(input.port) }),
    visibility: input.visibility ?? 'private',
    mode,
    restartPolicy,
    logPath: normalizeAttachedLogPathInput(input.logPath, ctx.squadId),
  }
}
