import { consultantScratchPath } from '../services/sandbox/consultant-sandbox'
/**
 * K8s Sandbox Tools
 *
 * Provides sandboxed versions of the coding tools (read, write, edit, bash)
 * that execute inside Kubernetes pods via HTTP.
 *
 * Unlike Docker sandboxes which use `docker exec`, K8s sandboxes communicate
 * with sandbox pods using HTTP Read/Write/Bash RPCs.
 */

import { readFileSync, accessSync } from 'fs'
import { open } from 'node:fs/promises'
import { detectReadImageMimeType, IMAGE_SNIFF_BYTES } from './read-image-mime'
import { createHash } from 'node:crypto'
import { runIdempotentSandboxOperation } from '../services/sandbox/vm/retry'
import { FOREGROUND_BASH_GUIDANCE, normalizeBashTimeoutSeconds } from '../lib/bash-contract'

/**
 * Process carriage returns in terminal output for LLM consumption.
 * Terminal progress indicators use \r to rewrite the current line in-place.
 * This collapses those into just the final version of each line.
 *
 * Example: "Updating files:  10%\rUpdating files:  20%\rUpdating files: 100%\n"
 * becomes: "Updating files: 100%\n"
 */
function processCarriageReturns(buf: Buffer): Buffer {
  const text = buf.toString('utf-8')
  if (!text.includes('\r')) return buf

  const lines = text.split('\n')
  const processed = lines.map((line) => {
    if (!line.includes('\r')) return line
    // Split on \r and take the last non-empty segment (the final overwrite)
    const parts = line.split('\r')
    return parts[parts.length - 1]
  })
  return Buffer.from(processed.join('\n'))
}
import { posix } from 'path'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { createReadTool, createWriteTool, createBashTool, type ReadOperations } from '@earendil-works/pi-coding-agent'
import { BashOutcomeUnknownError, SandboxHttpError, type SandboxClient } from '../services/sandbox/k8s/http-client'
import { createVerifiedEditTool, type VerifiedEditOperations } from './verified-edit'
import { withSharedWorkspaceHint } from './private-bash-hint'
import { createLogger } from '../lib/infra/logger'
import { resolveSandboxApiUrl } from '../services/sandbox/k8s/pod-spec'
import { isVmRuntime } from '../services/sandbox/runtime'
import {
  resolveWorkspaceLayout,
  resolveContainerWorkRoot,
  vmWorkspaceLayout,
} from '../services/sandbox/workspace-layout'
import type { SandboxedToolWithKey } from '../services/sandbox/types'
import { AGENT_DIR, SKILLS_DIR } from '../lib/paths'
import { MATERIALIZED_SKILLS_DIR, SANDBOX_SKILLS_DIR } from '../services/agent/skill-materializer'
import {
  agentIdFromSandboxId,
  attachSecondaryFailure,
  createManagerOutageDeps,
  mapSandboxExecFailure,
} from '../services/sandbox/outage'

/**
 * The minimal manager surface these client-based tools need. Both
 * {@link K8sSandboxManager} and {@link VmSandboxManager} satisfy it structurally,
 * so the same HTTP tool path serves both remote runtimes.
 *
 *  - `getClientForSandbox` — the {@link SandboxClient} for a live sandbox.
 *  - `getSandboxStatus` — live status, used by the outage mapper to distinguish a
 *    dead box from a transient transport error.
 *  - `resolveToolApiUrl` — the live Core URL injected as `FICUS_API_URL` for bash
 *    commands. The vm manager supplies its box's baked callback URL here; the k8s
 *    manager omits it and falls back to its cluster-DNS URL derived from
 *    `podManager.namespace` (preserving the exact k8s behavior).
 */
export interface SandboxToolsManager {
  getClientForSandbox(sandboxId: string): SandboxClient | null
  getSandboxStatus(sandboxId: string): Promise<{ status: string; reason?: string }>
  resolveToolApiUrl?(sandboxId: string): string
  recoverClient?(sandboxId: string, failedClient: SandboxClient, cause: Error): Promise<SandboxClient>
  podManager?: { namespace: string }
}

/**
 * Failure mapper bound to one sandbox: when an op fails because the box is
 * down (live pod check is the tiebreaker), the raw transport error becomes a
 * structured outage error, a recovery watch is registered for the agent, and
 * re-ensure is kicked off in the background. Healthy box → original error.
 */
