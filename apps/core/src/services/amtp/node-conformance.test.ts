// tau <-> amtp-node conformance matrix (spec docs/superpowers/specs/
// 2026-07-08-amtp-node-design.md §10). Spawns a REAL `amtp` node subprocess
// (the installed amtp-node npm package) against a temp AMTP_HOME and drives it
// as a black box through its `--json` CLI output, alongside a real
// in-process tau Hono app served over `Bun.serve`. Both hosts talk over real
// HTTP — this file never touches `__setPullImpl`/`__setKeyFetchImpl`; TOFU
// key fetches and attachment pulls go over the wire exactly as they would in
// production, in both directions.
//
// §10.3's row 11 ("golden vectors") is explicitly NOT a matrix test (it's the
// spec-vectors suite that now ships inside the amtp-protocol package — both
// hosts already share the identical amtp-protocol canonical-signing code that
// suite pins down) — nothing for row 11 lives in this file.
import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'

// File-scoped default covering hooks AND tests. Deliberately NOT the two-arg
// beforeAll(fn, ms) form: that is bun >= 1.3 only and crashes the whole file
// at load time on bun 1.2.x (setDefaultTimeout works on both; CI pins 1.3.8).
//
// Budget arithmetic (CI flake, runs 30947168870/30952651592): this ceiling
// MUST exceed the worst-case sum of the per-call ceilings inside one test
// (up to ~6 CLI invocations x CLI_TIMEOUT_MS, plus postgres round-trips). On
// a degraded runner every `bun run` spawn can crawl to several seconds; with
// a 35s test budget the OUTER timeout fired before any per-call ceiling, and
// bun's on-timeout zombie killer SIGTERMed every tracked subprocess —
// including the long-lived `amtp serve` process — cascading the failure into
// every later test. Keeping this generously above 6 x CLI_TIMEOUT_MS means a
// stall always surfaces as a per-call error (with stderr tail) instead.
setDefaultTimeout(180_000)
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { eq, inArray, like } from 'drizzle-orm'
import { Hono } from 'hono'
import {
  canonicalAgentSigBytes,
  canonicalPeerGetString,
  formatAmtpAddress,
  generateInstanceKeyPair,
  instanceIdFromPublicKeyPem,
  signAgentCard,
  signEnvelope,
} from 'amtp-protocol'
import type { AmtpAttachmentRef, AmtpEnvelope, AmtpSignedAgentCard } from 'amtp-protocol'
import {
  agentTypes,
  agents,
  amtpKnownKeys,
  amtpReceived,
  db,
  inbox,
  inboxAttachments,
  outbox,
  peers,
  users,
} from '../../db'
import { identityMiddleware } from '../../middleware/identity'
import { authzSentinel } from '../../middleware/authz-sentinel'
import { amtpRouter } from '../../routes/amtp'
import { Agent } from '../../entities/Agent'
import { AgentType } from '../../entities/AgentType'
import { AmtpAllowRule } from '../../entities/AmtpAllowRule'
import { AmtpKnownKey } from '../../entities/AmtpKnownKey'
import { InboxAttachment } from '../../entities/InboxAttachment'
import { InstanceIdentity } from '../../entities/InstanceIdentity'
import { Peer } from '../../entities/Peer'
import { agentIdentityHostPath, ensureAgentIdentity } from './agent-identity'
import { getSettingsStore } from '../settings'
import { readAttachmentFile } from '../inbox/attachment-storage'
import { assignRole, authHeaders, cleanupTestRbac, createTestRole, createTestUser } from '../../test-utils'
import { amtpEngine } from './engine'
import { enqueueFederatedSend } from './send'
import { drainOutboxOnce } from './outbox-delivery'
import {
  pollTestNodeOutboxDelivery,
  pollTestNodeOutboxFailure,
  type TestNodeOutboxRow,
} from './node-conformance-outbox-poller'
import { readNodeOutboxEnvelope, uploadNodeAttachment } from './node-conformance-attachment-upload'
import { amtpNodeCommand } from './node-conformance-command'
import {
  amtpConformancePhases,
  buildAmtpConformanceEntrypoint,
  cleanupFileCapturedChild,
  type BuiltAmtpConformanceEntrypoint,
  type FileCapturedChild,
  type FileCapturedProcessResult,
  readFileCapturedChildTails,
  runBoundedCleanupPhases,
  runFileCapturedProcess,
  spawnFileCapturedChild,
  stripAmtpConformancePhases,
  waitForCapturedJsonLine,
} from './node-conformance-process'
import { fetchInProtocolPhase, waitForProtocolReady } from './node-conformance-readiness'
import { establishNodeMailbox, inspectNodeRegistration } from './node-conformance-registration'
import { runScopedCliProcess } from './node-conformance-cli'
import { openNodeConformanceDb } from './node-conformance-sqlite'
import {
  isCompleteWhoamiJson,
  runAuditedWhoami,
  type WhoamiCustodySnapshot,
  type WhoamiReadSet,
  type WhoamiResult,
} from './node-conformance-whoami'
import { runBoundedScenarioTasks, ScenarioScope } from './node-conformance-scenario'
import { terminateProcess } from './subprocess-lifecycle'

// amtp-node's `main` is src/index.ts and its published files include src/,
// so this resolves to the installed entrypoint used with the exact Bun executable.
const NODE_SOURCE_ENTRY = Bun.resolveSync('amtp-node', import.meta.dir)
let NODE_ENTRY = ''

