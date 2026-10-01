/**
 * Host runtime coding tools.
 *
 * No transport: read/write use pi's local filesystem defaults, edit uses the
 * shared verified-edit planner over local fs, bash uses pi's local shell
 * backend with a spawn hook that swaps in the host runtime env (login-shell
 * snapshot + FICUS vars) and prepends the squad `.ficus/.env` preamble. Paths are
 * absolute (enforceAbsolutePaths) exactly as on every other runtime.
 */

import { createHash, randomUUID } from 'crypto'
import { access, chmod, readFile, realpath, rename, stat, unlink, writeFile } from 'fs/promises'
import { basename, dirname, join } from 'path'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import {
  createBashTool,
  createLocalBashOperations,
  createReadTool,
  createWriteTool,
} from '@earendil-works/pi-coding-agent'
import type { SandboxedToolWithKey } from '../services/sandbox/types'
import { resolveContainerWorkRoot } from '../services/sandbox/workspace-layout'
import { agentIdFromSandboxId, buildHostCommandEnv, buildHostPreamble } from '../services/sandbox/host/env'
import { createVerifiedEditTool, type VerifiedEditOperations } from './verified-edit'
import { enforceAbsolutePaths, resolveAgentBashCwd } from './sandbox-tools'
import {
  BASH_DEFAULT_TIMEOUT_SECONDS,
  BASH_MAX_TIMEOUT_SECONDS,
  FOREGROUND_BASH_GUIDANCE,
  normalizeBashTimeoutSeconds,
} from '../lib/bash-contract'

export const HOST_BASH_DEFAULT_TIMEOUT_S = BASH_DEFAULT_TIMEOUT_SECONDS
export const HOST_BASH_MAX_TIMEOUT_S = BASH_MAX_TIMEOUT_SECONDS

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex')

/** Filesystem primitives used by {@link createLocalVerifiedEditOperations}, overridable in
 * tests to force a failure mid-commit (after the tmp file is staged) without relying on
 * directory-permission tricks, which are unreliable when tests run as root. */
export interface LocalVerifiedEditFsDeps {
  realpath?: (path: string) => Promise<string>
  stat?: (path: string) => Promise<{ isFile(): boolean; mode: number }>
  readFile?: (path: string) => Promise<Buffer>
  writeFile?: (path: string, data: Buffer, opts: { flag: string; mode: number }) => Promise<void>
  chmod?: (path: string, mode: number) => Promise<void>
  rename?: (from: string, to: string) => Promise<void>
  unlink?: (path: string) => Promise<void>
}

export function createLocalVerifiedEditOperations(deps: LocalVerifiedEditFsDeps = {}): VerifiedEditOperations {
  const fsRealpath = deps.realpath ?? realpath
  const fsStat = deps.stat ?? stat
  const fsReadFile = deps.readFile ?? readFile
  const fsWriteFile = deps.writeFile ?? writeFile
  const fsChmod = deps.chmod ?? chmod
  const fsRename = deps.rename ?? rename
  const fsUnlink = deps.unlink ?? unlink

  return {
    access: (path) => access(path),
    readFile: (path) => readFile(path),
    async commitFile(path, result, identity) {
      // Resolve symlinks BEFORE staging: readFile (above, and in the presentation
      // planner) follows a symlink transparently, but `rename(tmp, path)` replaces
      // whatever inode `path` names — if `path` is a symlink, that would delete the
      // link and put a plain file in its place instead of updating the link's
      // target. Committing against the resolved real path keeps the link intact.
      let realPath: string
      try {
        realPath = await fsRealpath(path)
      } catch {
        throw new Error(`Edit aborted: ${path} is a dangling symlink or does not exist`)
      }
      const st = await fsStat(realPath)
      if (!st.isFile()) {
        throw new Error(`Edit aborted: ${realPath} is not a regular file`)
      }
      const current = await fsReadFile(realPath)
      if (current.byteLength !== identity.original.bytes || sha256(current) !== identity.original.sha256) {
        throw new Error(`Edit aborted: ${path} changed on disk since it was read; re-read and retry`)
      }
      const resultSha = sha256(result)
      if (result.byteLength !== identity.result.bytes || resultSha !== identity.result.sha256) {
        throw new Error('Edit aborted: planned result identity mismatch; original file was not modified')
      }
      // Keep setuid/setgid/sticky too. `writeFile`'s own `mode` option is subject to
      // the process umask (like open()'s mode), so it alone cannot reproduce the
      // original permissions — the explicit chmod after write is load-bearing, not
      // redundant.
      const mode = st.mode & 0o7777
      const tmp = join(dirname(realPath), `.${basename(realPath)}.${process.pid}.${randomUUID()}.ficus-edit.tmp`)
      try {
        await fsWriteFile(tmp, result, { flag: 'wx', mode })
        await fsChmod(tmp, mode)
        await fsRename(tmp, realPath)
      } catch (err) {
        await fsUnlink(tmp).catch(() => {})
        throw err
      }
      return { bytesWritten: result.byteLength, sha256: resultSha }
    },
  }
}

