import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MONOREPO_ROOT } from '../../lib/paths'
import type { VariantContext } from './define'

/**
 * One version of the agent guidance: a directory laid out like the repository, from which the
 * eval reads config/ (agent types, shared prompts, roles) and imports the prompt and tool modules.
 */
export interface PromptVariant {
  /** Shown in reports: `working tree`, or the ref and its short commit. */
  label: string
  root: string
  /** The commit, when the variant is a git ref. */
  commit?: string
}

/**
 * Paths a variant needs; everything else (dependencies, other shared modules) comes from the working
 * tree. The migration journal is read when the database module loads.
 */
const VARIANT_PATHS = [
  'config',
  'packages/shared/src/public-voice.ts',
  'apps/core/src',
  'apps/core/package.json',
  'apps/core/drizzle/meta',
  'apps/cli/src',
  'apps/cli/package.json',
  // Core modules the tool definitions load import a few files from outside apps/core
  // (for example sandbox/host/browser.ts and sandbox/bashrc.ts).
  'scripts/machine',
  'scripts/bigbrain',
  'scripts/artifact',
  'packages/sandbox-server/src',
]
/** Bump when VARIANT_PATHS changes so cached extractions are refreshed. */
const EXTRACTION_VERSION = 5

export function workingTreeVariant(): PromptVariant {
  return { label: 'working tree', root: MONOREPO_ROOT }
}

/**
 * Extracts `ref` into a cache directory and links the working tree's installed dependencies into
 * it, so its modules import the same way. Workspace packages such as @ficus/shared therefore
 * resolve to the working tree's copy; the voice resolver is extracted and imported directly.
 * The guidance itself (config/, apps/core/src, apps/cli/src)
 * is the ref's.
 */
export function gitRefVariant(ref: string, repoRoot = MONOREPO_ROOT): PromptVariant {
  const commit = execFileSync('git', ['-C', repoRoot, 'rev-parse', '--verify', `${ref}^{commit}`], {
    encoding: 'utf8',
  }).trim()
  const root = join(tmpdir(), 'ficus-agent-evals', commit)
  const ready = join(root, `.extracted-v${EXTRACTION_VERSION}`)
  if (!existsSync(ready)) {
    rmSync(root, { recursive: true, force: true })
    mkdirSync(root, { recursive: true })
    const present = VARIANT_PATHS.filter((path) => {
      try {
        execFileSync('git', ['-C', repoRoot, 'cat-file', '-e', `${commit}:${path}`], { stdio: 'ignore' })
        return true
      } catch {
        return false
      }
    })
    const archive = execFileSync('git', ['-C', repoRoot, 'archive', '--format=tar', commit, ...present], {
      maxBuffer: 512 * 1024 * 1024,
    })
    execFileSync('tar', ['-x', '-C', root], { input: archive })
    for (const modules of ['node_modules', 'apps/core/node_modules', 'apps/cli/node_modules']) {
      const source = join(repoRoot, modules)
      if (existsSync(source) && !existsSync(join(root, modules))) symlinkSync(source, join(root, modules))
    }
    mkdirSync(ready)
  }
  return { label: `${ref} (${commit.slice(0, 8)})`, root, commit }
}

/** `working` (or `.`) for the working tree, anything else is a git ref. */
export function resolveVariant(spec: string): PromptVariant {
  return spec === 'working' || spec === '.' ? workingTreeVariant() : gitRefVariant(spec)
}

/**
 * Imports a module by repository-relative path from the variant, or from the working tree when the
 * variant predates it (for example a ref from before the module was added).
 */
export async function importFromVariant<T>(variant: PromptVariant, relativePath: string): Promise<T> {
  const own = join(variant.root, relativePath)
  return (await import(existsSync(own) ? own : join(workingTreeVariant().root, relativePath))) as T
}

export function variantContext(variant: PromptVariant): VariantContext {
  return { import: <T>(relativePath: string) => importFromVariant<T>(variant, relativePath) }
}