function createOutageMapper(
  manager: SandboxToolsManager,
  sandboxId: string,
  agentId?: string
): (original: Error) => Promise<Error> {
  const resolvedAgentId = agentId ?? agentIdFromSandboxId(sandboxId) ?? undefined
  const deps = createManagerOutageDeps(manager)
  return (original) => mapSandboxExecFailure({ sandboxId, agentId: resolvedAgentId, original }, deps)
}

/**
 * Check if a path is under locally served config directories (skills, extensions, materialized DB skills, etc.).
 * These files exist on the Core pod, not in sandbox pods. When the agent tries
 * to read a skill file (referenced in the system prompt), we serve it locally
 * instead of forwarding to the sandbox pod via HTTP.
 */
function isConfigPath(absolutePath: string): boolean {
  return (
    absolutePath.startsWith(AGENT_DIR + '/') ||
    absolutePath.startsWith(SKILLS_DIR + '/') ||
    absolutePath.startsWith(MATERIALIZED_SKILLS_DIR + '/') ||
    absolutePath.startsWith(SANDBOX_SKILLS_DIR + '/')
  )
}

/**
 * Route for a squad MEMBER's file tools to reach the shared squad workspace.
 *
 * On the vm runtime each box is a separate unix user on a shared machine, so a
 * member box has NO filesystem access to the squad box's home — its own
 * read/write/edit clients cannot reach the shared squad workspace
 * (`/home/<squadBoxUser>/workspace`). The pi SDK's file-tool input schemas are
 * fixed (no `squadId` arg can be added), so routing lives in the injected
 * operations: absolute paths under `workspaceRoot` are served by the SQUAD
 * box's authenticated client (core holds that box's token — the member box
 * never gains FS access to the squad box). `bash` is deliberately NOT routed;
 * `squad_bash` remains the tool for executing in the shared workspace.
 *
 * Container runtimes (k8s/docker) never construct a route — the member's own
 * client already reaches the shared `/workspace/<squadId>` mount there.
 */
export interface SquadFileRoute {
  /** The squad warm box (`squad_<id>`, i.e. `Squad.getSandboxId`). */
  sandboxId: string
  /** Absolute squad workspace root inside the squad box (`/home/<squadBoxUser>/workspace`). */
  workspaceRoot: string
}

/**
 * The vm-only toolkit gate: squad members on the vm runtime get a
 * {@link SquadFileRoute}; container runtimes and solo agents get `undefined`,
 * which keeps the file ops byte-identical to their pre-routing behavior.
 *
 * The squad warm box id is deterministic (`squad_<squadId>` —
 * `Squad.getSandboxId`; kept as a literal here to avoid importing the entity),
 * so no live squad row is consulted.
 */
export function resolveSquadFileRoute(squadId: string | undefined): SquadFileRoute | undefined {
  if (!squadId || !isVmRuntime()) return undefined
  return {
    sandboxId: `squad_${squadId}`,
    workspaceRoot: vmWorkspaceLayout({ squadId }).workspaceMount,
  }
}

/** Trailing-separator-aware containment check on lexically normalized paths:
 *  `/home/x/workspace` matches itself and `/home/x/workspace/foo`, but NOT
 *  `/home/x/workspace-other`. */
function isPathWithinRoot(normalizedPath: string, root: string): boolean {
  const normalizedRoot = posix.normalize(root).replace(/\/+$/, '')
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(normalizedRoot + '/')
}

/** One box a file op can be served by. */
type FileOpDestination = {
  kind: 'own' | 'squad'
  sandboxId: string
  getClient: () => SandboxClient | null
  mapFailure: (original: Error) => Promise<Error>
}

/** A resolved destination for one file op, plus the path to send to it. */
type FileOpTarget = FileOpDestination & { path: string }

/**
 * Per-path client selection shared by the read/write/edit ops: paths under the
 * squad workspace root go to the squad box's client (with the squad box's
 * outage mapper, watch registered for the CALLING agent); everything else goes
 * to the member's own client. Without a squadRoute every path stays on the own
 * client and is forwarded UNCHANGED — exactly today's behavior.
 *
 * Classification is LEXICAL only (`path.posix.normalize` + prefix check on a
 * normalized boundary): the tools always pass absolute paths
 * (`enforceAbsolutePaths`), and core has no filesystem access to the box, so it
 * cannot resolve symlinks. The destination box's sandbox-server enforces its
 * own allow-prefixes (packages/k8s-sandbox/src/paths.ts) as the real security
 * boundary, backstopping any symlink escape this check cannot see. When a
 * squadRoute is present the NORMALIZED path is forwarded, so the path the
 * destination box sees is the one that was classified (a `..`-laden path can
 * never be classified one way and resolved another).
 */
