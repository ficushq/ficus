import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { db, sandboxExposureCleanup, vmBoxProvisionAttempts, machines, machineBoxes } from '../../../db'
import { eq } from 'drizzle-orm'

type Event = {
  role: string
  pid: number
  event: string
  result?: string
  error?: string
  code?: string | null
  at?: number
}

function child(
  role: string,
  id: string,
  failure: boolean | 'fresh' | 'setup-failure',
  fixture = 'provision-flight-process.ts'
) {
  const process = Bun.spawn(
    [
      Bun.which('bun')!,
      join(import.meta.dir, 'fixtures', fixture),
      role,
      id,
      typeof failure === 'string' ? failure : failure ? 'failure' : 'success',
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
    shutdown() {
      process.stdin.write('shutdown\n')
      process.stdin.flush()
    },
    releaseSetup() {
      process.stdin.write('release-setup\n')
      process.stdin.flush()
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

test('two fresh-box processes publish success only after owner setup, then admit follower Bash', async () => {
  const id = `process-fresh-${crypto.randomUUID()}`
  const machineId = crypto.randomUUID()
  await db.insert(machines).values({
    id: machineId,
    name: machineId,
    provider: 'ssh',
    status: 'ready',
    sshHost: '127.0.0.1',
    sshUser: 'ficus',
    sshKeyId: 'test',
    sshPublicKey: 'test',
  })
  await db.insert(machineBoxes).values({ sandboxId: id, machineId, unixUser: 'test', port: 45000 })
  const api = child('api', id, 'fresh')
  let worker: ReturnType<typeof child> | undefined
  try {
    await api.waitFor('provision')
    worker = child('worker', id, 'fresh')
    await worker.waitFor('waiting')
    api.release()
    await api.waitFor('setup')
    const [generation] = await db.select().from(vmBoxProvisionAttempts).where(eq(vmBoxProvisionAttempts.sandboxId, id))
    expect(generation!.status).toBe('running')
    expect(worker.events.some((event) => event.event === 'first-bash')).toBe(false)
    api.releaseSetup()
    expect(await api.process.exited).toBe(0)
    expect(await worker.process.exited).toBe(0)
    await Promise.all([api.output, worker.output])
    expect([...api.events, ...worker.events].filter((event) => event.event === 'failed')).toEqual([])
    expect(worker.events.filter((event) => event.event === 'assets' || event.event === 'setup')).toEqual([])
    const setup = api.events.find((event) => event.event === 'setup-complete')!
    const bash = worker.events.find((event) => event.event === 'first-bash')!
    expect(bash.at!).toBeGreaterThanOrEqual(setup.at!)
    expect(worker.events.at(-1)!.result).toBe('joined-ready')
  } finally {
    api.releaseSetup()
    await api.stop()
    await worker?.stop()
    await db.delete(machines).where(eq(machines.id, machineId))
  }
}, 20_000)

test('clean owner shutdown lets a different process provision immediately without cooldown', async () => {
  const id = `process-shutdown-${crypto.randomUUID()}`
  const api = child('api', id, false)
  let worker: ReturnType<typeof child> | undefined
  try {
    await api.waitFor('provision')
    worker = child('worker-replacement', id, false)
    await worker.waitFor('waiting')
    api.shutdown()
    await api.waitFor('interrupted')
    // waitFor has a five-second bound: the old 30-second cooldown cannot pass.
    await worker.waitFor('provision')
    const rows = await db.select().from(vmBoxProvisionAttempts).where(eq(vmBoxProvisionAttempts.sandboxId, id))
    const interrupted = rows.find((row) => row.failureClass === 'interrupted')!
    expect(interrupted.retryAt!.getTime()).toBe(interrupted.completedAt!.getTime())
    expect(interrupted.failureCount).toBe(0)
    worker.release()
    expect(await api.process.exited).toBe(0)
    expect(await worker.process.exited).toBe(0)
    await worker.output
    expect(worker.events.at(-1)!.result).toBe('owner-ready')
  } finally {
    await api.stop()
    await worker?.stop()
  }
}, 20_000)

for (const mode of ['resume', 'resume-ensure']) {
  test(`preempt-stop and immediate ${mode} in two processes never provision before authoritative stop verification`, async () => {
    const id = `agent_stop_resume_${crypto.randomUUID()}`
    const machineId = crypto.randomUUID()
    await db.insert(machines).values({
      id: machineId,
      name: machineId,
      provider: 'ssh',
      status: 'ready',
      sshHost: '127.0.0.1',
      sshUser: 'ficus',
      sshKeyId: 'test',
      sshPublicKey: 'test',
    })
    await db
      .insert(machineBoxes)
      .values({ sandboxId: id, machineId, unixUser: 'test', port: 45000, status: 'ready', authToken: 'synthetic' })
    const preempt = child('preempt', id, false, 'stop-resume-process.ts')
    let resume: ReturnType<typeof child> | undefined
    try {
      await preempt.waitFor('stop-proof')
      resume = child(mode, id, false, 'stop-resume-process.ts')
      await resume.waitFor('waiting')
      expect(resume.events.some((event) => event.event === 'provision')).toBe(false)
      preempt.release()
      await resume.waitFor('startup-retry')
      const [unverified] = await db.select().from(machineBoxes).where(eq(machineBoxes.sandboxId, id))
      expect(unverified!.status).toBe('stop_unverified')
      expect(resume.events.some((event) => event.event === 'provision')).toBe(false)
      // Retry invokes the real stop/readback path; it never clears a DB marker.
      // Plain ensure owns a failed physical generation. Honor its first real
      // 30-second retry schedule; never clear the stop proof or cooldown row.
      if (mode === 'resume-ensure') await Bun.sleep(30_100)
      resume.releaseSetup()
      expect(await preempt.process.exited).toBe(0)
      expect(await resume.process.exited).toBe(0)
      await resume.output
      expect(resume.events.filter((event) => event.event === 'stop-proof')).toHaveLength(2)
      expect(resume.events.filter((event) => event.event === 'provision')).toHaveLength(1)
      expect(resume.events.at(-1)!.result).toBe('resumed')
    } finally {
      await preempt.stop()
      await resume?.stop()
      await db.delete(machines).where(eq(machines.id, machineId))
    }
  }, 60_000)
}

test('a second process five seconds after a non-allowlisted owner setup failure still receives startup retry', async () => {
  const id = `agent_setup_failure_${crypto.randomUUID()}`
  const owner = child('owner', id, 'setup-failure')
  let follower: ReturnType<typeof child> | undefined
  try {
    await owner.waitFor('provision')
    owner.release()
    await owner.process.exited
    await owner.output
    expect(owner.events.at(-1)!.code).toBe('sandbox_readiness_pending')
    const [failed] = await db.select().from(vmBoxProvisionAttempts).where(eq(vmBoxProvisionAttempts.sandboxId, id))
    expect(failed!.failureCount).toBe(0)
    expect(failed!.retryAt!.getTime()).toBeLessThanOrEqual(Date.now())
    await Bun.sleep(5_000)
    follower = child('follower', id, 'setup-failure')
    await follower.waitFor('provision')
    follower.release()
    await follower.process.exited
    await follower.output
    expect(follower.events.at(-1)!.code).toBe('sandbox_readiness_pending')
  } finally {
    await owner.stop()
    await follower?.stop()
  }
}, 20_000)

test('a new process recovers an abandoned generation without spending any startup retry', async () => {
  const id = `agent_abandoned_${crypto.randomUUID()}`
  await db.insert(vmBoxProvisionAttempts).values({ sandboxId: id, failureCount: 8 })
  const replacement = child('replacement', id, false)
  try {
    await replacement.waitFor('provision')
    replacement.release()
    expect(await replacement.process.exited).toBe(0)
    await replacement.output
    expect(replacement.events.at(-1)!.result).toBe('owner-ready')
    const rows = await db.select().from(vmBoxProvisionAttempts).where(eq(vmBoxProvisionAttempts.sandboxId, id))
    expect(rows.find((row) => row.failureClass === 'abandoned')!.failureCount).toBe(0)
    expect(rows.filter((row) => row.status === 'succeeded')).toHaveLength(1)
  } finally {
    await replacement.stop()
  }
}, 20_000)