// Per-call ceilings. Generous because a loaded CI runner can take seconds
// just to spawn + transpile the CLI; each call is still condition-based
// (awaits real process exit / the listening line) and fails with captured
// stderr when its ceiling is hit. See the setDefaultTimeout note above for
// why the file-level test timeout must stay well above 6 x CLI_TIMEOUT_MS.
const STARTUP_TIMEOUT_MS = 30_000
const CLI_TIMEOUT_MS = 20_000
const CLEANUP_PHASE_TIMEOUT_MS = 5_000
// amtp-engine permits an attachment delivery POST to run for 60s. The
// long-lived server drains every 5s, so terminal-state polling must cover one
// full attachment attempt plus one drain interval without tying that work to a
// short-lived CLI process. A permanently broken CLI can therefore consume the
// full ~70s deadline: transient query failures must not mask a healthy, slow
// attachment delivery, while bounded last-error/server diagnostics explain the timeout.
const ATTACHMENT_DELIVERY_TIMEOUT_MS = 70_000
// The server drains every 5s, so sub-second observation remains responsive while
// avoiding the process churn caused by spawning a fresh CLI every 100ms.
const OUTBOX_POLL_INTERVAL_MS = 750
const prefix = `node-conf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

// ---------------------------------------------------------------------------
// tau side: the same Hono app the frozen route tests build (§10.2), served
// for real over Bun.serve so the node's HTTP client hits it exactly like any
// other peer.
// ---------------------------------------------------------------------------
const app = new Hono()
app.use('/api/*', identityMiddleware)
app.use('/api/*', authzSentinel)
app.route('/api/amtp', amtpRouter)

let ficusServer: ReturnType<typeof Bun.serve> | null = null
let ficusPort: number
let ficusInstanceId: string
let ficusPublicKeyPem: string

// ---------------------------------------------------------------------------
// Node side: a real subprocess against a temp AMTP_HOME (§10.2).
// ---------------------------------------------------------------------------
let nodeHome: string | null = null
let cliCaptureDir: string | null = null
let nodeArtifactDir: string | null = null
let builtNodeEntrypoint: BuiltAmtpConformanceEntrypoint | null = null
let nodeProc: Bun.Subprocess | null = null
let nodeCapture: FileCapturedChild | null = null
let nodePort: number
let nodeInstanceId: string
let nodePublicKeyPem: string

let filesDir: string | null = null // scratch dir for attachment source files passed to `amtp attach upload`
let homeDir: string | null = null // tau's HOME_DIR for InboxAttachment file storage
const origHomeDir = process.env.HOME_DIR

let sharedAgentTypeId: string
const createdAgentIds: string[] = []
let activeScenarioScope: ScenarioScope | undefined

// ---------------------------------------------------------------------------
// Node CLI harness — treats the node as a black box (§10.2).
// ---------------------------------------------------------------------------

async function runCli(
  args: string[],
  timeoutMs = CLI_TIMEOUT_MS,
  signal?: AbortSignal,
  conformanceOperationId?: string,
  entrypointReady?: (stdout: string, stderr: string) => boolean,
  terminalOutput?: (stdout: string, stderr: string) => boolean
): Promise<
  FileCapturedProcessResult & { command: readonly string[]; capturePaths: readonly [string, string] } & {
    conformancePhases: Array<{ operation: string; phase: string }>
  }
> {
  if (!nodeHome) throw new Error('AMTP node home is not initialized')
  if (!cliCaptureDir) throw new Error('AMTP CLI capture directory is not initialized')
  if (!builtNodeEntrypoint) throw new Error('AMTP built entrypoint is not initialized')
  const initializedNodeHome = nodeHome
  const initializedCliCaptureDir = cliCaptureDir
  const scope = activeScenarioScope
  const operation = scope?.operation('cli', `amtp-cli:${args[0] ?? 'unknown'}`)
  const traceOperationId = conformanceOperationId ?? operation?.operationId ?? randomUUID()
  const result = await runScopedCliProcess({
    scope,
    operation,
    signal,
    run: (effectiveSignal) =>
      runFileCapturedProcess(
        amtpNodeCommand(process.execPath, NODE_ENTRY, ['--home', initializedNodeHome, '--json', ...args]),
        {
          phase: `amtp-cli:${args.join(' ')}`,
          timeoutMs,
          captureDir: initializedCliCaptureDir,
          signal: effectiveSignal,
          env: { AMTP_CONFORMANCE_OPERATION_ID: traceOperationId },
          entrypointReady,
          terminalOutput,
          diagnostics: async ({ stderr }) => {
            const serve = nodeCapture ? await capturedNodeDiagnostics(nodeCapture) : 'node serve unavailable'
            const phases = amtpConformancePhases(stderr, traceOperationId)
            return (
              `scenario=${scope?.id ?? 'unscoped'} operation=${operation?.operationId ?? 'unscoped'} ` +
              `cli=${args.slice(0, 2).join(':') || 'unknown'} phases=${JSON.stringify(phases)}; ${serve}`
            )
          },
        }
      ),
  })
  if (!result.command || !result.capturePaths) throw new Error('amtp-cli:missing-process-ownership')
  return {
    ...result,
    command: result.command,
    capturePaths: result.capturePaths,
    stderr: stripAmtpConformancePhases(result.stderr, traceOperationId),
    conformancePhases: amtpConformancePhases(result.stderr, traceOperationId),
  }
}

async function snapshotWhoamiCustody(): Promise<WhoamiCustodySnapshot> {
  if (!nodeHome || !nodeProc || !builtNodeEntrypoint) throw new Error('whoami-custody:fixture-not-ready')
  if (nodeProc.exitCode !== null || nodeProc.signalCode !== null) throw new Error('whoami-custody:service-not-live')
  const sqlite = openNodeConformanceDb(nodeHome, { readonly: true })
  let readSet: WhoamiReadSet
  try {
    const identity = sqlite
      .query<
        { instance_id: string; public_key_pem: string },
        []
      >('SELECT instance_id, public_key_pem FROM identity WHERE id = 1')
      .get()
    if (!identity) throw new Error('whoami-custody:identity-missing')
    const registrations = sqlite
      .query<
        { handle: string; inbound_open: 0 | 1; agent_public_key_pem: string; card_json: string | null },
        []
      >('SELECT handle, inbound_open, agent_public_key_pem, card_json FROM registrations ORDER BY handle')
      .all()
    readSet = {
      identity: { instanceId: identity.instance_id, publicKeyPem: identity.public_key_pem },
      registrations: registrations.map((row) => ({
        handle: row.handle,
        inboundOpen: row.inbound_open,
        agentPublicKeyPem: row.agent_public_key_pem,
        cardJson: row.card_json,
      })),
    }
  } finally {
    sqlite.close()
  }
  const artifact = await lstat(builtNodeEntrypoint.path)
  if (!artifact.isFile()) throw new Error('whoami-custody:entrypoint-artifact')
  const sha256 = createHash('sha256')
    .update(await readFile(builtNodeEntrypoint.path))
    .digest('hex')
  if (sha256 !== builtNodeEntrypoint.sha256) throw new Error('whoami-custody:entrypoint-hash')
  if ((await readdir(nodeArtifactDir!)).join(',') !== 'amtp-node-conformance.mjs')
    throw new Error('whoami-custody:entrypoint-artifacts')
  return {
    readSet,
    // whoami owns no persistent source files; its exact invocation captures
    // are checked separately from concurrently shared fixture directories.
    operationFiles: [],
    service: {
      pid: nodeProc.pid,
      port: nodePort,
      instanceId: nodeInstanceId,
      publicKeyPem: nodePublicKeyPem,
      exitCode: null,
      signalCode: null,
    },
    entrypoint: {
      sourcePath: builtNodeEntrypoint.sourcePath,
      path: builtNodeEntrypoint.path,
      sha256,
    },
  }
}

async function auditedWhoami(
  handle: string,
  options?: { registrationScope?: (handle: string) => boolean }
): Promise<WhoamiResult> {
  if (!nodeHome || !nodeCapture || !builtNodeEntrypoint) throw new Error('whoami-custody:fixture-not-ready')
  const initializedNodeHome = nodeHome
  const initializedEntrypoint = builtNodeEntrypoint
  return runAuditedWhoami(
    {
      handle,
      timeoutMs: CLI_TIMEOUT_MS,
      expectedCommand: amtpNodeCommand(process.execPath, initializedEntrypoint.path, [
        '--home',
        initializedNodeHome,
        '--json',
        'whoami',
      ]),
      registrationScope: options?.registrationScope,
    },
    {
      now: Date.now,
      operationId: randomUUID,
      sleep: Bun.sleep,
      snapshotBefore: () => snapshotWhoamiCustody(),
      run: ({ operationId, timeoutMs }) =>
        runCli(
          ['whoami'],
          timeoutMs,
          undefined,
          operationId,
          (_stdout, stderr) =>
            amtpConformancePhases(stderr, operationId).some(
              ({ operation, phase }) => operation === 'entrypoint' && phase === 'module-loaded'
            ),
          (stdout) => isCompleteWhoamiJson(stdout, handle)
        ),
      assertCapturePathsGone: async (paths) => {
        for (const path of paths) {
          try {
            await lstat(path)
            throw new Error('whoami-custody:captures')
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          }
        }
      },
      snapshotAfter: () => snapshotWhoamiCustody(),
      assertServiceReady: ({ remainingMs }) => waitForNodeReady(nodeCapture!, nodePort, remainingMs),
    }
  )
}

async function cli<T = unknown>(args: string[], timeoutMs = CLI_TIMEOUT_MS, signal?: AbortSignal): Promise<T> {
  const { stdout, stderr, exitCode } = await runCli(args, timeoutMs, signal)
  if (exitCode !== 0) {
    throw new Error(`amtp ${args.join(' ')} failed (exit ${exitCode}): ${stderr || stdout}`)
  }
  return JSON.parse(stdout) as T
}

interface NodeRegisterResult {
  handle: string
  address: string
  agentPublicKeyPem: string
  inboundOpen: boolean
}

async function registerNodeHandle(handle: string, opts: { open: boolean }): Promise<NodeRegisterResult> {
  const args = ['register', handle]
  if (opts.open) args.push('--open')
  return establishNodeMailbox({ handle, inboundOpen: opts.open }, CLI_TIMEOUT_MS, {
    now: Date.now,
    operationId: randomUUID,
    runRegister: async ({ operationId, timeoutMs }) => {
      const { stdout, stderr, exitCode } = await runCli(args, timeoutMs, undefined, operationId)
      if (exitCode !== 0) {
        throw new Error(`amtp ${args.join(' ')} failed (exit ${exitCode}): ${stderr || stdout}`)
      }
      return JSON.parse(stdout) as NodeRegisterResult
    },
    inspectRegistration: () => inspectNodeRegistration(nodeHome!, handle),
    waitForServerKey: async ({ registration, timeoutMs }) => {
      await waitForProtocolReady({
        phase: 'node-mailbox-ready',
        timeoutMs,
        probes: [
          {
            url: `http://127.0.0.1:${nodePort}/amtp/agents/${encodeURIComponent(handle)}/key`,
            validate: async (response) => {
              const payload = (await response.json()) as {
                handle?: unknown
                instanceId?: unknown
                identityPublicKey?: unknown
              }
              return {
                valid:
                  payload.handle === handle &&
                  payload.instanceId === nodeInstanceId &&
                  payload.identityPublicKey === registration.agentPublicKeyPem,
                detail:
                  `handleMatches=${payload.handle === handle} instanceMatches=${payload.instanceId === nodeInstanceId} ` +
                  `publicKeyMatches=${payload.identityPublicKey === registration.agentPublicKeyPem}`,
              }
            },
          },
        ],
        diagnostics: () => (nodeCapture ? capturedNodeDiagnostics(nodeCapture) : 'node serve unavailable'),
        isDead: () => !nodeProc || nodeProc.exitCode !== null || nodeProc.signalCode !== null,
      })
    },
  })
}

interface NodeSendResult {
  outboxId: string
  envelopeId: string
  status: 'delivered' | 'pending' | 'delivering' | 'failed'
  nextAttemptAt?: number
  lastError?: string
}

async function waitForNodeOutboxFailure(
  outboxId: string,
  phase: string,
  timeoutMs: number
): Promise<TestNodeOutboxRow> {
  return pollTestNodeOutboxFailure(outboxId, phase, timeoutMs, {
    queryRows: (remainingMs, signal) =>
      cli<TestNodeOutboxRow[]>(['outbox', 'list'], Math.min(CLI_TIMEOUT_MS, remainingMs), signal),
    sleep: Bun.sleep,
    now: Date.now,
    intervalMs: OUTBOX_POLL_INTERVAL_MS,
    diagnostics: () =>
      nodeProc
        ? `serve exitCode=${String(nodeProc.exitCode)} signalCode=${String(nodeProc.signalCode)}`
        : 'serve process unavailable',
  })
}

async function waitForNodeOutboxDelivery(
  outboxId: string,
  phase: string,
  timeoutMs = ATTACHMENT_DELIVERY_TIMEOUT_MS
): Promise<void> {
  await pollTestNodeOutboxDelivery(outboxId, phase, timeoutMs, {
    queryRows: (remainingMs, signal) =>
      cli<TestNodeOutboxRow[]>(['outbox', 'list'], Math.min(CLI_TIMEOUT_MS, remainingMs), signal),
    sleep: Bun.sleep,
    now: Date.now,
    intervalMs: OUTBOX_POLL_INTERVAL_MS,
    diagnostics: () => {
      const processState = nodeProc
        ? `serve exitCode=${String(nodeProc.exitCode)} signalCode=${String(nodeProc.signalCode)}`
        : 'serve process unavailable'
      return processState
    },
  })
}