/** Clamp a user-supplied bash timeout (seconds) to the host runtime's bounds.
 * `undefined` or a non-finite/non-positive value falls back to the default;
 * anything above the max is capped. Pure so it is unit-testable without spawning a shell. */
export function clampHostBashTimeout(timeout?: number): number {
  return normalizeBashTimeoutSeconds(timeout)
}

export function createHostBashTool(
  cwd: string,
  opts: { ficusToken?: string; squadId?: string; agentId?: string } = {}
): AgentTool<any> {
  const local = createLocalBashOperations()
  const tool = createBashTool(cwd, {
    exposeSessionEnvironment: false,
    // Both the preamble and the env are built PER COMMAND. The preamble's
    // snapshot variable names carry a random suffix whose whole purpose is that
    // the squad env file cannot name them in advance — and the preamble is
    // prepended to the command string, i.e. argv, which the agent's own command
    // can read. Building it once per tool would publish one set of names on the
    // first command and then reuse them for every command after it.
    spawnHook: (ctx) => ({
      command: buildHostPreamble(opts) + ctx.command,
      cwd: ctx.cwd,
      env: buildHostCommandEnv({ ficusToken: opts.ficusToken, squadId: opts.squadId, agentId: opts.agentId }),
    }),
    operations: {
      exec: (command, execCwd, options) =>
        local.exec(command, execCwd, {
          ...options,
          timeout: clampHostBashTimeout(options.timeout),
        }),
    },
  })
  tool.description = `Execute a bash command in the current working directory on this machine. Returns stdout and stderr. Output is truncated to last 2000 lines or 50KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds (default: ${HOST_BASH_DEFAULT_TIMEOUT_S}s, max: ${HOST_BASH_MAX_TIMEOUT_S}s). ${FOREGROUND_BASH_GUIDANCE}`
  return tool
}

export function createHostSandboxedCodingTools(
  _workspacePath: string,
  sandboxId: string,
  ficusToken?: string,
  squadId?: string,
  _invocationOwnerId?: string,
  agentId?: string
): SandboxedToolWithKey[] {
  const workRoot = resolveContainerWorkRoot({ squadId, sandboxId })
  const bashCwd = resolveAgentBashCwd(sandboxId, agentId)
  const read = enforceAbsolutePaths(createReadTool(workRoot) as AgentTool<any>, workRoot)
  const write = enforceAbsolutePaths(createWriteTool(workRoot) as AgentTool<any>, workRoot)
  const edit = enforceAbsolutePaths(createVerifiedEditTool(workRoot, createLocalVerifiedEditOperations()), workRoot)
  // Prefer the agent id the runner passed. The sandbox-id derivation is only a
  // fallback: `system_manager_<ownerUserId>` boxes carry no agent id at all, and
  // a descendant sharing a box would otherwise inherit the box owner's id.
  const bash = createHostBashTool(bashCwd, {
    ficusToken,
    squadId,
    agentId: agentId ?? agentIdFromSandboxId(sandboxId),
  })
  return [
    { ...read, key: 'read' },
    { ...write, key: 'write' },
    { ...edit, key: 'edit' },
    { ...bash, key: 'bash' },
  ]
}