function createFileOpRouter(
  manager: SandboxToolsManager,
  sandboxId: string,
  squadRoute?: SquadFileRoute
): (absolutePath: string) => FileOpTarget {
  const own: FileOpDestination = {
    kind: 'own',
    sandboxId,
    getClient: () => manager.getClientForSandbox(sandboxId),
    mapFailure: createOutageMapper(manager, sandboxId),
  }
  if (!squadRoute) return (absolutePath) => ({ ...own, path: absolutePath })
  const squad: FileOpDestination = {
    kind: 'squad',
    sandboxId: squadRoute.sandboxId,
    getClient: () => manager.getClientForSandbox(squadRoute.sandboxId),
    // Register the recovery watch for the CALLING agent (derived from its own
    // sandbox id, mirroring squad_bash's explicit agentId), not the squad box.
    mapFailure: createOutageMapper(manager, squadRoute.sandboxId, agentIdFromSandboxId(sandboxId) ?? undefined),
  }
  return (absolutePath) => {
    const normalized = posix.normalize(absolutePath)
    const destination = isPathWithinRoot(normalized, squadRoute.workspaceRoot) ? squad : own
    return { ...destination, path: normalized }
  }
}

// Type definitions for operations (matching the SDK interfaces)
type ReadRangeHint = {
  offset?: number
  limit?: number
  maxBytes?: number
}

type WriteOperations = {
  writeFile: (absolutePath: string, content: string) => Promise<void>
  mkdir: (dir: string) => Promise<void>
}

const FILE_PAGE_BYTES = 1024 * 1024
const MAX_COMPLETE_FILE_BYTES = 64 * 1024 * 1024

/**
 * Read stable pages for a complete file, Pi's text selection, or a bounded MIME
 * sniff. The sniff uses the same size/progress checks without changing the text
 * page size or truncation behavior. Verified edits still read the complete file.
 */
async function readRemoteFile(
  client: SandboxClient,
  path: string,
  range?: ReadRangeHint,
  prefixBytes?: number
): Promise<Buffer> {
  const chunks: Buffer[] = []
  let byteOffset = 0
  let expectedTotalSize: number | undefined
  let newlineCount = 0
  const startLine = Math.max(1, range?.offset ?? 1)
  const requiredLines = range?.limit === undefined ? startLine - 1 : startLine - 1 + Math.max(0, range.limit)
  let selectedStartByte = startLine === 1 ? 0 : undefined

  while (expectedTotalSize === undefined || byteOffset < expectedTotalSize) {
    const pageBytes = prefixBytes === undefined ? FILE_PAGE_BYTES : Math.min(FILE_PAGE_BYTES, prefixBytes - byteOffset)
    const response = await client.read({ path, offset: byteOffset, limit: pageBytes })
    const { totalSize } = response
    if (!Number.isSafeInteger(totalSize) || totalSize < 0) {
      throw new Error('Complete remote file read failed: remote read advertised an invalid byte count')
    }
    if (totalSize > MAX_COMPLETE_FILE_BYTES) {
      throw new Error(
        `Complete remote file read failed: remote read advertised ${totalSize} bytes; maximum is ${MAX_COMPLETE_FILE_BYTES} bytes`
      )
    }
    if (expectedTotalSize === undefined) expectedTotalSize = totalSize
    else if (totalSize !== expectedTotalSize) {
      throw new Error('Complete remote file read failed: file size changed while reading')
    }

    const chunk = Buffer.from(response.content, 'base64')
    if (chunk.byteLength > pageBytes) {
      throw new Error('Complete remote file read failed: remote read exceeded the requested page size')
    }
    const nextOffset = byteOffset + chunk.byteLength
    if (!Number.isSafeInteger(nextOffset) || nextOffset > expectedTotalSize) {
      throw new Error('Complete remote file read failed: remote read exceeded its advertised byte count')
    }
    if (chunk.byteLength === 0 && byteOffset < expectedTotalSize) {
      throw new Error(
        `Complete remote file read failed: remote read stopped at ${byteOffset} of ${expectedTotalSize} bytes`
      )
    }

    if (range) {
      for (let index = 0; index < chunk.byteLength; index += 1) {
        if (chunk[index] !== 0x0a) continue
        newlineCount += 1
        if (selectedStartByte === undefined && newlineCount === startLine - 1) {
          selectedStartByte = byteOffset + index + 1
        }
      }
    }

    chunks.push(chunk)
    byteOffset = nextOffset
    if (prefixBytes !== undefined && byteOffset >= prefixBytes) break

    if (range) {
      const selectedBytes = selectedStartByte === undefined ? 0 : byteOffset - selectedStartByte
      const hasRequestedLines = range.limit !== undefined && newlineCount >= requiredLines
      const hasTruncationBytes = range.maxBytes !== undefined && selectedBytes > range.maxBytes
      if (hasRequestedLines || hasTruncationBytes) break
    }
  }

  const result = Buffer.concat(chunks, byteOffset)
  if (!range && prefixBytes === undefined && result.byteLength !== expectedTotalSize) {
    throw new Error(
      `Complete remote file read failed: remote read returned ${result.byteLength} of ${expectedTotalSize} bytes`
    )
  }
  return result
}

