import { randomUUID } from 'node:crypto'
import { LifecycleLedger } from './node-conformance-lifecycle'

export interface OwnedResource {
  kind: string
  id: string
  dispose(signal: AbortSignal): Promise<void>
  assertGone(): Promise<void>
}

export interface ScenarioOperation {
  scenarioId: string
  operationId: string
  kind: string
  label: string
  targetId?: string
  complete(): void
}

export async function runBoundedScenarioTasks(
  tasks: Array<() => Promise<unknown>>,
  maxConcurrent: number
): Promise<void> {
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new Error('maxConcurrent must be a positive integer')
  }
  for (let offset = 0; offset < tasks.length; offset += maxConcurrent) {
    await Promise.all(tasks.slice(offset, offset + maxConcurrent).map((task) => task()))
  }
}

interface ScenarioScopeOptions {
  cleanupTimeoutMs?: number
}

export class ScenarioScope {
  readonly controller = new AbortController()
  readonly ledger = new LifecycleLedger()
  readonly namespace: string
  private resources: OwnedResource[] = []
  private readonly pendingOperations = new Set<Promise<void>>()
  private readonly cleanupTimeoutMs: number
  private disposing = false
  private disposal?: Promise<void>

  constructor(
    readonly id: string,
    options: ScenarioScopeOptions = {}
  ) {
    this.namespace = id
    this.cleanupTimeoutMs = options.cleanupTimeoutMs ?? 5_000
  }

  get signal(): AbortSignal {
    return this.controller.signal
  }

  private assertAcceptingRegistrations(): void {
    if (this.disposing) throw new Error(`scenario ${this.id} is already disposing`)
  }

  operation(kind: string, label: string, targetId?: string): ScenarioOperation {
    this.assertAcceptingRegistrations()
    const operationId = randomUUID()
    const release = this.ledger.registerOperation(operationId)
    let settle!: () => void
    const settlement = new Promise<void>((resolve) => (settle = resolve))
    this.pendingOperations.add(settlement)
    void settlement.then(() => this.pendingOperations.delete(settlement))
    let active = true
    const complete = () => {
      if (!active) return
      active = false
      release()
      settle()
    }
    return { scenarioId: this.id, operationId, kind, label, targetId, complete }
  }

  track<T>(operation: ScenarioOperation, promise: Promise<T>): Promise<T> {
    this.assertAcceptingRegistrations()
    return promise.finally(() => operation.complete())
  }

  own(resource: OwnedResource): void {
    this.assertAcceptingRegistrations()
    this.resources.push(resource)
  }

  async run<T>(body: (scope: ScenarioScope) => Promise<T>): Promise<T> {
    try {
      return await body(this)
    } catch (error) {
      try {
        await this.dispose()
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], `Scenario ${this.id} and its cleanup failed`, {
          cause: cleanupError,
        })
      }
      throw error
    }
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal
    this.disposing = true
    this.controller.abort(`scenario ${this.id} disposed`)
    const attempt = Promise.resolve().then(() => this.disposeOnce())
    this.disposal = attempt.catch((error) => {
      this.disposal = undefined
      throw error
    })
    return this.disposal
  }

  private async disposeOnce(): Promise<void> {
    const cleanupController = new AbortController()
    const cleanupTimer = setTimeout(
      () => cleanupController.abort(`scenario ${this.id} cleanup timed out`),
      this.cleanupTimeoutMs
    )
    const errors: unknown[] = []
    if (this.pendingOperations.size > 0) {
      const joined = await new Promise<boolean>((resolve) => {
        const onAbort = () => resolve(false)
        cleanupController.signal.addEventListener('abort', onAbort, { once: true })
        void Promise.all([...this.pendingOperations]).then(() => {
          cleanupController.signal.removeEventListener('abort', onAbort)
          resolve(true)
        })
      })
      if (!joined) {
        // Live operations may still hold SQLite writers or mutate captures.
        // Preserve every owned resource so a later retry can dispose it only
        // after those operations have settled.
        errors.push(new Error(`Scenario ${this.id} operations did not settle before cleanup timeout`))
        try {
          this.ledger.assertZero(this.id)
        } catch (error) {
          errors.push(error)
        }
        clearTimeout(cleanupTimer)
        throw new AggregateError(errors, `Scenario ${this.id} operations did not settle before cleanup timeout`)
      }
    }
    for (const resource of this.resources.reverse()) {
      try {
        await resource.dispose(cleanupController.signal)
      } catch (error) {
        errors.push(new Error(`Failed to dispose ${resource.kind}:${resource.id}`, { cause: error }))
      }
      try {
        await resource.assertGone()
      } catch (error) {
        errors.push(new Error(`Resource remains ${resource.kind}:${resource.id}`, { cause: error }))
      }
    }
    this.resources = []
    try {
      this.ledger.assertZero(this.id)
    } catch (error) {
      errors.push(error)
    }
    clearTimeout(cleanupTimer)
    if (errors.length > 0) throw new AggregateError(errors, `Scenario ${this.id} cleanup was incomplete`)
  }

  snapshot(): { resources: number; operations: number; aborted: boolean } {
    return {
      resources: this.resources.length,
      operations: this.ledger.snapshot().operations.length,
      aborted: this.signal.aborted,
    }
  }
}