async function capturedNodeDiagnostics(child: FileCapturedChild): Promise<string> {
  const { stdout, stderr } = await readFileCapturedChildTails(child)
  return (
    `pid=${child.proc.pid} exit=${String(child.proc.exitCode)} signal=${String(child.proc.signalCode)}; ` +
    `stdout tail=${stdout}; stderr tail=${stderr}`
  )
}

async function waitForNodeReady(child: FileCapturedChild, port: number, timeoutMs: number): Promise<void> {
  await waitForProtocolReady({
    phase: 'node-http-ready',
    timeoutMs,
    probes: [
      {
        url: `http://127.0.0.1:${port}/healthz`,
        validate: async (response) => ((await response.json()) as { ok?: boolean }).ok === true,
      },
      {
        url: `http://127.0.0.1:${port}/amtp/identity`,
        validate: async (response) => {
          const identity = (await response.json()) as { instanceId?: unknown; publicKeyPem?: unknown }
          return {
            valid: identity.instanceId === nodeInstanceId && identity.publicKeyPem === nodePublicKeyPem,
            detail:
              `expected identity=${nodeInstanceId} actual identity=${String(identity.instanceId)} ` +
              `publicKeyMatches=${identity.publicKeyPem === nodePublicKeyPem}`,
          }
        },
      },
    ],
    diagnostics: () => capturedNodeDiagnostics(child),
    isDead: () => child.proc.exitCode !== null || child.proc.signalCode !== null,
  })
}

async function waitForFicusReady(): Promise<void> {
  await waitForProtocolReady({
    phase: 'tau-http-ready',
    timeoutMs: STARTUP_TIMEOUT_MS,
    probes: [
      {
        url: `http://127.0.0.1:${ficusPort}/api/amtp/identity`,
        validate: async (response) => {
          const payload: unknown = await response.json()
          const record = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {}
          const actual = record.instanceId
          const publicKeyMatches = record.publicKeyPem === ficusPublicKeyPem
          return {
            valid: actual === ficusInstanceId && publicKeyMatches,
            detail:
              `status=${response.status} contentType=${response.headers.get('content-type') ?? 'none'} ` +
              `keys=${Object.keys(record).sort().join(',') || 'none'} expectedIdentity=${ficusInstanceId} ` +
              `actualIdentity=${typeof actual === 'string' ? actual : typeof actual} publicKeyMatches=${publicKeyMatches}`,
          }
        },
      },
    ],
  })
}

/** Spawn `amtp serve` and publish it only after record and HTTP readiness. */
async function startNodeServe(): Promise<void> {
  if (!nodeHome) throw new Error('AMTP node home is not initialized')
  if (!cliCaptureDir) throw new Error('AMTP capture directory is not initialized')
  if (!builtNodeEntrypoint) throw new Error('AMTP built entrypoint is not initialized')
  const startedAt = Date.now()
  const child = spawnFileCapturedChild(
    amtpNodeCommand(process.execPath, NODE_ENTRY, ['--home', nodeHome, 'serve', '--port', '0']),
    cliCaptureDir
  )
  try {
    const record = await waitForCapturedJsonLine<{ listening: true; port: number; instanceId: string }>(child, {
      phase: 'node-listening-record',
      timeoutMs: STARTUP_TIMEOUT_MS,
      match: (value) => {
        const candidate = value as { listening?: unknown; port?: unknown; instanceId?: unknown }
        return (
          candidate?.listening === true &&
          typeof candidate.port === 'number' &&
          typeof candidate.instanceId === 'string'
        )
      },
    })
    const remainingMs = Math.max(1, STARTUP_TIMEOUT_MS - (Date.now() - startedAt))
    await waitForNodeReady(child, record.port, remainingMs)
    nodeProc = child.proc
    nodeCapture = child
    nodePort = record.port
  } catch (error) {
    try {
      await terminateProcess(child.proc)
    } finally {
      await cleanupFileCapturedChild(child)
    }
    throw error
  }
}

// One test's death must not cascade into the rest of the file: when a test
// times out, bun's zombie killer SIGTERMs every subprocess spawned so far —
// including the long-lived `amtp serve` process every later test shares (seen
// in CI runs 30947168870/30952651592, where a #10 timeout took two #11 tests
// down with it). Detect a dead node before each test and restart it: the
// AMTP_HOME (identity, registrations, sqlite state) survives, so only the
// port changes — repoint tau's peer row at it.
beforeEach(async () => {
  if (!nodeHome || !nodeProc || !nodeCapture) return // beforeAll not (successfully) run yet
  if (nodeProc.exitCode !== null || nodeProc.signalCode !== null) {
    await cleanupFileCapturedChild(nodeCapture)
    await startNodeServe()
    await db
      .update(peers)
      .set({ baseUrl: `http://127.0.0.1:${nodePort}` })
      .where(eq(peers.instanceId, nodeInstanceId))
  }
  await waitForNodeReady(nodeCapture!, nodePort, STARTUP_TIMEOUT_MS)
  await waitForFicusReady()
})

// ---------------------------------------------------------------------------
// tau-side fixture helpers.
// ---------------------------------------------------------------------------

async function createFicusAgent(
  handle: string,
  opts: { open: boolean; identityPublicKeyPem?: string; identityPrivateKeyPem?: string }
): Promise<Agent> {
  const created = await Agent.create({ agentTypeId: sharedAgentTypeId, metadata: { name: handle } })
  createdAgentIds.push(created.id)
  const sandboxId = await created.getSandboxId()
  if (opts.identityPrivateKeyPem) {
    const path = agentIdentityHostPath(sandboxId)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, opts.identityPrivateKeyPem, { mode: 0o600 })
  }
  await ensureAgentIdentity(created, sandboxId)
  if (opts.identityPublicKeyPem && created.identityPublicKey !== opts.identityPublicKeyPem) {
    throw new Error('Ficus agent fixture private key does not match its requested public key')
  }
  await created.update({ amtpHandle: handle, inboundOpen: opts.open })
  return created
}

/** Enqueue + drain a tau-originated send, returning the resulting outbox row's terminal status. */
async function sendFromFicus(
  args: Parameters<typeof enqueueFederatedSend>[0]
): Promise<{ id: string; status: string }> {
  const entry = await enqueueFederatedSend(args)
  await drainOutboxOnce()
  const [row] = await db.select({ status: outbox.status }).from(outbox).where(eq(outbox.id, entry.id))
  return { id: entry.id, status: row.status }
}

/** Seed a real InboxAttachment (tau's outbound-attachment storage — §4.7/adapters.ts) for use in a send's `attachments` array. */
async function seedFicusOutboundAttachment(bytes: Uint8Array, filename: string): Promise<InboxAttachment> {
  const [msgRow] = await db
    .insert(inbox)
    .values({ recipientType: 'system', recipientId: crypto.randomUUID(), senderType: 'system', content: 'seed' })
    .returning()
  return InboxAttachment.create({ messageId: msgRow.id, filename, contentType: 'text/plain', bytes })
}

// ---------------------------------------------------------------------------
// Lifecycle (§10.2 hygiene: explicit timeouts, afterAll kill + cleanup even
// on failure).
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // This matrix does real cross-process HTTP; tau's outbound delivery and its
  // TOFU key-fetch both go through the engine's late-bound `globalThis.fetch`.
  // An earlier test file in the single-process run may have left a fetch mock
  // installed (file order is platform-dependent — this only bites in CI), which
  // would surface as "delivery failed: HTTP undefined". Restore the pristine
  // fetch stashed by the preload so this file never inherits a leaked mock.
  const realFetch = (globalThis as unknown as { __REAL_FETCH__?: typeof fetch }).__REAL_FETCH__
  if (realFetch) globalThis.fetch = realFetch

  filesDir = await mkdtemp(join(tmpdir(), 'amtp-matrix-files-'))
  homeDir = await mkdtemp(join(tmpdir(), 'amtp-matrix-home-'))
  cliCaptureDir = await mkdtemp(join(tmpdir(), 'amtp-matrix-cli-capture-'))
  nodeArtifactDir = await mkdtemp(join(tmpdir(), 'amtp-matrix-node-artifact-'))
  builtNodeEntrypoint = await buildAmtpConformanceEntrypoint({
    sourcePath: NODE_SOURCE_ENTRY,
    artifactDir: nodeArtifactDir,
    captureDir: cliCaptureDir,
    timeoutMs: STARTUP_TIMEOUT_MS,
  })
  NODE_ENTRY = builtNodeEntrypoint.path
  process.env.HOME_DIR = homeDir
  const settingsStore = getSettingsStore()
  await settingsStore.initialize()
  await settingsStore.set('INBOX_MAX_ATTACHMENT_BYTES', '10485760')
  await settingsStore.set('INBOX_MAX_TOTAL_STORAGE_BYTES', '10737418240')

  // --- tau: real Bun.serve over the production route wiring ---
  ficusServer = Bun.serve({ port: 0, fetch: app.fetch })
  ficusPort = ficusServer.port!
  ;({ instanceId: ficusInstanceId, publicKeyPem: ficusPublicKeyPem } = await InstanceIdentity.getPublic())
  await waitForFicusReady()

  sharedAgentTypeId = `${prefix}-type`
  await AgentType.create({
    id: sharedAgentTypeId,
    model: 'anthropic:claude-sonnet-4-5',
    name: 'Node Conformance Type',
    systemPrompt: 'test',
  })

  // --- node: real subprocess against a temp AMTP_HOME ---
  nodeHome = await mkdtemp(join(tmpdir(), 'amtp-matrix-node-'))
  const init = await runCli(['init'])
  if (init.exitCode !== 0) throw new Error(`amtp init failed: ${init.stderr || init.stdout}`)
  const identity = JSON.parse(init.stdout) as { instanceId: string; publicKeyPem: string }
  nodeInstanceId = identity.instanceId
  nodePublicKeyPem = identity.publicKeyPem

  await startNodeServe()

  // --- peering, both directions (§10.2) ---
  await Peer.create({
    localAlias: `${prefix}-node`,
    instanceId: nodeInstanceId,
    baseUrl: `http://127.0.0.1:${nodePort}`,
    publicKeyPem: nodePublicKeyPem,
  })
  await cli([
    'peer',
    'add',
    '--alias',
    'tau',
    '--base-url',
    `http://127.0.0.1:${ficusPort}/api`,
    '--public-key',
    ficusPublicKeyPem,
    '--instance-id',
    ficusInstanceId,
  ])
})