type BashOperations = {
  exec: (
    command: string,
    cwd: string,
    options: {
      onData: (data: Buffer) => void
      signal?: AbortSignal
      timeout?: number
      env?: NodeJS.ProcessEnv
    }
  ) => Promise<{ exitCode: number | null }>
}

/**
 * Creates read operations that execute via HTTP to the K8s pod.
 * Config paths (skills, extensions, etc.) are read locally from Core.
 * Squad-workspace paths are served by the squad box when a squadRoute is set
 * (vm runtime only — see {@link SquadFileRoute}).
 * @internal Exported for testing only.
 */
export function createHttpReadOperations(
  manager: SandboxToolsManager,
  sandboxId: string,
  squadRoute?: SquadFileRoute
): ReadOperations {
  const route = createFileOpRouter(manager, sandboxId, squadRoute)
  const readFile = async (absolutePath: string, range?: ReadRangeHint, prefixBytes?: number): Promise<Buffer> => {
    // Serve config files (skills, extensions) directly from Core
    if (isConfigPath(absolutePath)) {
      if (prefixBytes === undefined) return Buffer.from(readFileSync(absolutePath))
      const file = await open(absolutePath, 'r')
      try {
        const buffer = Buffer.alloc(prefixBytes)
        const { bytesRead } = await file.read(buffer, 0, prefixBytes, 0)
        return buffer.subarray(0, bytesRead)
      } finally {
        await file.close()
      }
    }

    const target = route(absolutePath)
    const client = target.getClient()
    if (!client) {
      throw await target.mapFailure(new Error(`No K8s sandbox client found for ${target.sandboxId}`))
    }

    try {
      return await runIdempotentSandboxOperation({
        sandboxId: target.sandboxId,
        operationClass: 'read',
        getClient: () => client,
        recoverClient: async (failed, cause) => {
          if (!manager.recoverClient) throw cause
          return manager.recoverClient(target.sandboxId, failed, cause)
        },
        operation: (current) => readRemoteFile(current, target.path, range, prefixBytes),
      })
    } catch (err) {
      throw await target.mapFailure(err as Error)
    }
  }
  return {
    readFile,
    detectImageMimeType: async (absolutePath) =>
      detectReadImageMimeType(await readFile(absolutePath, undefined, IMAGE_SNIFF_BYTES)),

    access: async (absolutePath: string): Promise<void> => {
      // Check config files locally
      if (isConfigPath(absolutePath)) {
        accessSync(absolutePath)
        return
      }

      const target = route(absolutePath)
      const client = target.getClient()
      if (!client) {
        throw await target.mapFailure(new Error(`No K8s sandbox client found for ${target.sandboxId}`))
      }

      const response = await runIdempotentSandboxOperation({
        sandboxId: target.sandboxId,
        operationClass: 'read',
        getClient: () => client,
        recoverClient: async (failed, cause) => {
          if (!manager.recoverClient) throw cause
          return manager.recoverClient(target.sandboxId, failed, cause)
        },
        operation: (current) => current.stat({ path: target.path }),
      }).catch(async (err) => {
        throw await target.mapFailure(err as Error)
      })
      if (!response.exists) {
        throw new Error(`ENOENT: no such file or directory, access '${absolutePath}'`)
      }
    },
  }
}

