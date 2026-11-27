import {
  createExtensionRuntime,
  LoadExtensionsResult,
  loadSkillsFromDir,
  LoadSkillsResult,
  ResourceLoader,
  loadExtensions,
  type CompactionResult,
  type Extension,
  type SessionBeforeCompactEvent,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent'

import { createLogger } from '../../lib/infra/logger'
import type { PrecompactionController } from './precompaction/controller'
import { createPrecompactionExtension } from './precompaction/extension'
import { createShortTermMemoryContextExtension, type ShortTermMemoryContext } from './short-term-memory-context'

const log = createLogger('resource-loader')

/** Applied to every tool a loaded extension registers, e.g. output redaction. */
export type ExtensionToolWrapper = (tool: ToolDefinition) => ToolDefinition

/**
 * Route every tool an extension registers, now or later at runtime, through
 * `wrapTool`. Extension tools reach pi through `extension.tools`, not the
 * session's custom tool list, so wrapping that list alone would miss them.
 */
function wrapExtensionTools(extension: Extension, wrapTool: ExtensionToolWrapper): void {
  const tools = extension.tools
  const set = tools.set.bind(tools)
  type Registered = Parameters<typeof set>[1]
  const wrap = (registered: Registered): Registered => ({
    ...registered,
    definition: wrapTool(registered.definition as ToolDefinition) as Registered['definition'],
  })
  for (const [name, registered] of tools) set(name, wrap(registered))
  tools.set = (name, registered) => set(name, wrap(registered))
}

/**
 * Pi agent session resource loader to customize system prompt and skills.
 */
export class FicusResourceLoader implements ResourceLoader {
  private skills: LoadSkillsResult | null = null
  private extensions: LoadExtensionsResult | null = null
  private precompactionController?: PrecompactionController
  private fitCompactionFallback?: (event: SessionBeforeCompactEvent) => Promise<CompactionResult | undefined>
  private shortTermMemoryContext?: ShortTermMemoryContext
  private systemPromptSuffix = ''
  private readonly shortTermMemoryExtension = createShortTermMemoryContextExtension(() => this.shortTermMemoryContext)
  private readonly precompactionExtension: Extension = createPrecompactionExtension(
    () => this.precompactionController,
    () => this.fitCompactionFallback
  )

  constructor(
    private readonly systemPrompt: string,
    private readonly skillPaths?: string[],
    private readonly extensionPaths?: string[],
    private readonly wrapExtensionTool?: ExtensionToolWrapper
  ) {}

  static async create(
    systemPrompt: string,
    skillPaths?: string[],
    extensionPaths?: string[],
    wrapExtensionTool?: ExtensionToolWrapper
  ): Promise<FicusResourceLoader> {
    const loader = new FicusResourceLoader(systemPrompt, skillPaths, extensionPaths, wrapExtensionTool)
    await loader.init()
    return loader
  }

  async init(): Promise<void> {
    this.loadSkills()
    await this.loadExtensions()
  }

  /**
   * Load skills from the skill paths, caching the result.
   *
   * @returns The loaded skills.
   */
  private loadSkills(): LoadSkillsResult {
    const allSkills =
      this.skillPaths?.map((path) =>
        loadSkillsFromDir({
          dir: path,
          source: 'ficus',
        })
      ) ?? []

    this.skills = {
      skills: allSkills.flatMap((l) => l.skills),
      diagnostics: allSkills.flatMap((l) => l.diagnostics),
    }

    return this.skills
  }

  /**
   * Load extensions from the extension paths, caching the result.
   *
   * @returns The loaded extensions.
   */
  private async loadExtensions(): Promise<void> {
    if (this.extensionPaths?.length) {
      this.extensions = await loadExtensions(this.extensionPaths, process.cwd())
      if (this.wrapExtensionTool) {
        for (const extension of this.extensions.extensions) wrapExtensionTools(extension, this.wrapExtensionTool)
      }
      if (this.extensions.errors.length > 0) {
        log.error(`Failed to load extensions:`, JSON.stringify(this.extensions.errors))
      }
      // e.g. an extension package that lists host-provided pi modules in `dependencies`.
      if (this.extensions.warnings?.length) {
        log.warn(`Extension load warnings:`, JSON.stringify(this.extensions.warnings))
      }
    }
  }

  setPrecompactionController(controller: PrecompactionController): void {
    this.precompactionController = controller
  }

  setShortTermMemoryContext(context: ShortTermMemoryContext): void {
    this.shortTermMemoryContext = context
  }

  setFitCompactionFallback(fn: (event: SessionBeforeCompactEvent) => Promise<CompactionResult | undefined>): void {
    this.fitCompactionFallback = fn
  }

  /** The tools the loaded extensions registered, as pi will register them. */
  getExtensionTools(): ToolDefinition[] {
    return (this.extensions?.extensions ?? []).flatMap((extension) =>
      [...extension.tools.values()].map((registered) => registered.definition as ToolDefinition)
    )
  }

  /**
   * Replace the definition of every tool the loaded extensions registered so far, without
   * wrapping it again (the definitions are already wrapped). Used to label tools for tool search
   * before the pi session reads them.
   */
  relabelExtensionTools(relabel: (tool: ToolDefinition) => ToolDefinition): void {
    for (const extension of this.extensions?.extensions ?? []) {
      const tools = extension.tools
      for (const [name, registered] of tools) {
        type Registered = typeof registered
        const definition = relabel(registered.definition as ToolDefinition) as Registered['definition']
        if (definition !== registered.definition) Map.prototype.set.call(tools, name, { ...registered, definition })
      }
    }
  }

  /** Text appended to the system prompt (the hidden-tools section). Set before the session is created. */
  setSystemPromptSuffix(suffix: string): void {
    this.systemPromptSuffix = suffix
  }

  getExtensions() {
    const base =
      this.extensions ||
      ({
        extensions: [],
        errors: [],
        runtime: createExtensionRuntime(),
      } satisfies LoadExtensionsResult)

    return { ...base, extensions: [...base.extensions, this.precompactionExtension, this.shortTermMemoryExtension] }
  }

  getSkills() {
    return this.skills || this.loadSkills()
  }

  getPrompts() {
    return { prompts: [], diagnostics: [] }
  }

  getThemes() {
    return { themes: [], diagnostics: [] }
  }

  getAgentsFiles() {
    return { agentsFiles: [] }
  }

  getSystemPrompt() {
    return this.systemPromptSuffix ? `${this.systemPrompt}\n\n${this.systemPromptSuffix}` : this.systemPrompt
  }

  /**
   * Pi 0.84 asks the loader where the system prompt came from (it renders the
   * path in interactive `/context`). Ficus builds its prompt in memory rather
   * than reading an `AGENTS.md`-style file, so there is no source path.
   */
  getSystemPromptSource() {
    return undefined
  }

  getAppendSystemPrompt() {
    return []
  }

  /** No appended system prompts (see {@link getAppendSystemPrompt}), so no sources. */
  getAppendSystemPromptSources() {
    return []
  }

  getPathMetadata() {
    return new Map()
  }

  extendResources() {
    // noop
  }

  async reload() {
    this.loadSkills()
  }
}
