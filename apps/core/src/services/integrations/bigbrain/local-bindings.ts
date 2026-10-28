import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import { constants } from 'node:fs'
import { access, open, realpath, rename, stat, lstat, unlink } from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { z } from 'zod'
import { getHomeDir } from '../../../lib/utils/home'
import { bigbrainHostAvailability } from './availability'
import { BigbrainError } from './errors'

const pathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((s) => isAbsolute(s) && [...s].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127))
export const BIGBRAIN_BINDINGS_FILE = 'bigbrain-bindings.json'
const declaration = z.strictObject({
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
export const BigbrainConfigSchema = z.strictObject({
  version: z.literal(2),
  bindingId: declaration.shape.id,
  bindingFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  vaultPath: pathSchema,
  executablePath: pathSchema,
})
export type BigbrainConfigV2 = z.infer<typeof BigbrainConfigSchema>
export type BigbrainBindingDeclaration = z.infer<typeof declaration>
const bindingsFileSchema = z.strictObject({
  version: z.literal(1),
  /** Present when Ficus wrote the file itself (one-click setup). Absent on hand-written files. */
  managedBy: z.literal('ficus').optional(),
  bindings: z.array(declaration).max(32),
})
/** What is on disk now: nothing, a Ficus-managed file, a hand-written file, or an unusable one. */
export type BigbrainBindingsFileState =
  | { status: 'none'; bindings: [] }
  | { status: 'managed' | 'unmanaged'; bindings: BigbrainBindingDeclaration[] }
  | { status: 'invalid'; bindings: [] }
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

/** Every ancestor is owned by root or the service account and not group/world writable
 * (sticky shared temp parents excepted, since they cannot replace owned children). */
export async function assertTrustedPath(path: string): Promise<void> {
  let current = await realpath(path)
  while (true) {
    const meta = await stat(current)
    const stickyAncestor = current !== resolve(path) && meta.isDirectory() && (meta.mode & 0o1000) !== 0
    if (![0, process.getuid?.()].includes(meta.uid) || ((meta.mode & 0o022) !== 0 && !stickyAncestor))
      throw new BigbrainError('invalid_configuration')
    const parent = dirname(current)
    if (parent === current) return
    current = parent
  }
}

/** Ficus HOME_DIR roots that agents can reach; BigBrain state must stay outside all of them. */
export async function agentExposedRoots(home: string): Promise<string[]> {
  const roots = ['workspaces', 'memory', 'private', 'nix', 'attachments', 'skills', 'agent', 'ssh', 'cli'].map((part) =>
    join(home, part)
  )
  // Resolve existing exposed-root symlinks as well as lexical paths.
  return Promise.all(
    roots.map(async (root) => {
      try {
        return await realpath(root)
      } catch {
        return resolve(root)
      }
    })
  )
}
export function overlapsAny(roots: readonly string[], path: string): boolean {
  return roots.some((root) => contains(root, path) || contains(path, root))
}

/** The host declaration of which executable, vault and named BigBrain connection Core may run.
 * Ficus writes it itself during one-click setup (`write`); API callers otherwise select IDs. */
export class BigbrainBindings {
  readonly #home: string
  readonly #supported: () => boolean
  readonly #osHome: string | undefined
  constructor(options: { home?: string; supported?: () => boolean; osHome?: string } = {}) {
    this.#home = options.home ?? getHomeDir()
    this.#osHome = options.osHome ?? getDefaultEnvironment().HOME
    this.#supported = options.supported ?? (() => bigbrainHostAvailability().available)
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
  /** Classify the file without throwing, for setup decisions (adopt/replace confirmation). */
  async inspect(): Promise<BigbrainBindingsFileState> {
    try {
      const file = await this.#readFile()
      if (!file) return { status: 'none', bindings: [] }
      return { status: file.managedBy === 'ficus' ? 'managed' : 'unmanaged', bindings: file.bindings }
    } catch (error) {
      if (error instanceof BigbrainError && error.code === 'unsupported_host') throw error
      return { status: 'invalid', bindings: [] }
    }
  }
  /** Atomically replace the file as a Ficus-managed declaration (mode 0600, never through a
   * symlink). An empty list removes the file. Callers serialize writes. */
  async write(bindings: readonly BigbrainBindingDeclaration[]): Promise<void> {
    if (!this.#supported()) throw new BigbrainError('unsupported_host')
    const parsed = bindingsFileSchema.safeParse({ version: 1, managedBy: 'ficus', bindings })
    if (!parsed.success || new Set(bindings.map((b) => b.id)).size !== bindings.length)
      throw new BigbrainError('invalid_configuration')
    await assertTrustedPath(this.#home).catch(() => {
      throw new BigbrainError('invalid_configuration')
    })
    const target = join(this.#home, BIGBRAIN_BINDINGS_FILE)
    if (bindings.length === 0) {
      await unlink(target).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw new BigbrainError('invalid_configuration')
      })
      return
    }
    const temporary = join(this.#home, `.${BIGBRAIN_BINDINGS_FILE}.${randomBytes(8).toString('hex')}.tmp`)
    try {
      const file = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600
      )
      try {
        await file.writeFile(JSON.stringify(parsed.data, null, 2) + '\n')
        await file.chmod(0o600)
        await file.sync()
      } finally {
        await file.close()
      }
      // rename replaces a symlink entry itself, never its target.
      await rename(temporary, target)
    } catch {
      await unlink(temporary).catch(() => {})
      throw new BigbrainError('invalid_configuration')
    }
  }
  async #read(): Promise<z.infer<typeof declaration>[]> {
    return (await this.#readFile())?.bindings ?? []
  }
  async #readFile(): Promise<z.infer<typeof bindingsFileSchema> | null> {
    try {
      if (!this.#supported()) throw new BigbrainError('unsupported_host')
      await this.#trusted(this.#home)
      const file = await open(
        join(this.#home, BIGBRAIN_BINDINGS_FILE),
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
        const parsed = bindingsFileSchema.parse(JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')))
        if (new Set(parsed.bindings.map((e) => e.id)).size !== parsed.bindings.length)
          throw new BigbrainError('invalid_configuration')
        return parsed
      } finally {
        await file.close()
      }
    } catch (error) {
      if (error instanceof BigbrainError) throw error
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw new BigbrainError('invalid_configuration')
    }
  }
  #trusted(path: string): Promise<void> {
    return assertTrustedPath(path)
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
      const exposed = await agentExposedRoots(this.#home)
      for (const path of [vaultPath, executablePath, selectedStore, clientDirectory, clientFile]) {
        if (overlapsAny(exposed, path)) throw new BigbrainError('invalid_configuration')
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
