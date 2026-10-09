import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acceptCandidate, dismissCandidate } from './inbox'
import { discoverEvals } from './run'
import { Hono } from 'hono'
import { db, decisionEvalCandidates } from '../../../db'
import { identityMiddleware } from '../../../middleware/identity'
import decisionsRouter from '../../../routes/decisions'
import { getSettingsStore } from '../../settings'
import { authHeaders, cleanupTestRbac, createTestAdmin, type TestUser } from '../../../test-utils'
import {
  captureCorrection,
  DECISION_EVAL_CAPTURE_KEY,
  evalCaptureState,
  isEvalCaptureEnabled,
  listCandidates,
  MAX_DECISION_EVAL_CANDIDATES,
  setCandidateStatus,
  setEvalCapture,
} from './capture'

const prefix = `eval-capture-${randomUUID()}`
const app = new Hono().use('*', identityMiddleware).route('/api/decisions', decisionsRouter)
let admin: TestUser

beforeAll(async () => {
  admin = await createTestAdmin({ prefix })
})
afterEach(async () => {
  delete process.env.FICUS_MANAGED
  await getSettingsStore().set(DECISION_EVAL_CAPTURE_KEY, 'false', 'test')
  await db.delete(decisionEvalCandidates)
})
afterAll(async () => {
  await cleanupTestRbac(prefix)
})

const capture = (summary = '"how\'s it going" → Interrupt') =>
  captureCorrection({
    evalName: 'composer-delivery',
    purpose: 'composer-delivery',
    build: async () => ({
      request: { state: { draft: "how's it going" }, questions: { now: { type: 'yesno', instructions: 'Now?' } } },
    }),
    expect: 'steer',
    summary,
    source: { kind: 'composer-override' },
  })

test('off by default: nothing is built or saved', async () => {
  expect(isEvalCaptureEnabled()).toBe(false)
  let built = false
  await captureCorrection({
    evalName: 'composer-delivery',
    purpose: 'composer-delivery',
    build: async () => {
      built = true
      return null
    },
    expect: 'steer',
    summary: 'x',
  })
  expect(built).toBe(false)
  expect(await listCandidates()).toEqual([])
})

test('when turned on, a correction is saved as a candidate with what the user chose', async () => {
  await setEvalCapture(true, 'test')
  await capture()
  const [candidate] = await listCandidates()
  expect(candidate).toMatchObject({
    evalName: 'composer-delivery',
    purpose: 'composer-delivery',
    expected: { expect: 'steer' },
    summary: '"how\'s it going" → Interrupt',
    source: { kind: 'composer-override' },
    status: 'new',
  })
  expect((await evalCaptureState()).pending).toBe(1)
  await setCandidateStatus(candidate!.id, 'dismissed')
  expect(await listCandidates()).toEqual([])
})

test('hosted instances never save corrections, and cannot turn it on', async () => {
  await setEvalCapture(true, 'test')
  process.env.FICUS_MANAGED = '1'
  await capture()
  expect(await listCandidates()).toEqual([])
  await expect(setEvalCapture(true, 'test')).rejects.toThrow('not available on hosted instances')
  expect(await evalCaptureState()).toEqual({ available: false, enabled: false, pending: 0 })
})

test('only the newest candidates are kept', async () => {
  await setEvalCapture(true, 'test')
  await db.insert(decisionEvalCandidates).values(
    Array.from({ length: MAX_DECISION_EVAL_CANDIDATES }, (_, index) => ({
      evalName: 'composer-delivery',
      purpose: 'composer-delivery',
      request: { state: 'old', questions: {} },
      expected: { expect: 'steer' },
      summary: `old ${index}`,
      createdAt: new Date(Date.now() - 60_000 - index),
    }))
  )
  await capture('newest')
  const kept = await listCandidates()
  expect(kept).toHaveLength(MAX_DECISION_EVAL_CANDIDATES)
  expect(kept[0]!.summary).toBe('newest')
  expect(kept.some((candidate) => candidate.summary === `old ${MAX_DECISION_EVAL_CANDIDATES - 1}`)).toBe(false)
})

test('Settings shows the switch and changes it; hosted instances get a 403', async () => {
  const put = (enabled: unknown) =>
    app.request('/api/decisions/eval-capture', {
      method: 'PUT',
      headers: { ...authHeaders(admin.token), 'content-type': 'application/json' },
      body: JSON.stringify({ enabled }),
    })
  const settings = async () =>
    (
      (await (await app.request('/api/decisions', { headers: authHeaders(admin.token) })).json()) as {
        evalCapture: unknown
      }
    ).evalCapture
  expect(await settings()).toEqual({ available: true, enabled: false, pending: 0 })
  expect(await (await put(true)).json()).toEqual({ available: true, enabled: true, pending: 0 })
  expect(await settings()).toEqual({ available: true, enabled: true, pending: 0 })
  expect((await put('yes')).status).toBe(400)
  process.env.FICUS_MANAGED = '1'
  expect((await put(true)).status).toBe(403)
})

test("accepting a candidate adds it to the eval's local (gitignored) cases, which the eval then runs", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'decision-inbox-'))
  try {
    writeFileSync(
      join(dir, 'composer.decision-eval.ts'),
      `import { defineDecisionEval } from ${JSON.stringify(join(import.meta.dir, 'define.ts'))}
export default defineDecisionEval({
  name: 'composer-delivery', purpose: 'composer-delivery',
  build: ({ draft }) => ({ request: { state: { draft }, questions: {} } }),
  decide: () => 'steer', caseName: ({ draft }) => draft,
  cases: [{ draft: 'defined', expect: 'steer' }],
})\n`
    )
    await setEvalCapture(true, 'test')
    await capture()
    await capture('dismiss me')
    const [dismissMe, keep] = await listCandidates()
    const log = console.log
    console.log = () => {}
    try {
      await dismissCandidate(dismissMe!.id.slice(0, 8))
      await acceptCandidate(keep!.id.slice(0, 8), await discoverEvals(dir), { name: 'status check' })
    } finally {
      console.log = log
    }
    const local = join(dir, 'composer.decision-cases.local.json')
    expect(existsSync(join(dir, 'composer.decision-cases.json'))).toBe(false)
    const saved = JSON.parse(readFileSync(local, 'utf8')) as { cases: Array<Record<string, unknown>> }
    expect(saved.cases).toEqual([
      expect.objectContaining({ name: 'status check', expect: 'steer', request: keep!.request }),
    ])
    expect(await listCandidates()).toEqual([])
    const [loaded] = await discoverEvals(dir)
    expect(loaded!.evaluation.cases.map((c) => c.name ?? 'defined')).toEqual(['defined', 'status check'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
