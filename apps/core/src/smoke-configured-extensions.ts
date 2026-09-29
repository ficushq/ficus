#!/usr/bin/env bun
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { loadExtensions } from '@earendil-works/pi-coding-agent'
import { load as loadYaml } from 'js-yaml'

const REQUIRED_TOOLS: Readonly<Record<string, readonly string[]>> = {
  'code-ast': ['ast_references', 'ast_rename', 'ast_symbols'],
}

export interface SmokeConfiguredExtensionsOptions {
  extensionsDir: string
  cwd: string
}

export interface SmokeConfiguredExtensionsResult {
  extensions: string[]
  tools: Record<string, string[]>
}

interface PiPackageManifest {
  name?: string
  pi?: { extensions?: unknown }
}

/**
 * Load each packaged config extension independently through Pi's real loader.
 * Independent loads keep failures attributable to the configured extension
 * instead of reporting an undifferentiated batch of paths.
 */
export async function smokeConfiguredExtensions(
  opts: SmokeConfiguredExtensionsOptions
): Promise<SmokeConfiguredExtensionsResult> {
  const extensions: string[] = []
  const tools: Record<string, string[]> = {}
  const configDir = dirname(dirname(opts.extensionsDir))
  const agentTypesDir = join(configDir, 'agent-types')
  const configuredNames = new Set<string>()
  const agentTypeFiles = (await readdir(agentTypesDir)).filter((name) => /\.ya?ml$/.test(name)).sort()
  for (const fileName of agentTypeFiles) {
    const agentType = loadYaml(await readFile(join(agentTypesDir, fileName), 'utf8')) as { extensions?: unknown }
    if (agentType.extensions === undefined || agentType.extensions === null) continue
    if (!Array.isArray(agentType.extensions) || agentType.extensions.some((name) => typeof name !== 'string')) {
      throw new Error(`agent type ${fileName} has an invalid extensions list`)
    }
    for (const name of agentType.extensions as string[]) configuredNames.add(name)
  }

  for (const extensionName of [...configuredNames].sort()) {
    const extensionRoot = join(opts.extensionsDir, extensionName)
    let manifest: PiPackageManifest
    try {
      manifest = JSON.parse(await readFile(join(extensionRoot, 'package.json'), 'utf8')) as PiPackageManifest
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`configured extension ${extensionName} has no package.json at ${extensionRoot}`)
      }
      throw new Error(`configured extension ${extensionName} has an invalid package.json: ${String(error)}`)
    }

    const configuredPaths = manifest.pi?.extensions
    if (
      !Array.isArray(configuredPaths) ||
      configuredPaths.length === 0 ||
      configuredPaths.some((path) => typeof path !== 'string' || path.trim().length === 0)
    ) {
      throw new Error(
        `configured extension ${extensionName} has invalid pi.extensions: expected a non-empty array of non-empty strings`
      )
    }
    const resolvedPaths = configuredPaths.map((path) => resolve(extensionRoot, path as string))
    const loaded = await loadExtensions(resolvedPaths, opts.cwd)
    if (loaded.errors.length > 0) {
      const details = loaded.errors.map((failure) => `${failure.path}: ${failure.error}`).join('\n')
      throw new Error(`configured extension ${extensionName} failed to load:\n${details}`)
    }
    if (loaded.extensions.length !== resolvedPaths.length) {
      throw new Error(
        `configured extension ${extensionName} loaded ${loaded.extensions.length} of ${resolvedPaths.length} entry points`
      )
    }

    const registeredTools = [...new Set(loaded.extensions.flatMap((extension) => [...extension.tools.keys()]))].sort()
    for (const required of REQUIRED_TOOLS[extensionName] ?? []) {
      if (!registeredTools.includes(required)) {
        throw new Error(`configured extension ${extensionName} did not register required tool ${required}`)
      }
    }
    extensions.push(extensionName)
    tools[extensionName] = registeredTools
  }

  return { extensions, tools }
}

if (import.meta.main) {
  const extensionsDir = process.argv[2]
  if (!extensionsDir) throw new Error('usage: smoke-configured-extensions <extensions-dir> [cwd]')
  const result = await smokeConfiguredExtensions({
    extensionsDir: resolve(extensionsDir),
    cwd: resolve(process.argv[3] ?? process.cwd()),
  })
  console.log(`configured extension smoke: PASS (${result.extensions.join(', ') || 'none'})`)
}
