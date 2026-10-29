import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { WORK_STREAM_CONFIG_DECLARATION, WORK_STREAM_CONFIG_INPUT_KEYS, type ManualInputRequest } from '@ficus/shared'
import { Squad } from '../../entities/Squad'
import { getSandboxManager, isRemoteSandboxRuntime } from '../sandbox/factory'
import type { K8sSandboxManager } from '../sandbox/k8s'
import type { SandboxClient } from '../sandbox/client/http-client'
import { resolveWorkspaceLayout } from '../sandbox/workspace-layout'
import { isInsideWorkspaceRoot, resolveSquadWorkspaceHostPath } from '../squad/workspace'

const MAX_DECLARATION_BYTES = 64 * 1024
const validated = new WeakMap<object, { workStreamId: string; squadId: string; request: string }>()
type ConfigRequest = Extract<ManualInputRequest, { kind: 'provide' }>

/** No provisioning and no unbounded reads just to create an input request. */
async function readDeclaration(squadId: string, relativePath: string): Promise<string> {
  if (isRemoteSandboxRuntime()) {
    const sandboxId = Squad.getSandboxId(squadId)
    const client = (getSandboxManager() as K8sSandboxManager).getClient(sandboxId)
    if (!client) throw new Error('The workspace is unavailable for declaration validation')
    const root = resolveWorkspaceLayout({ squadId, sandboxId }).workspaceMount
    return readRemoteDeclaration(client, root, relativePath)
  }
  const root = await realpath(resolveSquadWorkspaceHostPath(squadId))
  const target = await realpath(join(root, relativePath))
  if (!isInsideWorkspaceRoot(root, target))
    throw new Error('Configuration declaration must remain inside the workspace')
  const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > MAX_DECLARATION_BYTES)
      throw new Error('Configuration declarations must be small JSON files')
    const buffer = Buffer.alloc(MAX_DECLARATION_BYTES + 1)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    if (bytesRead > MAX_DECLARATION_BYTES) throw new Error('Configuration declarations must be small JSON files')
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await file.close()
  }
}

/** The remote reader needs only a cached client's read capability, never an
 * ensure/provision capability. Keep containment validation at this boundary. */
export async function readRemoteDeclaration(
  client: Pick<SandboxClient, 'read'>,
  root: string,
  relativePath: string
): Promise<string> {
  const file = await client.read({ path: join(root, relativePath), root, limit: MAX_DECLARATION_BYTES + 1 })
  const content = Buffer.from(file.content, 'base64')
  if (file.verifiedRoot !== root) throw new Error('The executor does not support workspace-bounded declaration reads')
  if (file.isBinary || file.totalSize > MAX_DECLARATION_BYTES || content.length > MAX_DECLARATION_BYTES)
    throw new Error('Configuration declarations must be small JSON files')
  return content.toString('utf8')
}

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

/** Validate before taking stream/agent locks. The common writer consumes a
 * content-bound, one-use proof; an HTTP payload cannot manufacture that proof.
 * Keys are exact top-level JSON properties (or JSON Schema properties), not
 * executable lookup expressions. Declaration contents are never persisted.
 */
export async function validateConfigDeclaration(
  request: ConfigRequest,
  workStreamId: string,
  squadId: string
): Promise<void> {
  if (request.input.type !== 'config-value') return
  if (request.input.declaredIn === WORK_STREAM_CONFIG_DECLARATION) {
    if (!WORK_STREAM_CONFIG_INPUT_KEYS.includes(request.input.key))
      throw new Error('The work-stream configuration key is not declared')
  } else {
    const text = await readDeclaration(squadId, request.input.declaredIn)
    let declaration: unknown
    try {
      declaration = JSON.parse(text)
    } catch {
      throw new Error('Configuration declaration must be valid JSON')
    }
    const declared =
      object(declaration) &&
      (Object.hasOwn(declaration, request.input.key) ||
        (object(declaration.properties) && Object.hasOwn(declaration.properties, request.input.key)))
    if (!declared) throw new Error('The requested configuration key is not declared in that workspace JSON file')
  }
  validated.set(request, { workStreamId, squadId, request: JSON.stringify(request) })
}

export function consumeConfigDeclarationProof(
  request: ManualInputRequest,
  workStreamId: string,
  squadId: string
): void {
  if (request.kind !== 'provide' || request.input.type !== 'config-value') return
  const proof = validated.get(request)
  validated.delete(request)
  if (
    !proof ||
    proof.workStreamId !== workStreamId ||
    proof.squadId !== squadId ||
    proof.request !== JSON.stringify(request)
  )
    throw new Error('A configuration input must first validate its declared workspace key')
}