const log = createLogger('sandbox-tools')

/** Log the stale-bundle mkdir fallback once per process, not once per write. */
let warnedPreMkdirRpcBundle = false

/**
 * Creates write operations that execute via HTTP to the K8s pod.
 * Squad-workspace paths are served by the squad box when a squadRoute is set
 * (vm runtime only — see {@link SquadFileRoute}).
 * @internal Exported for testing only.
 */
export function createHttpWriteOperations(
  manager: SandboxToolsManager,
  sandboxId: string,
  squadRoute?: SquadFileRoute
): WriteOperations {
  const route = createFileOpRouter(manager, sandboxId, squadRoute)
  return {
    writeFile: async (absolutePath: string, content: string): Promise<void> => {
      const target = route(absolutePath)
      const client = target.getClient()
      if (!client) {
        throw await target.mapFailure(new Error(`No K8s sandbox client found for ${target.sandboxId}`))
      }

      try {
        const encoded = Buffer.from(content).toString('base64')
        await runIdempotentSandboxOperation({
          sandboxId: target.sandboxId,
          operationClass: 'deterministic_overwrite',
          getClient: () => client,
          recoverClient: async (failed, cause) => {
            if (!manager.recoverClient) throw cause
            return manager.recoverClient(target.sandboxId, failed, cause)
          },
          operation: (current) => current.write({ path: target.path, content: encoded, createDirs: true }),
        })
      } catch (err) {
        throw await target.mapFailure(err as Error)
      }
    },

    mkdir: async (dir: string): Promise<void> => {
      const target = route(dir)
      const client = target.getClient()
      if (!client) {
        throw await target.mapFailure(new Error(`No K8s sandbox client found for ${target.sandboxId}`))
      }

      // SECURITY: the path is agent-controlled, so this MUST stay a structured
      // RPC (path as a JSON field into the box server's fs.mkdir) — never a
      // shell command with the path interpolated. A shell here was a command
      // injection on the destination box; with squad routing that meant a squad
      // MEMBER could execute as the SQUAD box's unix user, defeating the
      // isolation the routing preserves (members deliberately have no
      // squad_bash). The destination server's resolvePath allow-prefix guard
      // still bounds the path.
      try {
        await client.mkdir({ path: target.path })
      } catch (err) {
        // ROLLOUT TOLERANCE (temporary): the box server bundle is content-hash
        // versioned and pushed per-box, so during the /mkdir rollout window a
        // live box may still run a pre-RPC bundle whose router answers an
        // unknown route with a plain 404. That 404 is safe to swallow HERE and
        // ONLY here: ops.mkdir is only ever invoked by the SDK write tool
        // immediately before ops.writeFile, and writeFile sends
        // `createDirs: true`, which every bundle (old and new) honors
        // server-side via `fs.mkdir(dirname, { recursive: true })` — the
        // backstop that actually creates the directory. Any other failure
        // (400 path-guard rejection, 500 fs error, connection/outage — none of
        // which are 404s) must still propagate.
        if (err instanceof SandboxHttpError && err.status === 404) {
          if (!warnedPreMkdirRpcBundle) {
            warnedPreMkdirRpcBundle = true
            log.info(
              'box sandbox server predates the mkdir RPC (404); relying on write createDirs until the box re-provisions'
            )
          }
          return
        }
        throw await target.mapFailure(err as Error)
      }
    },
  }
}

/**
 * Creates edit operations that execute via HTTP to the K8s pod.
 * Inherits config path interception from read operations. The squadRoute is
 * threaded into BOTH legs, so an edit of a squad-workspace file reads from and
 * writes to the squad box.
 * @internal Exported for testing only.
 */
