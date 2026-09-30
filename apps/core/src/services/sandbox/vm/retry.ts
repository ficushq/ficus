import { createHash } from 'crypto'
import { classifySandboxTransportError, SandboxTransportError } from '../client/http-client'

export type IdempotentSandboxOperation = 'read' | 'deterministic_overwrite' | 'health' | 'git_config' | 'cancel'

function deterministicJitter(key: string, ceiling: number): number {
  const value = createHash('sha256').update(key).digest().readUInt32BE(0)
  return value % (ceiling + 1)
}

/** Attempt delays; attempt zero always starts immediately. */
export function retryDelays(sandboxId: string, operationClass: IdempotentSandboxOperation, attempts = 3): number[] {
  const bases = [0, 200, 800]
  return Array.from({ length: Math.min(Math.max(attempts, 0), bases.length) }, (_, attempt) => {
    const base = bases[attempt]
    return base === 0
      ? 0
      : base + deterministicJitter(`${sandboxId}\0${operationClass}\0${attempt}`, Math.floor(base * 0.2))
  })
}

export async function runIdempotentSandboxOperation<Client, Result>(input: {
  sandboxId: string
  operationClass: IdempotentSandboxOperation
  getClient(): Client
  recoverClient(failedClient: Client, cause: Error): Promise<Client>
  operation(client: Client): Promise<Result>
  sleep?: (ms: number) => Promise<void>
}): Promise<Result> {
  const sleep = input.sleep ?? ((ms) => Bun.sleep(ms))
  const delays = retryDelays(input.sandboxId, input.operationClass, 3)
  let client = input.getClient()

  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (delays[attempt] > 0) await sleep(delays[attempt])
    try {
      return await input.operation(client)
    } catch (error) {
      const transport = error instanceof SandboxTransportError ? error : classifySandboxTransportError(error)
      if (!transport || attempt === delays.length - 1) throw error
      client = await input.recoverClient(client, transport)
    }
  }
  throw new Error('unreachable sandbox retry state')
}
