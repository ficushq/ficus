import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import { constants } from 'node:fs'
import { access, open, realpath, stat, lstat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { z } from 'zod'
import { getHomeDir } from '../../../lib/utils/home'
import { isPlatformManaged } from '../../secrets/managed'
import { isHostRuntime, requireSandboxRuntime } from '../../sandbox/runtime'
import { BigbrainError } from './errors'

const pathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((s) => isAbsolute(s) && [...s].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127))
const declaration = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
    label: z
      .string()
      .min(1)
      .max(120)
      .refine((s) => [...s].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127)),
    vaultPath: pathSchema,
    executablePath: pathSchema,
    clientId: z.string().regex(/^[a-f0-9]{8}$/),
    tokenStorePath: pathSchema.optional(),
  })
  .strict()
export const BigbrainConfigSchema = z
  .object({
    version: z.literal(2),
    bindingId: declaration.shape.id,
    bindingFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    vaultPath: pathSchema,
    executablePath: pathSchema,
  })
  .strict()
export type BigbrainConfigV2 = z.infer<typeof BigbrainConfigSchema>
export interface ResolvedBigbrainBinding {
  configuration: BigbrainConfigV2
  label: string
  configuredExecutablePath: string
  clientId: string
  tokenStorePath?: string
}
export interface BigbrainBindingSummary {
  id: string
  label: string
  vaultPath: string
  executablePath: string
}

function contains(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}
function supportedHost(): boolean {
  try {
    return process.platform !== 'win32' && !isPlatformManaged() && !isHostRuntime() && !!requireSandboxRuntime()
  } catch {
    return false
  }
}

