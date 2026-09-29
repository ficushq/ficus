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
} from '@earendil-works/pi-coding-agent'

import { createLogger } from '../../lib/infra/logger'
import type { PrecompactionController } from './precompaction/controller'
import { createPrecompactionExtension } from './precompaction/extension'
import { createShortTermMemoryContextExtension, type ShortTermMemoryContext } from './short-term-memory-context'

const log = createLogger('resource-loader')

/**
 * Pi agent session resource loader to customize system prompt and skills.
 */
export class FicusResourceLoader implements ResourceLoader {
  private skills: LoadSkillsResult | null = null
  private extensions: LoadExtensionsResult | null = null
  private precompactionController?: PrecompactionController
  private fitCompactionFallback?: (event: SessionBeforeCompactEvent) => Promise<CompactionResult | undefined>
  private shortTermMemoryContext?: ShortTermMemoryContext
  private readonly shortTermMemoryExtension = createShortTermMemoryContextExtension(() => this.shortTermMemoryContext)
  private readonly precompactionExtension: Extension = createPrecompactionExtension(
    () => this.precompactionController,
    () => this.fitCompactionFallback
  )

  constructor(
    private readonly systemPrompt: string,
    private readonly skillPaths?: string[],
    private readonly extensionPaths?: string[]
  ) {}

  static async create(
    systemPrompt: string,
    skillPaths?: string[],
    extensionPaths?: string[]
  ): Promise<FicusResourceLoader> {
    const loader = new FicusResourceLoader(systemPrompt, skillPaths, extensionPaths)
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
      if (this.extensions.errors.length > 0) {
        log.error(`Failed to load extensions:`, JSON.stringify(this.extensions.errors))
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
    return this.systemPrompt
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