export function createHttpEditOperations(
  manager: SandboxToolsManager,
  sandboxId: string,
  squadRoute?: SquadFileRoute
): VerifiedEditOperations {
  const readOps = createHttpReadOperations(manager, sandboxId, squadRoute)
  const route = createFileOpRouter(manager, sandboxId, squadRoute)
  return {
    readFile: readOps.readFile,
    access: readOps.access,
    commitFile: async (absolutePath, result, identity) => {
      const target = route(absolutePath)
      const client = target.getClient()
      if (!client) {
        throw await target.mapFailure(new Error(`No K8s sandbox client found for ${target.sandboxId}`))
      }
      try {
        return await client.writeVerified({
          path: target.path,
          content: result.toString('base64'),
          expectedOriginal: identity.original,
          expectedResult: identity.result,
        })
      } catch (error) {
        throw await target.mapFailure(error as Error)
      }
    },
  }
}

/**
 * Creates bash operations that execute via HTTP streaming to the K8s pod.
 */
export function createHttpBashOperations(
  manager: SandboxToolsManager,
  sandboxId: string,
  tauToken?: string,
  opts?: { agentId?: string; invocationId?: string }
): BashOperations {
  const mapFailure = createOutageMapper(manager, sandboxId, opts?.agentId)
  return {
    exec: async (
      command: string,
      cwd: string,
      options: {
        onData: (data: Buffer) => void
        signal?: AbortSignal
        timeout?: number
        env?: NodeJS.ProcessEnv
      }
    ): Promise<{ exitCode: number | null }> => {
      const client = manager.getClientForSandbox(sandboxId)
      if (!client) {
        throw await mapFailure(new Error(`No K8s sandbox client found for ${sandboxId}`))
      }

      const timeout = normalizeBashTimeoutSeconds(options.timeout)

      return new Promise((resolve, reject) => {
        const stream = client.bash({
          command,
          cwd,
          invocationId: opts?.invocationId,
          timeoutSeconds: timeout,
          // Deliberately do NOT forward `options.env`: pi-coding-agent's bash tool
          // passes its whole host process.env (getShellEnv), including the HOST PATH.
          // The executor applies our env as overrides on top of the pod's own env, so
          // a forwarded host PATH clobbers the pod's PATH — making global-profile tools
          // like `gh` unfindable on empty-devbox agent boxes (squad boxes only escape
          // because their cached `devbox shellenv` re-exports PATH). It would also leak
          // the Core's host env into the sandbox. The pod owns PATH/HOME/etc via its own
          // process.env; we inject ONLY the deliberate per-command vars: the *live* Core
          // URL (so the `tau` CLI reaches the current Core even if the pod baked a stale
          // dynamic port at creation) and the per-agent token. Agent `bash` and
          // `squad_bash` share this op, so both behave identically.
          env: {
            // vm managers supply their box's baked callback URL via resolveToolApiUrl;
            // k8s managers omit it and fall back to the cluster-DNS URL derived from the
            // pod namespace (unchanged behavior).
            FICUS_API_URL: manager.resolveToolApiUrl
              ? manager.resolveToolApiUrl(sandboxId)
              : resolveSandboxApiUrl(manager.podManager!.namespace),
            ...(tauToken ? { FICUS_TOKEN: tauToken } : {}),
          } as Record<string, string>,
          sourceEnv: true,
          activateDevbox: true,
        })

        let finalExitCode: number | null = null
        let settled = false

        const settle = (fn: () => void) => {
          if (!settled) {
            settled = true
            fn()
          }
        }

        stream.on('data', (response) => {
          if (settled) return
          if (response.stdout) {
            options.onData(processCarriageReturns(Buffer.from(response.stdout, 'base64')))
          }
          if (response.stderr) {
            options.onData(processCarriageReturns(Buffer.from(response.stderr, 'base64')))
          }
          if (response.error) {
            settle(() => reject(new Error(response.error)))
          }
          if (response.exitCode !== undefined) {
            finalExitCode = response.exitCode
          }
        })

        const handleStreamError = (err: Error) => {
          // Claim settlement synchronously, then require remote cleanup before
          // surfacing the transport failure. If cleanup cannot be proven, the
          // invocation fence remains nonterminal and prevents a replay.
          if (settled) return
          settled = true
          const proveCleanup = async () => {
            try {
              await stream.cancelAndWait('transport-loss')
            } catch (firstCleanupError) {
              if (!manager.recoverClient) throw firstCleanupError
              const recovered = await manager.recoverClient(sandboxId, client, err)
              await recovered.cancelBashInvocation(stream.invocationId, 'transport-loss')
            }
          }
          void (async () => {
            let cleanupError: Error | undefined
            try {
              await proveCleanup()
            } catch (error) {
              cleanupError = error as Error
            }
            const mapped = await mapFailure(err).catch(() => err)
            reject(cleanupError ? attachSecondaryFailure(mapped, cleanupError) : mapped)
          })()
        }
        stream.on('error', handleStreamError)

        stream.on('end', () => {
          if (finalExitCode === null) {
            handleStreamError(new BashOutcomeUnknownError(stream.invocationId, 'protocol_truncated'))
            return
          }
          settle(() => resolve({ exitCode: finalExitCode }))
        })

        // Abort settlement is gated on the remote zero-owned-process proof so
        // Pi/worker retry cannot overlap the predecessor invocation.
        if (options.signal) {
          const abortHandler = () => {
            // Cancelling the HTTP reader can emit end before the remote cleanup
            // promise settles. Claim the result first: end is not an exit code.
            if (settled) return
            settled = true
            void stream.cancelAndWait('tool-abort').then(
              () => reject(new Error('Command aborted')),
              (error) => reject(new Error(`Command cleanup unproven: ${error.message}`))
            )
          }

          if (options.signal.aborted) {
            abortHandler()
            return
          }

          options.signal.addEventListener('abort', abortHandler, { once: true })

          // Clean up listener when stream ends
          stream.on('end', () => {
            options.signal?.removeEventListener('abort', abortHandler)
          })
          stream.on('error', () => {
            options.signal?.removeEventListener('abort', abortHandler)
          })
        }
      })
    },
  }
}