/** Only an OS operator can declare executable/vault authority. API callers select IDs, never paths. */
export class BigbrainBindings {
  readonly #home: string
  readonly #supported: () => boolean
  readonly #osHome: string | undefined
  constructor(options: { home?: string; supported?: () => boolean; osHome?: string } = {}) {
    this.#home = options.home ?? getHomeDir()
    this.#osHome = options.osHome ?? getDefaultEnvironment().HOME
    this.#supported = options.supported ?? supportedHost
  }
  async list(): Promise<BigbrainBindingSummary[]> {
    const entries = await this.#read()
    const summaries: BigbrainBindingSummary[] = []
    for (const entry of entries) {
      const resolved = await this.#resolve(entry)
      summaries.push({
        id: entry.id,
        label: entry.label,
        vaultPath: resolved.configuration.vaultPath,
        executablePath: resolved.configuration.executablePath,
      })
    }
    return summaries
  }
  async resolve(id: string): Promise<ResolvedBigbrainBinding> {
    const entry = (await this.#read()).find((entry) => entry.id === id)
    if (!entry) throw new BigbrainError('binding_unavailable')
    return this.#resolve(entry)
  }
  async resolvePinned(config: BigbrainConfigV2): Promise<ResolvedBigbrainBinding> {
    const parsed = BigbrainConfigSchema.safeParse(config)
    if (!parsed.success) throw new BigbrainError('invalid_configuration')
    const binding = await this.resolve(parsed.data.bindingId)
    if (JSON.stringify(binding.configuration) !== JSON.stringify(parsed.data))
      throw new BigbrainError('binding_changed')
    return binding
  }
  async #read(): Promise<z.infer<typeof declaration>[]> {
    try {
      if (!this.#supported()) throw new BigbrainError('unsupported_host')
      await this.#trusted(this.#home)
      const file = await open(
        join(this.#home, 'bigbrain-bindings.json'),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
      )
      try {
        const meta = await file.stat()
        if (
          !meta.isFile() ||
          meta.size > 65536 ||
          (meta.mode & 0o077) !== 0 ||
          ![0, process.getuid?.()].includes(meta.uid)
        )
          throw new BigbrainError('invalid_configuration')
        // A bounded positional read also covers a declaration growing after stat.
        const buffer = Buffer.alloc(65537)
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
        if (bytesRead > 65536) throw new BigbrainError('invalid_configuration')
        const entries = z
          .object({ version: z.literal(1), bindings: z.array(declaration).max(32) })
          .strict()
          .parse(JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'))).bindings
        if (new Set(entries.map((e) => e.id)).size !== entries.length) throw new BigbrainError('invalid_configuration')
        return entries
      } finally {
        await file.close()
      }
    } catch (error) {
      if (error instanceof BigbrainError) throw error
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw new BigbrainError('invalid_configuration')
    }
  }
  async #trusted(path: string): Promise<void> {
    let current = await realpath(path)
    while (true) {
      const meta = await stat(current)
      // System ancestors may be root-owned; sticky shared temp parents cannot replace owned children.
      const stickyAncestor = current !== resolve(path) && meta.isDirectory() && (meta.mode & 0o1000) !== 0
      if (![0, process.getuid?.()].includes(meta.uid) || ((meta.mode & 0o022) !== 0 && !stickyAncestor))
        throw new BigbrainError('invalid_configuration')
      const parent = dirname(current)
      if (parent === current) return
      current = parent
    }
  }
  async #resolve(entry: z.infer<typeof declaration>): Promise<ResolvedBigbrainBinding> {
    try {
      const vaultPath = await realpath(entry.vaultPath)
      const executablePath = await realpath(entry.executablePath)
      if (!entry.tokenStorePath && !this.#osHome) throw new BigbrainError('binding_unavailable')
      const configuredStore =
        entry.tokenStorePath ??
        join(
          this.#osHome!,
          '.config',
          'bigbrain',
          'tokens',
          createHash('sha256').update(vaultPath).digest('hex').slice(0, 12) + '.json'
        )
      if (!(await lstat(configuredStore)).isFile()) throw new BigbrainError('invalid_configuration')
      const selectedStore = await realpath(configuredStore)
      const clientDirectory = await realpath(`${selectedStore}.clients`)
      const clientFile = join(clientDirectory, `${entry.clientId}.json`)
      const tokenStorePath = entry.tokenStorePath ? selectedStore : undefined
      const roots = ['workspaces', 'memory', 'private', 'nix', 'attachments', 'skills', 'agent', 'ssh', 'cli'].map(
        (part) => join(this.#home, part)
      )
      // Resolve existing exposed-root symlinks as well as lexical paths.
      const exposed = await Promise.all(
        roots.map(async (root) => {
          try {
            return await realpath(root)
          } catch {
            return resolve(root)
          }
        })
      )
      for (const path of [vaultPath, executablePath, selectedStore, clientDirectory, clientFile]) {
        if (exposed.some((root) => contains(root, path) || contains(path, root)))
          throw new BigbrainError('invalid_configuration')
        await this.#trusted(path)
      }
      if (
        !(await stat(vaultPath)).isDirectory() ||
        !(await lstat(join(vaultPath, 'vault.yaml'))).isFile() ||
        !(await stat(executablePath)).isFile()
      )
        throw new BigbrainError('binding_unavailable')
      await access(executablePath, constants.X_OK)
      for (const state of [selectedStore, clientFile]) {
        const meta = await lstat(state)
        if (!meta.isFile() || (meta.mode & 0o077) !== 0) throw new BigbrainError('invalid_configuration')
        await access(state, constants.R_OK)
      }
      const bindingFingerprint = createHash('sha256')
        .update(
          JSON.stringify([
            entry.id,
            vaultPath,
            executablePath,
            entry.clientId,
            tokenStorePath ?? 'default-service-account',
          ])
        )
        .digest('hex')
      return {
        configuration: { version: 2, bindingId: entry.id, bindingFingerprint, vaultPath, executablePath },
        label: entry.label,
        configuredExecutablePath: entry.executablePath,
        clientId: entry.clientId,
        ...(tokenStorePath ? { tokenStorePath } : {}),
      }
    } catch (error) {
      if (error instanceof BigbrainError) throw error
      throw new BigbrainError('binding_unavailable')
    }
  }
}
