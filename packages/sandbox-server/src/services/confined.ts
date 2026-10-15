/**
 * Confined file endpoints: list, read and upload below one root directory
 * without following symlinks (see `@ficus/shared/confined-fs`).
 *
 * Core uses these to let an authorized person browse an agent's private area.
 * The root is a logical root (`/private`), resolved and allow-listed by
 * {@link resolvePath} exactly like every other file endpoint; everything below
 * it goes through the descriptor-relative walk, so a symlink the agent plants
 * can never redirect a read or write outside the root.
 *
 * Errors carry a stable `code` (the ConfinedFsError code) so Core can tell a
 * refused path from a box bundle that predates these routes (plain-text 404).
 */

import {
  ConfinedFsError,
  listConfinedDir,
  readConfinedFile,
  writeConfinedFile,
  type ConfinedFsErrorCode,
} from '@ficus/shared/confined-fs'
import { resolvePath } from '../paths'

const STATUS: Record<ConfinedFsErrorCode, number> = {
  'invalid-path': 400,
  'not-found': 404,
  'not-a-directory': 400,
  'not-a-file': 400,
  symlink: 400,
}

/** Hard ceiling for one confined read, whatever the caller asks for. */
const MAX_READ_BYTES = 10 * 1024 * 1024

function failure(error: unknown): Response {
  if (error instanceof ConfinedFsError) {
    return Response.json({ error: error.message, code: error.code }, { status: STATUS[error.code] })
  }
  return Response.json({ error: error instanceof Error ? error.message : 'confined operation failed' }, { status: 500 })
}

function resolveRoot(root: unknown): string {
  if (typeof root !== 'string' || !root) throw new ConfinedFsError('invalid-path')
  try {
    return resolvePath(root)
  } catch {
    throw new ConfinedFsError('invalid-path')
  }
}

function relativePath(value: unknown): string {
  if (typeof value !== 'string') throw new ConfinedFsError('invalid-path')
  return value
}

export async function handleConfinedList(body: { root?: unknown; path?: unknown }): Promise<Response> {
  try {
    const entries = await listConfinedDir(resolveRoot(body.root), relativePath(body.path ?? ''))
    return Response.json({ entries })
  } catch (error) {
    return failure(error)
  }
}

export async function handleConfinedRead(body: {
  root?: unknown
  path?: unknown
  maxBytes?: unknown
}): Promise<Response> {
  try {
    const requested = typeof body.maxBytes === 'number' && body.maxBytes >= 0 ? body.maxBytes : MAX_READ_BYTES
    const result = await readConfinedFile(resolveRoot(body.root), relativePath(body.path), {
      maxBytes: Math.min(requested, MAX_READ_BYTES),
    })
    return Response.json({
      content: result.content.toString('base64'),
      size: result.size,
      truncated: result.truncated,
    })
  } catch (error) {
    return failure(error)
  }
}

/** Raw-body upload: `?root=&path=&overwrite=true&createDirs=true`, bytes as the body. */
export async function handleConfinedUpload(url: URL, req: Request): Promise<Response> {
  try {
    const root = resolveRoot(url.searchParams.get('root'))
    const path = relativePath(url.searchParams.get('path'))
    const content = new Uint8Array(await req.arrayBuffer())
    const status = await writeConfinedFile(root, path, content, {
      overwrite: url.searchParams.get('overwrite') === 'true',
      createDirs: url.searchParams.get('createDirs') === 'true',
    })
    return Response.json({ status })
  } catch (error) {
    return failure(error)
  }
}