/**
 * Personal bash cwd for an agent's light box: always its own private dir (the
 * runtime-resolved `privateMount` — `/private` on k8s/docker, the box-native
 * `~/.private` on vm). Every agent box works in its private dir; squad members
 * additionally see the shared squad workspace (use squad_bash for the shared
 * squad runtime), solo agents have only their private dir.
 */
export function resolveAgentBashCwd(sandboxId?: string, agentId?: string): string {
  return consultantScratchPath(resolveWorkspaceLayout({ sandboxId }).privateMount, sandboxId, agentId)
}

/**
 * Wrap a file tool so it rejects relative paths. The light box exposes multiple
 * roots (the shared squad workspace + the agent's private dir), so read/write/
 * edit must take absolute paths — a cwd-relative path is ambiguous about which
 * root it means.
 */
export function enforceAbsolutePaths<T extends AgentTool<any>>(tool: T, exampleRoot?: string): T {
  const original = tool.execute.bind(tool) as (...a: unknown[]) => unknown
  tool.execute = (async (...args: unknown[]) => {
    const toolArgs = args[1] as { file_path?: unknown; path?: unknown } | undefined
    const p = toolArgs?.file_path ?? toolArgs?.path
    if (typeof p === 'string' && p.length > 0 && !p.startsWith('/')) {
      const root = exampleRoot ?? resolveWorkspaceLayout({}).workspaceMount
      throw new Error(`Path must be absolute (start with "/"): received "${p}". Use the full path, e.g. ${root}/...`)
    }
    return original(...args)
  }) as T['execute']
  return tool
}

/**
 * Creates a K8s sandboxed read tool that reads files via HTTP.
 */
export function createK8sSandboxedReadTool(
  cwd: string,
  sandboxId: string,
  manager: SandboxToolsManager,
  squadRoute?: SquadFileRoute
): AgentTool<any> {
  return createReadTool(cwd, {
    operations: createHttpReadOperations(manager, sandboxId, squadRoute),
  })
}

/**
 * Creates a K8s sandboxed write tool that writes files via HTTP.
 */
export function createK8sSandboxedWriteTool(
  cwd: string,
  sandboxId: string,
  manager: SandboxToolsManager,
  squadRoute?: SquadFileRoute
): AgentTool<any> {
  return createWriteTool(cwd, {
    operations: createHttpWriteOperations(manager, sandboxId, squadRoute),
  })
}

/**
 * Creates a K8s sandboxed edit tool that edits files via HTTP.
 */
export function createK8sSandboxedEditTool(
  cwd: string,
  sandboxId: string,
  manager: SandboxToolsManager,
  squadRoute?: SquadFileRoute
): AgentTool<any> {
  return createVerifiedEditTool(cwd, createHttpEditOperations(manager, sandboxId, squadRoute))
}