afterAll(async () => {
  const phases: Array<{ phase: string; operation: () => void | Promise<unknown> }> = []
  if (nodeProc) phases.push({ phase: 'node-process', operation: () => terminateProcess(nodeProc!, 2000) })
  if (nodeCapture) phases.push({ phase: 'node-captures', operation: () => cleanupFileCapturedChild(nodeCapture!) })
  phases.push({ phase: 'tau-server', operation: () => ficusServer?.stop(true) })
  if (nodeHome) phases.push({ phase: 'node-home', operation: () => rm(nodeHome!, { recursive: true, force: true }) })
  if (filesDir) {
    phases.push({ phase: 'attachment-files', operation: () => rm(filesDir!, { recursive: true, force: true }) })
  }
  if (homeDir) phases.push({ phase: 'tau-home', operation: () => rm(homeDir!, { recursive: true, force: true }) })
  if (nodeArtifactDir) {
    phases.push({ phase: 'node-artifact', operation: () => rm(nodeArtifactDir!, { recursive: true, force: true }) })
  }
  if (cliCaptureDir) {
    phases.push({ phase: 'cli-captures', operation: () => rm(cliCaptureDir!, { recursive: true, force: true }) })
  }
  phases.push({
    phase: 'home-environment',
    operation: () => {
      if (origHomeDir === undefined) delete process.env.HOME_DIR
      else process.env.HOME_DIR = origHomeDir
    },
  })
  if (createdAgentIds.length > 0) {
    phases.push({
      phase: 'agent-inbox-rows',
      operation: () => db.delete(inbox).where(inArray(inbox.recipientId, createdAgentIds)),
    })
    phases.push({ phase: 'agent-rows', operation: () => db.delete(agents).where(inArray(agents.id, createdAgentIds)) })
  }
  if (sharedAgentTypeId) {
    phases.push({
      phase: 'agent-type-row',
      operation: () => db.delete(agentTypes).where(eq(agentTypes.id, sharedAgentTypeId)),
    })
  }
  if (nodeInstanceId) {
    phases.push({
      phase: 'peer-outbox-rows',
      operation: () => db.delete(outbox).where(eq(outbox.peerInstanceId, nodeInstanceId)),
    })
    phases.push({
      phase: 'peer-received-rows',
      operation: () => db.delete(amtpReceived).where(eq(amtpReceived.peerInstanceId, nodeInstanceId)),
    })
    phases.push({
      phase: 'peer-key-rows',
      operation: () => db.delete(amtpKnownKeys).where(eq(amtpKnownKeys.peerInstanceId, nodeInstanceId)),
    })
    phases.push({ phase: 'peer-row', operation: () => db.delete(peers).where(eq(peers.instanceId, nodeInstanceId)) })
  }
  await runBoundedCleanupPhases(phases, CLEANUP_PHASE_TIMEOUT_MS)
})

// ---------------------------------------------------------------------------
// §10.3 #1 — unsigned send to an open mailbox
// ---------------------------------------------------------------------------

