import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { db, sandboxExposureCleanup } from '../../../db'
import { eq } from 'drizzle-orm'

type Event = { role: string; pid: number; event: string; result?: string; error?: string }

function child(role: string, id: string, failure: boolean) {
  const process = Bun.spawn(
    [
      Bun.which('bun')!,
      join(import.meta.dir, 'fixtures/provision-flight-process.ts'),
      role,
      id,
      failure ? 'failure' : 'success',
    ],
    {
      env: { ...globalThis.process.env },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    }
  )
  const events: Event[] = []
  const listeners = new Map<string, () => void>()
  const output = (async () => {
    let buffer = ''
    for await (const chunk of process.stdout) {
      buffer += new TextDecoder().decode(chunk)
      for (;;) {
        const end = buffer.indexOf('\n')
        if (end < 0) break
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        if (!line.startsWith('{')) continue // VM manager informational logs
        const event = JSON.parse(line) as Event
        events.push(event)
        listeners.get(event.event)?.()
      }
    }
  })()
  const stderr = new Response(process.stderr).text()
  return {
    process,
    events,
    output,
    stderr,
    async waitFor(event: string) {
      if (events.some((e) => e.event === event)) return
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          new Promise<void>((resolve) => listeners.set(event, resolve)),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`${role} never emitted ${event}: ${JSON.stringify(events)}`)),
              5_000
            )
          }),
        ])
      } finally {
        clearTimeout(timer)
        listeners.delete(event)
      }
    },
    release() {
      process.stdin.write('release\n')
      process.stdin.flush()
    },
    async stop() {
      process.kill()
      await process.exited
      await output
      await stderr
    },
  }
}

for (const failure of [false, true]) {
  test(`separate API/worker processes share one ${failure ? 'failure' : 'success'} without a second provision`, async () => {
    const id = `process-flight-${crypto.randomUUID()}`
    const api = child('api', id, failure)
    let worker: ReturnType<typeof child> | undefined
    let other: ReturnType<typeof child> | undefined
    try {
      await api.waitFor('provision')
      worker = child('worker', id, failure)
      await worker.waitFor('waiting')
      // Different sandbox progresses even while this owner and waiter contend.
      other = child('worker-other-box', `${id}-other`, false)
      await other.waitFor('provision')
      other.release()
      expect(await other.process.exited).toBe(0)
      api.release()
      expect(await api.process.exited).toBe(0)
      expect(await worker.process.exited).toBe(0)
      await Promise.all([api.output, worker.output, other.output])
      expect(api.events[0]!.pid).not.toBe(worker.events[0]!.pid)
      expect([...api.events, ...worker.events].filter((e) => e.event === 'provision')).toHaveLength(1)
      if (failure) {
        expect(api.events.at(-1)!.event).toBe('failed')
        expect(worker.events.at(-1)!.event).toBe('failed')
        expect(worker.events.at(-1)!.error).toBe('VmProvisionFailedError')
        // A third independent process within backoff also must not provision.
        const retry = child('api-retry', id, true)
        try {
          expect(await retry.process.exited).toBe(0)
          await retry.output
          expect(retry.events.map((e) => e.event)).toEqual(['failed'])
        } finally {
          await retry.stop()
        }
      } else {
        expect(api.events.at(-1)!.result).toBe('owner-ready')
        expect(worker.events.at(-1)!.result).toBe('joined-ready')
        expect(worker.events.filter((e) => e.event === 'local-forward')).toHaveLength(1)
        const [ack] = await db
          .select()
          .from(sandboxExposureCleanup)
          .where(eq(sandboxExposureCleanup.targetId, `vm:${id}`))
        expect(ack!.status).toBe('done')
      }
      expect(await api.stderr).toBe('')
      expect(await worker.stderr).toBe('')
      console.log(
        `cross-process ${failure ? 'failure/backoff' : 'success'}: ${JSON.stringify([...api.events, ...worker.events, ...other.events].filter((e) => e.event !== 'waiting'))}`
      )
    } finally {
      await api.stop()
      await worker?.stop()
      await other?.stop()
    }
  }, 20_000)
}
