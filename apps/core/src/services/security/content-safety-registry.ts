import { getSecretStore, type SecretValueConsumer } from '../secrets/store'
import {
  ContentSafety,
  type ContentSafetyPort,
  type StoredKeyRedaction,
  type StoredValueFragmentEdges,
} from './content-safety'

export interface ContentSafetySecretSource {
  bindContentSafetyConsumer(consumer: SecretValueConsumer): () => void
}

/**
 * Keeps the exact-value matcher synchronized with Secret Store without exposing
 * a raw snapshot outside the redaction API.
 */
export class ContentSafetyRegistry implements ContentSafetyPort {
  #entries = new Map<string, string>()
  #safety = ContentSafety.fromSecretEntries([])
  #unsubscribe: () => void

  constructor(store: ContentSafetySecretSource) {
    const consumer: SecretValueConsumer = {
      replace: (entries) => {
        this.#entries = new Map(entries.map(({ key, value }) => [key, value]))
        this.#safety = ContentSafety.fromSecretEntries(entries)
      },
      update: (key, value) => {
        const nextEntries = new Map(this.#entries)
        if (value === undefined) nextEntries.delete(key)
        else nextEntries.set(key, value)
        this.#entries = nextEntries
        this.#safety = ContentSafety.fromSecretEntries(
          Array.from(nextEntries, ([entryKey, entryValue]) => ({ key: entryKey, value: entryValue }))
        )
      },
    }
    this.#unsubscribe = store.bindContentSafetyConsumer(consumer)
  }

  redact<T>(input: T): T {
    return this.#safety.redact(input)
  }

  redactWithStoredKeys<T>(input: T): StoredKeyRedaction<T> {
    return this.#safety.redactWithStoredKeys(input)
  }

  trimStoredValueFragments(text: string, edges: StoredValueFragmentEdges): string {
    return this.#safety.trimStoredValueFragments(text, edges)
  }

  dispose(): void {
    this.#unsubscribe()
    this.#entries.clear()
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
    processRegistry = new ContentSafetyRegistry(source)
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
