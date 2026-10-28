import { open, realpath } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { Squad } from '../../entities/Squad'
import { hasPermission, type Identity } from '../rbac'
import { getSquadClient } from './client'
import { isInsideWorkspaceRoot, resolveSquadWorkspaceHostPath } from './workspace'
import { resolveWorkspaceLayout } from '../sandbox/workspace-layout'
import { WriteService } from '../memory'

export const squadFileReadSchema = z.object({
  squadId: z.uuid(),
  path: z.string().min(1).max(2048),
  offset: z.int().min(0).default(0),
  limit: z.int().min(1).max(20000).default(12000),
})
/**
 * Bounded read under the same permission as the matching HTTP route: memory:read for the memory
 * vault, workspace:read for the workspace. Never a shell command or privileged helper.
 */
export async function readSquadFile(identity: Identity, request: unknown) {
  const input = squadFileReadSchema.parse(request)
  const memory = input.path.startsWith('/memory/')
  if (!(await hasPermission(identity, memory ? 'memory:read' : 'workspace:read', input.squadId)))
    throw new Error('Squad not found')
  const squad = await Squad.find(input.squadId)
  if (!squad) throw new Error('Squad not found')
  if (memory) {
    const result = await WriteService.instance().read(squad.id, input.path)
    if (!result.success) throw new Error('File not found')
    return {
      path: input.path,
      content: result.content.slice(input.offset, input.offset + input.limit),
      size: result.content.length,
    }
  }
  const { workspaceMount } = resolveWorkspaceLayout({ squadId: squad.id })
  const relative = input.path.startsWith(`${workspaceMount}/`)
    ? input.path.slice(workspaceMount.length + 1)
    : input.path
  const remotePath = path.posix.resolve(workspaceMount, relative)
  if (!isInsideWorkspaceRoot(workspaceMount, remotePath)) throw new Error('Path must be inside the squad workspace')
  const client = await getSquadClient(squad.id)
  if (client) {
    const result = await client.read({ path: remotePath, offset: input.offset, limit: input.limit })
    const buffer = Buffer.from(result.content, 'base64')
    return {
      path: input.path,
      content: result.isBinary || buffer.includes(0) ? '' : buffer.toString('utf8'),
      binary: result.isBinary,
      size: result.totalSize,
    }
  }
  const root = await realpath(resolveSquadWorkspaceHostPath(squad.id))
  const target = await realpath(path.resolve(root, relative))
  if (!isInsideWorkspaceRoot(root, target)) throw new Error('Path must be inside the squad workspace')
  const file = await open(target, 'r')
  try {
    const stat = await file.stat()
    if (!stat.isFile()) throw new Error('Path is not a file')
    const buffer = Buffer.alloc(input.limit)
    const { bytesRead } = await file.read(buffer, 0, input.limit, input.offset)
    const content = buffer.subarray(0, bytesRead)
    return {
      path: input.path,
      content: content.includes(0) ? '' : content.toString('utf8'),
      binary: content.includes(0),
      size: stat.size,
    }
  } finally {
    await file.close()
  }
}