/**
 * Creates a K8s sandboxed bash tool that executes commands via HTTP streaming.
 */
export function createK8sSandboxedBashTool(
  cwd: string,
  sandboxId: string,
  manager: SandboxToolsManager,
  tauToken?: string,
  opts?: { agentId?: string; invocationOwnerId?: string }
): AgentTool<any> {
  const makeTool = (invocationId?: string) =>
    createBashTool(cwd, {
      operations: createHttpBashOperations(manager, sandboxId, tauToken, { ...opts, invocationId }),
    })
  const tool = makeTool()
  if (opts?.invocationOwnerId) {
    tool.execute = (toolCallId, params, signal, onUpdate) => {
      const invocationId = createHash('sha256')
        .update(opts.invocationOwnerId!)
        .update('\0')
        .update(toolCallId)
        .digest('hex')
      return makeTool(invocationId).execute(toolCallId, params, signal, onUpdate)
    }
  }
  tool.description = `Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last 2000 lines or 50KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds (default: 180s / 3 minutes, max: 3600s / 1 hour). ${FOREGROUND_BASH_GUIDANCE}`
  return tool
}

/** Canonical keys for K8s sandboxed tools; use these in agent type YAML tools.allow / tools.deny. */
export const K8S_SANDBOXED_TOOL_KEYS = ['Read', 'Write', 'Edit', 'Bash'] as const

/**
 * Creates all K8s sandboxed coding tools for a workspace.
 * Each tool has a stable `key` (Read, Write, Edit, Bash) for filtering by agent type.
 * All tools execute via HTTP to the K8s pod.
 *
 * @param workspacePath - The workspace root directory (unused, kept for API consistency)
 * @param sandboxId - Sandbox ID for the K8s pod
 * @param manager - SandboxToolsManager instance (k8s or vm)
 * @returns Array of sandboxed tools with keys [Read, Write, Edit, Bash]
 */
export function createK8sSandboxedCodingTools(
  _workspacePath: string,
  sandboxId: string,
  manager: SandboxToolsManager,
  tauToken?: string,
  squadId?: string,
  invocationOwnerId?: string,
  agentId?: string
): SandboxedToolWithKey[] {
  // read/write/edit take absolute paths (cwd-independent). The work root is the
  // shared squad workspace for squad members, the private dir for solo agents.
  // bash always runs in the agent's personal private dir. Both come from the
  // runtime-resolved layout, so on the vm runtime they are box-native paths.
  const workspaceMount = resolveContainerWorkRoot({ squadId, sandboxId })
  const bashCwd = resolveAgentBashCwd(sandboxId, agentId)
  // vm-only: squad members' FILE ops on squad-workspace paths are served by the
  // squad warm box (undefined on container runtimes and for solo agents, which
  // keeps their ops byte-identical). bash is deliberately NOT routed — the
  // separate squad_bash tool is how agents execute in the shared workspace.
  const squadRoute = resolveSquadFileRoute(squadId)
  const read = enforceAbsolutePaths(
    createK8sSandboxedReadTool(workspaceMount, sandboxId, manager, squadRoute),
    workspaceMount
  )
  const write = enforceAbsolutePaths(
    createK8sSandboxedWriteTool(workspaceMount, sandboxId, manager, squadRoute),
    workspaceMount
  )
  const edit = enforceAbsolutePaths(
    createK8sSandboxedEditTool(workspaceMount, sandboxId, manager, squadRoute),
    workspaceMount
  )
  const rawBash = createK8sSandboxedBashTool(bashCwd, sandboxId, manager, tauToken, { invocationOwnerId, agentId })
  // vm-only: a squad member's private bash cannot reach the squad box's paths
  // (separate unix user). Answer a denied touch of them with a `squad_bash`
  // hint instead of leaving the model to conclude the tool does not exist.
  const layout = squadId && isVmRuntime() ? resolveWorkspaceLayout({ squadId, sandboxId }) : null
  const bash = layout
    ? withSharedWorkspaceHint(rawBash, {
        sharedRoots: [layout.workspaceMount, layout.memoryMount],
        workspaceMount: layout.workspaceMount,
      })
    : rawBash

  return [
    { ...read, key: 'read' },
    { ...write, key: 'write' },
    { ...edit, key: 'edit' },
    { ...bash, key: 'bash' },
  ]
}