describe('#1 unsigned send to an open mailbox', () => {
  test('node -> tau', async () => {
    const nodeHandle = `${prefix}-s1-node-anna`
    await registerNodeHandle(nodeHandle, { open: true })
    const ficusAgent = await createFicusAgent(`${prefix}-s1-tau-ben`, { open: true })

    const res = await cli<NodeSendResult>([
      'send',
      formatAmtpAddress(ficusInstanceId, ficusAgent.amtpHandle!),
      'hello unsigned',
      '--from',
      nodeHandle,
      '--subject',
      'hi',
      '--no-sign',
    ])
    expect(res.status).toBe('delivered')

    const rows = await db.select().from(inbox).where(eq(inbox.recipientId, ficusAgent.id))
    expect(rows).toHaveLength(1)
    expect(rows[0].subject).toBe('hi')
    expect(rows[0].content).toBe('hello unsigned')
    const remote = (rows[0].metadata as Record<string, unknown>).remote as Record<string, unknown>
    expect(remote.fromAddress).toBe(formatAmtpAddress(nodeInstanceId, nodeHandle))
    expect(remote.envelopeId).toBe(res.envelopeId)
  })

  test('tau -> node', async () => {
    const nodeHandle = `${prefix}-s1-tau-cleo`
    await registerNodeHandle(nodeHandle, { open: true })
    const ficusAgent = await createFicusAgent(`${prefix}-s1-tau-dax`, { open: true })

    const { status } = await sendFromFicus({
      fromHandle: ficusAgent.amtpHandle!,
      toAddress: formatAmtpAddress(nodeInstanceId, nodeHandle),
      subject: 'hi',
      content: 'hello unsigned',
    })
    expect(status).toBe('delivered')

    const msgs = await cli<Array<{ id: string }>>(['inbox', 'list', '--handle', nodeHandle])
    expect(msgs).toHaveLength(1)
    const full = await cli<{ from: string; subject: string; content: string; envelopeId: string | null }>([
      'inbox',
      'read',
      msgs[0].id,
    ])
    expect(full.from).toBe(formatAmtpAddress(ficusInstanceId, ficusAgent.amtpHandle!))
    expect(full.subject).toBe('hi')
    expect(full.content).toBe('hello unsigned')
    expect(full.envelopeId).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// §10.3 #2/#3 — signed send, TOFU first contact + pin mismatch
// ---------------------------------------------------------------------------

async function exerciseNodeToFicusWrongPin(casePrefix: string): Promise<void> {
  const nodeHandle = `${casePrefix}-node-wrong-pin`
  const registered = await registerNodeHandle(nodeHandle, { open: true })
  const ficusAgent = await createFicusAgent(`${casePrefix}-tau-recipient`, { open: true })
  const toAddress = formatAmtpAddress(ficusInstanceId, ficusAgent.amtpHandle!)

  const wrongKey = generateInstanceKeyPair().publicKeyPem
  expect(wrongKey).not.toBe(registered.agentPublicKeyPem)
  await AmtpKnownKey.recordPinIfNew(nodeInstanceId, nodeHandle, wrongKey)
  expect(await AmtpKnownKey.getPin(nodeInstanceId, nodeHandle)).toBe(wrongKey)

  const sendStartedAt = Date.now()
  const res = await cli<NodeSendResult>(['send', toAddress, 'signed but wrong pin', '--from', nodeHandle])
  const remainingMs = Math.max(1, CLI_TIMEOUT_MS - (Date.now() - sendStartedAt))
  const failed = await waitForNodeOutboxFailure(res.outboxId, `${casePrefix}:wrong-pin-terminal`, remainingMs)
  expect(failed.status).toBe('failed')
  expect(failed.lastError).toContain('403')

  expect(await AmtpKnownKey.getPin(nodeInstanceId, nodeHandle)).toBe(wrongKey)
  const rows = await db.select().from(inbox).where(eq(inbox.recipientId, ficusAgent.id))
  expect(rows).toHaveLength(0)

  const bounces = await cli<Array<{ kind: string }>>(['inbox', 'list', '--handle', nodeHandle])
  expect(bounces.filter((message) => message.kind === 'bounce')).toHaveLength(1)
}

async function exerciseFicusToNodeWrongPin(casePrefix: string): Promise<void> {
  const nodeHandle = `${casePrefix}-reverse-pin-node`
  await registerNodeHandle(nodeHandle, { open: true })
  const kp1 = generateInstanceKeyPair()
  const ficusAgent = await createFicusAgent(`${casePrefix}-reverse-pin-tau`, {
    open: true,
    identityPublicKeyPem: kp1.publicKeyPem,
    identityPrivateKeyPem: kp1.privateKeyPem,
  })
  const toAddress = formatAmtpAddress(nodeInstanceId, nodeHandle)
  const from = formatAmtpAddress(ficusInstanceId, ficusAgent.amtpHandle!)

  // #2: first signed contact pins tau's agent key on the node.
  const id1 = crypto.randomUUID()
  const agentSig1 = signEnvelope(
    kp1.privateKeyPem,
    canonicalAgentSigBytes({
      v: 1,
      id: id1,
      from,
      to: toAddress,
      subject: undefined,
      content: 'hi',
      attachments: [],
    })
  )
  const send1 = await sendFromFicus({
    fromHandle: ficusAgent.amtpHandle!,
    toAddress,
    content: 'hi',
    id: id1,
    agentKey: kp1.publicKeyPem,
    agentSig: agentSig1,
  })
  expect(send1.status).toBe('delivered')

  const msgs = await cli<Array<{ id: string }>>(['inbox', 'list', '--handle', nodeHandle])
  expect(msgs).toHaveLength(1)
  const read1 = await cli<{ agentSigVerified: boolean }>(['inbox', 'read', msgs[0].id])
  expect(read1.agentSigVerified).toBe(true)

  // #3: re-sign with a DIFFERENT (unpinned) tau agent key.
  const kp2 = generateInstanceKeyPair()
  const id2 = crypto.randomUUID()
  const agentSig2 = signEnvelope(
    kp2.privateKeyPem,
    canonicalAgentSigBytes({
      v: 1,
      id: id2,
      from,
      to: toAddress,
      subject: undefined,
      content: 'hi again',
      attachments: [],
    })
  )
  const send2 = await sendFromFicus({
    fromHandle: ficusAgent.amtpHandle!,
    toAddress,
    content: 'hi again',
    id: id2,
    agentKey: kp2.publicKeyPem,
    agentSig: agentSig2,
  })
  expect(send2.status).toBe('failed')

  const bounceRows = await db.select().from(inbox).where(eq(inbox.recipientId, ficusAgent.id))
  const bounce = bounceRows.find((r) => (r.metadata as Record<string, unknown>).federationBounce)
  expect(bounce).toBeTruthy()
  expect(((bounce!.metadata as Record<string, unknown>).federationBounce as { reason: string }).reason).toContain('403')
}

describe('#2/#3 signed send: TOFU first contact, then a mismatched re-sign is rejected', () => {
  test('node -> tau', async () => {
    const nodeHandle = `${prefix}-s23-node-carol`
    await registerNodeHandle(nodeHandle, { open: true })
    const ficusAgent = await createFicusAgent(`${prefix}-s23-tau-bob`, { open: true })
    const toAddress = formatAmtpAddress(ficusInstanceId, ficusAgent.amtpHandle!)

    // #2: first signed contact pins the node handle's agent key.
    const first = await cli<NodeSendResult>(['send', toAddress, 'hello signed', '--from', nodeHandle])
    expect(first.status).toBe('delivered')

    const whoami = await cli<{ registrations: Array<{ handle: string; agentPublicKeyPem: string }> }>(['whoami'])
    const reg = whoami.registrations.find((r) => r.handle === nodeHandle)!
    const pinned = await AmtpKnownKey.getPin(nodeInstanceId, nodeHandle)
    expect(pinned).toBe(reg.agentPublicKeyPem)

    const rows = await db.select().from(inbox).where(eq(inbox.recipientId, ficusAgent.id))
    expect(rows).toHaveLength(1)
    expect(((rows[0].metadata as Record<string, unknown>).remote as Record<string, unknown>).agentSigVerified).toBe(
      true
    )

    // #3: regenerate the node handle's agent key (a real, different key) and re-send.
    await cli(['register', nodeHandle, '--regenerate'])
    const second = await cli<NodeSendResult>(['send', toAddress, 'hello again', '--from', nodeHandle])
    expect(second.status).toBe('failed')
    expect(second.lastError).toContain('403')

    const bounces = await cli<Array<{ kind: string }>>(['inbox', 'list', '--handle', nodeHandle])
    expect(bounces.some((m) => m.kind === 'bounce')).toBe(true)
  })

  test('tau -> node', async () => {
    await exerciseFicusToNodeWrongPin(`${prefix}-s23`)
  })

  test('node -> tau: a pre-seeded wrong pin (white-box) rejects the very first signed send', async () => {
    await exerciseNodeToFicusWrongPin(`${prefix}-s3`)
  })
})

// ---------------------------------------------------------------------------
// §10.3 #4 — closed mailbox, no rule
// ---------------------------------------------------------------------------

describe('#4 closed mailbox, no rule', () => {
  test('node -> tau', async () => {
    const nodeHandle = `${prefix}-s4-node-frank`
    await registerNodeHandle(nodeHandle, { open: true })
    const ficusAgent = await createFicusAgent(`${prefix}-s4-tau-grace`, { open: false })

    const res = await cli<NodeSendResult>([
      'send',
      formatAmtpAddress(ficusInstanceId, ficusAgent.amtpHandle!),
      'closed mailbox',
      '--from',
      nodeHandle,
      '--no-sign',
    ])
    expect(res.status).toBe('failed')
    expect(res.lastError).toContain('403')

    const bounces = await cli<Array<{ id: string; kind: string }>>(['inbox', 'list', '--handle', nodeHandle])
    const bounce = bounces.find((m) => m.kind === 'bounce')
    expect(bounce).toBeTruthy()
    const full = await cli<{ bounce: { reason: string } }>(['inbox', 'read', bounce!.id])
    expect(full.bounce.reason).toContain('403')
  })

  test('tau -> node', async () => {
    const nodeHandle = `${prefix}-s4-tau-henry`
    await registerNodeHandle(nodeHandle, { open: false })
    const ficusAgent = await createFicusAgent(`${prefix}-s4-tau-iris`, { open: true })

    const { status } = await sendFromFicus({
      fromHandle: ficusAgent.amtpHandle!,
      toAddress: formatAmtpAddress(nodeInstanceId, nodeHandle),
      content: 'closed',
    })
    expect(status).toBe('failed')

    const bounceRows = await db.select().from(inbox).where(eq(inbox.recipientId, ficusAgent.id))
    const bounce = bounceRows.find((r) => (r.metadata as Record<string, unknown>).federationBounce)
    expect(bounce).toBeTruthy()
    expect(((bounce!.metadata as Record<string, unknown>).federationBounce as { reason: string }).reason).toContain(
      '403'
    )
  })
})

// ---------------------------------------------------------------------------
// §10.3 #5 — closed mailbox, handle-scoped allow rule
// ---------------------------------------------------------------------------

describe('#5 closed mailbox, handle-scoped allow rule', () => {
  test('node -> tau', async () => {
    const senderX = `${prefix}-s5-node-x`
    const senderY = `${prefix}-s5-node-y`
    await registerNodeHandle(senderX, { open: true })
    await registerNodeHandle(senderY, { open: true })
    const ficusAgent = await createFicusAgent(`${prefix}-s5-tau-closed`, { open: false })
    const toAddress = formatAmtpAddress(ficusInstanceId, ficusAgent.amtpHandle!)

    const before = await cli<NodeSendResult>(['send', toAddress, 'msg1', '--from', senderX, '--no-sign'])
    expect(before.status).toBe('failed')

    await AmtpAllowRule.create({
      targetAgentId: ficusAgent.id,
      peerInstanceId: nodeInstanceId,
      principalKind: 'handle',
      principalValue: senderX,
    })

    const allowed = await cli<NodeSendResult>(['send', toAddress, 'msg2', '--from', senderX, '--no-sign'])
    expect(allowed.status).toBe('delivered')

    const stillBlocked = await cli<NodeSendResult>(['send', toAddress, 'msg3', '--from', senderY, '--no-sign'])
    expect(stillBlocked.status).toBe('failed')
  })

  test('tau -> node', async () => {
    const nodeHandle = `${prefix}-s5-tau-closed`
    await registerNodeHandle(nodeHandle, { open: false })
    const senderXHandle = `${prefix}-s5-tau-x`
    const senderYHandle = `${prefix}-s5-tau-y`
    const toAddress = formatAmtpAddress(nodeInstanceId, nodeHandle)

    const before = await sendFromFicus({ fromHandle: senderXHandle, toAddress, content: 'msg1' })
    expect(before.status).toBe('failed')

    await cli(['allow', 'add', nodeHandle, '--peer', 'tau', '--sender', senderXHandle])

    const allowed = await sendFromFicus({ fromHandle: senderXHandle, toAddress, content: 'msg2' })
    expect(allowed.status).toBe('delivered')

    const stillBlocked = await sendFromFicus({ fromHandle: senderYHandle, toAddress, content: 'msg3' })
    expect(stillBlocked.status).toBe('failed')
  })
})

// ---------------------------------------------------------------------------
// §10.3 #6 — unknown recipient handle
// ---------------------------------------------------------------------------

async function exerciseNodeToFicusUnknownRecipient(casePrefix: string): Promise<void> {
  const nodeHandle = `${casePrefix}-node-sender`
  const missingFicusHandle = `${casePrefix}-tau-nonexistent`
  await registerNodeHandle(nodeHandle, { open: true })
  expect(await Agent.findByFederationHandle(missingFicusHandle)).toBeNull()

  const sendStartedAt = Date.now()
  const res = await cli<NodeSendResult>([
    'send',
    formatAmtpAddress(ficusInstanceId, missingFicusHandle),
    'msg',
    '--from',
    nodeHandle,
    '--no-sign',
  ])
  const remainingMs = Math.max(1, CLI_TIMEOUT_MS - (Date.now() - sendStartedAt))
  const failed = await waitForNodeOutboxFailure(res.outboxId, `${casePrefix}:unknown-recipient-terminal`, remainingMs)
  expect(failed.status).toBe('failed')
  expect(failed.lastError).toContain('404')

  const bounces = await cli<Array<{ kind: string }>>(['inbox', 'list', '--handle', nodeHandle])
  expect(bounces.filter((message) => message.kind === 'bounce')).toHaveLength(1)
}

describe('#6 unknown recipient handle', () => {
  test('node -> tau', async () => {
    await exerciseNodeToFicusUnknownRecipient(`${prefix}-s6`)
  })

  test('tau -> node', async () => {
    const ficusAgent = await createFicusAgent(`${prefix}-s6-tau-kim`, { open: true })

    const { status } = await sendFromFicus({
      fromHandle: ficusAgent.amtpHandle!,
      toAddress: formatAmtpAddress(nodeInstanceId, `${prefix}-s6-node-nonexistent`),
      content: 'msg',
    })
    expect(status).toBe('failed')

    const bounceRows = await db.select().from(inbox).where(eq(inbox.recipientId, ficusAgent.id))
    const bounce = bounceRows.find((r) => (r.metadata as Record<string, unknown>).federationBounce)
    expect(bounce).toBeTruthy()
    expect(((bounce!.metadata as Record<string, unknown>).federationBounce as { reason: string }).reason).toContain(
      '404'
    )
  })
})

// ---------------------------------------------------------------------------
// §10.3 #7 — attachment send
// ---------------------------------------------------------------------------

async function exerciseNodeToFicusAttachment(casePrefix: string): Promise<void> {
  await waitForNodeReady(nodeCapture!, nodePort, STARTUP_TIMEOUT_MS)
  await waitForFicusReady()
  const nodeHandle = `${casePrefix}-node`
  const registered = await registerNodeHandle(nodeHandle, { open: true })
  const ficusAgent = await createFicusAgent(`${casePrefix}-tau`, { open: true })

  const [peer] = await db.select().from(peers).where(eq(peers.instanceId, nodeInstanceId))
  expect(peer).toMatchObject({
    baseUrl: `http://127.0.0.1:${nodePort}`,
    publicKeyPem: nodePublicKeyPem,
    status: 'active',
  })
  const whoami = await cli<{ registrations: Array<{ handle: string; agentPublicKeyPem: string }> }>(['whoami'])
  expect(whoami.registrations.find(({ handle }) => handle === nodeHandle)).toMatchObject({
    agentPublicKeyPem: registered.agentPublicKeyPem,
  })

  const content = `attachment payload from node ${Math.random()}`
  const expectedBytes = Buffer.from(content)
  const settings = getSettingsStore()
  const maxAttachment = settings.getTyped('INBOX_MAX_ATTACHMENT_BYTES') as number
  const maxTotal = settings.getTyped('INBOX_MAX_TOTAL_STORAGE_BYTES') as number
  expect(expectedBytes.byteLength).toBeLessThanOrEqual(maxAttachment)
  expect((await InboxAttachment.totalStorageBytes()) + expectedBytes.byteLength).toBeLessThanOrEqual(maxTotal)
  const filePath = join(filesDir!, `${casePrefix}-attachment.txt`)
  await writeFile(filePath, expectedBytes)
  const uploaded = await uploadNodeAttachment({
    home: nodeHome!,
    captureDir: cliCaptureDir!,
    nodeEntry: builtNodeEntrypoint!.path,
    filePath,
    expectedBytes,
    timeoutMs: CLI_TIMEOUT_MS,
    diagnostics: async () => {
      const tails = await readFileCapturedChildTails(nodeCapture!)
      return `nodeServe=${nodeProc?.exitCode === null ? 'alive' : 'exited'}; stderrTail=${tails.stderr}`
    },
  })

  let outboxId: string | undefined
  let receivedAttachment: InboxAttachment | undefined
  let inboxMessageId: string | undefined
  try {
    const res = await cli<NodeSendResult>([
      'send',
      formatAmtpAddress(ficusInstanceId, ficusAgent.amtpHandle!),
      'see attached',
      '--from',
      nodeHandle,
      '--attach-id',
      uploaded.attachmentId,
      '--queue-only',
    ])
    expect(res.status).toBe('pending')
    outboxId = res.outboxId
    const envelope = readNodeOutboxEnvelope(nodeHome!, res.outboxId) as AmtpEnvelope
    expect(envelope.attachments).toEqual([
      {
        id: uploaded.attachmentId,
        filename: uploaded.filename,
        contentType: uploaded.contentType,
        byteSize: uploaded.byteSize,
        sha256: uploaded.sha256,
      },
    ])
    expect(envelope.agentSig).toBeTruthy()
    await waitForNodeOutboxDelivery(res.outboxId, `${casePrefix}:attachment-delivery`)

    const rows = await db.select().from(inbox).where(eq(inbox.recipientId, ficusAgent.id))
    expect(rows).toHaveLength(1)
    expect(((rows[0].metadata as Record<string, unknown>).remote as Record<string, unknown>).agentSigVerified).toBe(
      true
    )
    inboxMessageId = rows[0].id
    const atts = await db.select().from(inboxAttachments).where(eq(inboxAttachments.messageId, rows[0].id))
    expect(atts).toHaveLength(1)
    expect(atts[0]).toMatchObject({
      filename: uploaded.filename,
      contentType: uploaded.contentType,
      sha256: uploaded.sha256,
      byteSize: uploaded.byteSize,
    })
    receivedAttachment = new InboxAttachment(atts[0])
    const bytes = await readAttachmentFile(atts[0].storagePath)
    expect(bytes).toEqual(expectedBytes)
  } finally {
    await receivedAttachment?.delete()
    if (inboxMessageId) await db.delete(inbox).where(eq(inbox.id, inboxMessageId))
    await uploaded.dispose(outboxId)
    await rm(filePath, { force: true })
  }
}

describe('#7 attachment send', () => {
  test('node -> tau', async () => {
    await exerciseNodeToFicusAttachment(`${prefix}-s7`)
  })

  test('tau -> node', async () => {
    const nodeHandle = `${prefix}-s7-tau-noah`
    await registerNodeHandle(nodeHandle, { open: true })
    const ficusAgent = await createFicusAgent(`${prefix}-s7-tau-olivia`, { open: true })

    const contentBytes = new TextEncoder().encode(`attachment payload from tau ${Math.random()}`)
    const att = await seedFicusOutboundAttachment(contentBytes, 's7-tau-to-node.txt')
    const ref: AmtpAttachmentRef = {
      id: att.id,
      filename: att.filename,
      contentType: att.contentType,
      byteSize: att.byteSize,
      sha256: att.sha256,
    }

    const { status } = await sendFromFicus({
      fromHandle: ficusAgent.amtpHandle!,
      toAddress: formatAmtpAddress(nodeInstanceId, nodeHandle),
      content: 'see attached',
      attachments: [ref],
    })
    expect(status).toBe('delivered')

    const msgs = await cli<Array<{ id: string }>>(['inbox', 'list', '--handle', nodeHandle])
    expect(msgs).toHaveLength(1)
    const full = await cli<{
      attachments: Array<{ id: string; sha256: string; byteSize: number }>
    }>(['inbox', 'read', msgs[0].id])
    expect(full.attachments).toHaveLength(1)
    expect(full.attachments[0].sha256).toBe(att.sha256)
    expect(full.attachments[0].byteSize).toBe(att.byteSize)

    const outDir = await mkdtemp(join(tmpdir(), 'amtp-matrix-download-'))
    try {
      const downloaded = await cli<{ path: string }>(['attach', 'download', full.attachments[0].id, '-o', outDir])
      const savedBytes = await readFile(downloaded.path)
      expect(new Uint8Array(savedBytes)).toEqual(contentBytes)
    } finally {
      await rm(outDir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// §10.3 #8 — attachment default-deny (one direction per host as GET-receiver)
// ---------------------------------------------------------------------------

describe('#8 attachment default-deny', () => {
  test('node as GET-receiver: a signed GET (as tau, real credentials) for an attachment never addressed to tau -> 404', async () => {
    const nodeHandle = `${prefix}-s8-node-owner`
    await registerNodeHandle(nodeHandle, { open: true })
    const filePath = join(filesDir!, 's8-node-owned.txt')
    await writeFile(filePath, 'never addressed to tau', 'utf8')
    const uploaded = await cli<{ attachmentId: string }>(['attach', 'upload', filePath])

    const ficusIdentity = await InstanceIdentity.getOrCreate()
    const ts = Date.now()
    const path = `/amtp/attachments/${uploaded.attachmentId}`
    const canonical = canonicalPeerGetString('GET', path, ts)
    const signature = signEnvelope(ficusIdentity.privateKeyPem, new TextEncoder().encode(canonical))

    const res = await fetch(`http://127.0.0.1:${nodePort}${path}`, {
      method: 'GET',
      headers: {
        'x-amtp-instance': ficusInstanceId,
        'x-amtp-signature': signature,
        'x-amtp-timestamp': String(ts),
      },
    })
    expect(res.status).toBe(404)
  })

  test('tau as GET-receiver: a signed GET (as an unrelated peer) for an attachment never addressed to it -> 404', async () => {
    const synthKeys = generateInstanceKeyPair()
    const synthInstanceId = instanceIdFromPublicKeyPem(synthKeys.publicKeyPem)
    const synthPeer = await Peer.create({
      localAlias: `${prefix}-s8-synthetic`,
      instanceId: synthInstanceId,
      baseUrl: 'https://synthetic.example/api',
      publicKeyPem: synthKeys.publicKeyPem,
    })

    try {
      const bytes = new TextEncoder().encode('never addressed to the synthetic peer')
      const att = await seedFicusOutboundAttachment(bytes, 's8-tau-owned.txt')

      const ts = Date.now()
      const path = `/api/amtp/attachments/${att.id}`
      const canonical = canonicalPeerGetString('GET', path, ts)
      const signature = signEnvelope(synthKeys.privateKeyPem, new TextEncoder().encode(canonical))

      const res = await fetch(`http://127.0.0.1:${ficusPort}${path}`, {
        method: 'GET',
        headers: {
          'x-amtp-instance': synthInstanceId,
          'x-amtp-signature': signature,
          'x-amtp-timestamp': String(ts),
        },
      })
      expect(res.status).toBe(404)
    } finally {
      await Peer.delete(synthPeer.id)
    }
  })
})

// ---------------------------------------------------------------------------
// §10.3 #9 — replay (node as receiver; tau's side is its frozen suite,
// amtp.receive-signed.test.ts)
// ---------------------------------------------------------------------------

describe('#9 replay', () => {
  test('the same signed body POSTed twice to the node -> second is {accepted, duplicate:true}, exactly one mailbox row', async () => {
    const nodeHandle = `${prefix}-s9-node-replay`
    await registerNodeHandle(nodeHandle, { open: true })

    const ficusIdentity = await InstanceIdentity.getOrCreate()
    const id = crypto.randomUUID()
    const from = formatAmtpAddress(ficusInstanceId, `${prefix}-s9-tau-sender`)
    const to = formatAmtpAddress(nodeInstanceId, nodeHandle)
    const envelope: AmtpEnvelope = { v: 1, id, ts: Date.now(), from, to, content: 'replay me' }
    const body = JSON.stringify(envelope)
    const signature = signEnvelope(ficusIdentity.privateKeyPem, new TextEncoder().encode(body))
    const headers = {
      'content-type': 'application/json',
      'x-amtp-instance': ficusInstanceId,
      'x-amtp-signature': signature,
    }

    const res1 = await fetch(`http://127.0.0.1:${nodePort}/amtp/inbox`, { method: 'POST', headers, body })
    expect(res1.status).toBe(200)
    expect(await res1.json()).toEqual({ accepted: true })

    const res2 = await fetch(`http://127.0.0.1:${nodePort}/amtp/inbox`, { method: 'POST', headers, body })
    expect(res2.status).toBe(200)
    expect(await res2.json()).toEqual({ accepted: true, duplicate: true })

    const msgs = await cli<unknown[]>(['inbox', 'list', '--handle', nodeHandle])
    expect(msgs).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// §10.3 #10 — duplicate-enqueue idempotency (node sender)
// ---------------------------------------------------------------------------

describe('#10 duplicate-enqueue idempotency', () => {
  test('"amtp send --envelope-id" twice with the same id -> one outbox entry, one delivery', async () => {
    const nodeHandle = `${prefix}-s10-node-sender`
    await registerNodeHandle(nodeHandle, { open: true })
    const ficusAgent = await createFicusAgent(`${prefix}-s10-tau-recv`, { open: true })
    const toAddress = formatAmtpAddress(ficusInstanceId, ficusAgent.amtpHandle!)
    const envelopeId = crypto.randomUUID()

    const first = await cli<NodeSendResult>([
      'send',
      toAddress,
      'idempotent',
      '--from',
      nodeHandle,
      '--envelope-id',
      envelopeId,
      '--no-sign',
    ])
    const second = await cli<NodeSendResult>([
      'send',
      toAddress,
      'idempotent',
      '--from',
      nodeHandle,
      '--envelope-id',
      envelopeId,
      '--no-sign',
    ])

    expect(second.outboxId).toBe(first.outboxId)
    expect(second.envelopeId).toBe(first.envelopeId)
    expect(first.status).toBe('delivered')
    expect(second.status).toBe('delivered')

    const allOutbox = await cli<Array<{ id: string }>>(['outbox', 'list'])
    expect(allOutbox.filter((e) => e.id === first.outboxId)).toHaveLength(1)

    const rows = await db.select().from(inbox).where(eq(inbox.recipientId, ficusAgent.id))
    expect(rows).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// #11 — agent cards (docs/history/superpowers/specs/2026-07-09-amtp-agent-card-design.md
// §4.6/§11): publish/fetch/verify a signed card across the tau<->node boundary,
// TOFU-pinning it exactly like a first signed send, plus the unsigned discovery
// hints that ride the existing /handles listing. New row, numbered #11 (not
// #8) because #8 above is already the frozen "attachment default-deny" case
// from the node-design matrix; this file's numbering is append-only.
// ---------------------------------------------------------------------------

async function exerciseBidirectionalHints(casePrefix: string): Promise<void> {
  if (!nodeCapture) throw new Error('AMTP node capture is unavailable')
  await waitForNodeReady(nodeCapture, nodePort, STARTUP_TIMEOUT_MS)
  await waitForFicusReady()

  const [peer] = await db.select().from(peers).where(eq(peers.instanceId, nodeInstanceId))
  expect(peer).toMatchObject({ status: 'active', baseUrl: `http://127.0.0.1:${nodePort}` })

  const nodeHandle = `${casePrefix}-node-discover`
  await registerNodeHandle(nodeHandle, { open: true })
  const nodeCard = await cli<AmtpSignedAgentCard>([
    'card',
    'set',
    nodeHandle,
    '--name',
    'Discoverable Node',
    '--description',
    'Node hint test',
  ])
  expect(nodeCard.card).toMatchObject({ name: 'Discoverable Node', description: 'Node hint test' })

  const kp = generateInstanceKeyPair()
  const ficusHandle = `${casePrefix}-tau-discover`
  const ficusAgent = await createFicusAgent(ficusHandle, {
    open: true,
    identityPublicKeyPem: kp.publicKeyPem,
    identityPrivateKeyPem: kp.privateKeyPem,
  })
  const sansSig = {
    v: 1 as const,
    instanceId: ficusInstanceId,
    handle: ficusHandle,
    card: { name: 'Discoverable Ficus', description: 'Ficus hint test' },
  }
  const signed: AmtpSignedAgentCard = { ...sansSig, cardSig: signAgentCard(kp.privateKeyPem, sansSig) }
  await ficusAgent.update({ cardJson: signed })
  const storedFicusAgent = await Agent.findByFederationHandle(ficusHandle)
  expect(storedFicusAgent?.cardJson).toMatchObject({ card: sansSig.card })

  const rbacPrefix = `${casePrefix}-hints-rbac`
  const reader = await createTestUser({ prefix: rbacPrefix })
  const readRole = await createTestRole({ prefix: rbacPrefix, permissions: ['amtp:read'] })
  await assignRole({ userId: reader.id, roleId: readRole.id, scope: 'system' })
  try {
    const res = await fetchInProtocolPhase(`http://127.0.0.1:${ficusPort}/api/amtp/peers/${nodeInstanceId}/handles`, {
      phase: 'tau-peer-handles-proxy',
      timeoutMs: 5_000,
      init: { headers: authHeaders(reader.token) },
      requireOk: true,
      diagnostics: async () =>
        `${nodeCapture ? await capturedNodeDiagnostics(nodeCapture) : 'node unavailable'}; tau port=${ficusPort}`,
    })
    const body = (await res.json()) as {
      handles: Array<{ handle: string; name?: string; description?: string }>
    }
    const hint = body.handles.find((candidate) => candidate.handle === nodeHandle)
    expect(hint?.name).toBe('Discoverable Node')
    expect(hint?.description).toBe('Node hint test')
  } finally {
    await cleanupTestRbac(rbacPrefix)
  }
  const leakedUsers = await db
    .select({ id: users.id })
    .from(users)
    .where(like(users.email, `${rbacPrefix}%`))
  expect(leakedUsers).toHaveLength(0)

  const remoteHandles = await cli<Array<{ handle: string; name?: string; description?: string }>>(['handles', 'tau'])
  const ficusHint = remoteHandles.find((candidate) => candidate.handle === ficusHandle)
  expect(ficusHint?.name).toBe('Discoverable Ficus')
  expect(ficusHint?.description).toBe('Ficus hint test')
}

async function exerciseCardlessFetch(
  casePrefix: string,
  options?: { scopeCustodyToCasePrefix?: boolean }
): Promise<void> {
  await waitForNodeReady(nodeCapture!, nodePort, STARTUP_TIMEOUT_MS)
  await waitForFicusReady()
  const nodeHandle = `${casePrefix}-cardless`
  await registerNodeHandle(nodeHandle, { open: true })
  const whoami = await auditedWhoami(
    nodeHandle,
    // Only concurrent call sites may scope the custody read-set: unrelated
    // scenarios then legitimately write registrations under other prefixes
    // while this audit runs. Sequential call sites keep the global check.
    options?.scopeCustodyToCasePrefix ? { registrationScope: (handle) => handle.startsWith(casePrefix) } : undefined
  )
  const registration = whoami.registrations.find((candidate) => candidate.handle === nodeHandle) as
    | { handle: string; card?: unknown }
    | undefined
  expect(registration).toBeTruthy()
  expect(registration?.card).toBeUndefined()
  const result = await amtpEngine.fetchPeerAgentCard({ peerInstanceId: nodeInstanceId, handle: nodeHandle })
  expect(result.ok).toBe(false)
}

describe('#11 agent cards', () => {
  test('node -> tau: node publishes a card via `amtp card set`; tau engine.fetchPeerAgentCard verifies + TOFU-pins it', async () => {
    const nodeHandle = `${prefix}-s11-node-card`
    await registerNodeHandle(nodeHandle, { open: true })
    const signed = await cli<AmtpSignedAgentCard>([
      'card',
      'set',
      nodeHandle,
      '--name',
      'Node Agent',
      '--description',
      'Handles quarterly reports',
    ])
    expect(signed.card.name).toBe('Node Agent')

    const result = await amtpEngine.fetchPeerAgentCard({ peerInstanceId: nodeInstanceId, handle: nodeHandle })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.card.name).toBe('Node Agent')
    expect(result.card.description).toBe('Handles quarterly reports')

    const whoami = await cli<{ registrations: Array<{ handle: string; agentPublicKeyPem: string }> }>(['whoami'])
    const reg = whoami.registrations.find((r) => r.handle === nodeHandle)!
    const pinned = await AmtpKnownKey.getPin(nodeInstanceId, nodeHandle)
    expect(pinned).toBe(reg.agentPublicKeyPem)
  })

  test('tau -> node: a tau agent publishes a signed card (white-box); node `amtp card fetch` verifies + TOFU-pins it', async () => {
    const kp = generateInstanceKeyPair()
    const ficusHandle = `${prefix}-s11-tau-card`
    const ficusAgent = await createFicusAgent(ficusHandle, {
      open: true,
      identityPublicKeyPem: kp.publicKeyPem,
      identityPrivateKeyPem: kp.privateKeyPem,
    })

    const sansSig = {
      v: 1 as const,
      instanceId: ficusInstanceId,
      handle: ficusHandle,
      card: { name: 'Ficus Agent', description: 'A tau-hosted agent' },
    }
    const signed: AmtpSignedAgentCard = { ...sansSig, cardSig: signAgentCard(kp.privateKeyPem, sansSig) }
    await ficusAgent.update({ cardJson: signed })

    const result = await cli<{ ok: boolean; card: { name?: string; description?: string } }>([
      'card',
      'fetch',
      ficusHandle,
      '--peer',
      ficusInstanceId,
    ])
    expect(result.ok).toBe(true)
    expect(result.card.name).toBe('Ficus Agent')
    expect(result.card.description).toBe('A tau-hosted agent')
  })

  test('unsigned/absent: tau engine.fetchPeerAgentCard for a cardless node handle -> ok:false', async () => {
    const nodeHandle = `${prefix}-s11-node-nocard`
    await registerNodeHandle(nodeHandle, { open: true })

    const result = await amtpEngine.fetchPeerAgentCard({ peerInstanceId: nodeInstanceId, handle: nodeHandle })
    expect(result.ok).toBe(false)
  })

  test('unsigned/absent: node `amtp card fetch` for a cardless tau handle -> non-zero exit, clean error', async () => {
    const ficusAgent = await createFicusAgent(`${prefix}-s11-tau-nocard`, { open: true })

    const { exitCode, stderr } = await runCli(['card', 'fetch', ficusAgent.amtpHandle!, '--peer', ficusInstanceId])
    expect(exitCode).not.toBe(0)
    const parsed = JSON.parse(stderr) as { error: string }
    expect(parsed.error).toContain('failed to fetch')
  })

  test('tamper: a pre-seeded wrong pin (white-box) rejects the first card fetch for a fresh node handle', async () => {
    const nodeHandle = `${prefix}-s11-node-wrongpin`
    await registerNodeHandle(nodeHandle, { open: true })
    await cli(['card', 'set', nodeHandle, '--name', 'Should Not Verify'])

    const wrongKey = generateInstanceKeyPair().publicKeyPem
    await AmtpKnownKey.recordPinIfNew(nodeInstanceId, nodeHandle, wrongKey)

    const result = await amtpEngine.fetchPeerAgentCard({ peerInstanceId: nodeInstanceId, handle: nodeHandle })
    expect(result.ok).toBe(false)
  })

  test("hints ride discovery: tau's peer-handles proxy shows the node handle's card hints; node `amtp handles` shows tau's", async () => {
    await exerciseBidirectionalHints(`${prefix}-s11`)
  })
})

async function runScopedScenario(casePrefix: string, exercise: () => Promise<void>): Promise<void> {
  const scope = new ScenarioScope(casePrefix)
  const operation = scope.operation('scenario', 'conformance-offender')
  try {
    activeScenarioScope = scope
    await scope.track(operation, exercise())
  } finally {
    activeScenarioScope = undefined
    await scope.dispose()
    expect(scope.snapshot()).toEqual({ resources: 0, operations: 0, aborted: true })
    await waitForNodeReady(nodeCapture!, nodePort, STARTUP_TIMEOUT_MS)
    await waitForFicusReady()
  }
}

// The lifecycle offenders intentionally share one healthy node/tau fixture so
// capture, readiness, SQLite, HTTP, and cleanup ordering are exercised together.
describe('federation lifecycle stress', () => {
  test('forward order', async () => {
    for (let iteration = 0; iteration < 3; iteration++) {
      const casePrefix = `${prefix}-stress-forward-${iteration}`
      await runScopedScenario(`${casePrefix}-exerciseNodeToFicusUnknownRecipient`, () =>
        exerciseNodeToFicusUnknownRecipient(casePrefix)
      )
      await runScopedScenario(`${casePrefix}-exerciseNodeToFicusWrongPin`, () =>
        exerciseNodeToFicusWrongPin(casePrefix)
      )
      await runScopedScenario(`${casePrefix}-exerciseFicusToNodeWrongPin`, () =>
        exerciseFicusToNodeWrongPin(casePrefix)
      )
      await runScopedScenario(`${casePrefix}-exerciseBidirectionalHints`, () => exerciseBidirectionalHints(casePrefix))
      await runScopedScenario(`${casePrefix}-exerciseCardlessFetch`, () => exerciseCardlessFetch(casePrefix))
      await runScopedScenario(`${casePrefix}-exerciseNodeToFicusAttachment`, () =>
        exerciseNodeToFicusAttachment(casePrefix)
      )
    }
  })

  test('reverse order', async () => {
    for (let iteration = 0; iteration < 3; iteration++) {
      const casePrefix = `${prefix}-stress-reverse-${iteration}`
      await runScopedScenario(`${casePrefix}-exerciseNodeToFicusAttachment`, () =>
        exerciseNodeToFicusAttachment(casePrefix)
      )
      await runScopedScenario(`${casePrefix}-exerciseCardlessFetch`, () => exerciseCardlessFetch(casePrefix))
      await runScopedScenario(`${casePrefix}-exerciseBidirectionalHints`, () => exerciseBidirectionalHints(casePrefix))
      await runScopedScenario(`${casePrefix}-exerciseFicusToNodeWrongPin`, () =>
        exerciseFicusToNodeWrongPin(casePrefix)
      )
      await runScopedScenario(`${casePrefix}-exerciseNodeToFicusWrongPin`, () =>
        exerciseNodeToFicusWrongPin(casePrefix)
      )
      await runScopedScenario(`${casePrefix}-exerciseNodeToFicusUnknownRecipient`, () =>
        exerciseNodeToFicusUnknownRecipient(casePrefix)
      )
    }
  })

  test('concurrent shared process', async () => {
    // The real node serve process and every CLI share one amtp.db. Two writers
    // retain genuine overlap without creating a six-writer thundering herd;
    // one ScenarioScope owns and joins every subprocess in all three batches.
    await runScopedScenario(`${prefix}-stress-concurrent`, () =>
      runBoundedScenarioTasks(
        [
          () => exerciseNodeToFicusUnknownRecipient(`${prefix}-stress-concurrent-unknown`),
          () => exerciseNodeToFicusWrongPin(`${prefix}-stress-concurrent-wrong-pin`),
          () => exerciseBidirectionalHints(`${prefix}-stress-concurrent-hints`),
          () => exerciseFicusToNodeWrongPin(`${prefix}-stress-concurrent-reverse-pin`),
          () => exerciseCardlessFetch(`${prefix}-stress-concurrent-cardless`, { scopeCustodyToCasePrefix: true }),
          () => exerciseNodeToFicusAttachment(`${prefix}-stress-concurrent-attachment`),
        ],
        2
      )
    )
  })

  test('seed 11 prefix: attachment settles before cardless whoami with exact custody', async () => {
    const casePrefix = `${prefix}-stress-seed-11-offender`
    const seed11Prefix = ['attachment', 'cardless']
    expect(seed11Prefix).toEqual(['attachment', 'cardless'])
    await runScopedScenario(`${casePrefix}-attachment`, () => exerciseNodeToFicusAttachment(casePrefix))
    await runScopedScenario(`${casePrefix}-cardless`, () => exerciseCardlessFetch(casePrefix))
  })

  test('seeded randomized order', async () => {
    const observedOrders = new Set<string>()
    for (const seed of [11, 29, 47, 83]) {
      const casePrefix = `${prefix}-stress-seed-${seed}`
      const scenarios = [
        { name: 'unknown', exercise: () => exerciseNodeToFicusUnknownRecipient(casePrefix) },
        { name: 'node-wrong-pin', exercise: () => exerciseNodeToFicusWrongPin(casePrefix) },
        { name: 'tau-wrong-pin', exercise: () => exerciseFicusToNodeWrongPin(casePrefix) },
        { name: 'hints', exercise: () => exerciseBidirectionalHints(casePrefix) },
        { name: 'cardless', exercise: () => exerciseCardlessFetch(casePrefix) },
        { name: 'attachment', exercise: () => exerciseNodeToFicusAttachment(casePrefix) },
      ]
      if ((seed & 2) !== 0) scenarios.reverse()
      observedOrders.add(scenarios.map(({ name }) => name).join('->'))
      for (const { name, exercise } of scenarios) await runScopedScenario(`${casePrefix}-${name}`, exercise)
    }
    expect(observedOrders.size).toBe(2)
    const orders = [...observedOrders]
    expect(orders[1]).toBe(orders[0].split('->').reverse().join('->'))
  })
})
