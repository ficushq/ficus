import { SquadEnvSecretSource } from './squad-env-secret-source'
import { getSecretStore, type SecretValueConsumer } from '../secrets/store'
import {
  ContentSafety,
  type ContentSafetyPort,
  type SecretEntry,
  type StoredKeyRedaction,
  type StoredValueFragmentEdges,
} from './content-safety'

export interface ContentSafetySecretSource {
  refreshContentSafety?(): void
  bindContentSafetyConsumer(consumer: SecretValueConsumer): () => void
}

export interface ContentSafetyOutputSource {
  /** Stable identity until output-only source entries change. */
  entries(): readonly SecretEntry[]
}

/** Keeps protected store entries and output-only configuration in one matcher. */
export class ContentSafetyRegistry implements ContentSafetyPort {
  #entries: readonly SecretEntry[] = []
  #safety = ContentSafety.fromSecretEntries([])
  #unsubscribe: () => void
  #outputEntries: readonly SecretEntry[] = []

  constructor(
    private readonly store: ContentSafetySecretSource,
    private readonly outputSource?: ContentSafetyOutputSource
  ) {
    const consumer: SecretValueConsumer = {
      replace: (entries) => {
        this.#entries = [...entries]
        this.#rebuild()
      },
      update: (key, value) => {
        const nextEntries = this.#entries.filter((entry) => entry.key !== key)
        if (value !== undefined) nextEntries.push({ key, value })
        this.#entries = nextEntries
        this.#rebuild()
      },
    }
    this.#unsubscribe = store.bindContentSafetyConsumer(consumer)
  }

  redact<T>(input: T): T {
    this.#refreshOutput()
    return this.#safety.redact(input)
  }

  redactWithStoredKeys<T>(input: T): StoredKeyRedaction<T> {
    this.#refreshOutput()
    return this.#safety.redactWithStoredKeys(input)
  }

  trimStoredValueFragments(text: string, edges: StoredValueFragmentEdges): string {
    this.#refreshOutput()
    return this.#safety.trimStoredValueFragments(text, edges)
  }

  #rebuild(): void {
    this.#safety = ContentSafety.fromSecretEntries([
      ...this.#entries,
      ...this.#outputEntries.map((entry) => ({ ...entry, outputOnly: true })),
    ])
  }

  #refreshOutput(): void {
    this.store.refreshContentSafety?.()
    const entries = this.outputSource?.entries()
    if (entries && entries !== this.#outputEntries) {
      this.#outputEntries = entries
      this.#rebuild()
    }
  }

  dispose(): void {
    this.#unsubscribe()
    this.#entries = []
    this.#outputEntries = []
    this.#safety = ContentSafety.fromSecretEntries([])
  }
}

let processRegistry: ContentSafetyRegistry | undefined
let processRegistrySource: ContentSafetySecretSource | undefined

/** Process-wide matcher shared by the tool-output and log boundaries. */
export function getContentSafetyRegistry(): ContentSafetyRegistry {
  const source = getSecretStore()
  if (!processRegistry || processRegistrySource !== source) {
    processRegistry?.dispose()
    processRegistry = new ContentSafetyRegistry(source, new SquadEnvSecretSource())
    processRegistrySource = source
  }
  return processRegistry
}

/** Test-only reset for suites that replace the SecretStore singleton. */
export function resetContentSafetyRegistry(): void {
  processRegistry?.dispose()
  processRegistry = undefined
  processRegistrySource = undefined
}
