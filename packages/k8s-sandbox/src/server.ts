/**
 * Tool Executor HTTP Server
 *
 * Entry point for the sandbox pod. Runs inside each K8s pod and provides:
 * - POST /bash     — Command execution (streaming response via SSE)
 * - POST /read     — Read file
 * - POST /write    — Write file
 * - POST /mkdir    — Create directory (recursive)
 * - POST /list     — List directory
 * - POST /stat     — File/directory stat
 * - GET  /shell    — Interactive PTY via WebSocket upgrade
 * - GET  /healthz  — Health check for K8s probes
 *
 * On startup:
 * 1. Start HTTP server on configured port (so /healthz is up immediately)
 * 2. Start dockerd in the background if running under sysbox (no socket mounted)
 *
 * Agent intelligence stays in Ficus Core — this service only executes tools.
 */

import './boot/legacy-env'
import { chmod, mkdir, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { isAuthorized, loadExecutorAuthToken } from './services/auth'
import { handleBrowserProxy } from './services/browser-proxy'
import { ensureDocker } from './docker'
import {
  cancelBashInvocation,
  handleBash,
  hasActiveBashInvocations,
  reconcileBashInvocations,
  terminateAllBashInvocations,
} from './services/bash'
import {
  IdleExitCoordinator,
  beginRequestOrDrainingResponse,
  idleExitCheckIntervalMs,
  resolveIdleExitWindowMs,
} from './services/idle-exit'
import {
  countOwnServiceCgroupChildren,
  formatDetachedProcessWarning,
  isServiceCgroupManaged,
} from './services/service-cgroup'
import {
  handleRead,
  handleUpload,
  handleWrite,
  handleVerifiedWrite,
  handleMkdir,
  handleList,
  handleStat,
  handleMaterializeAttachment,
  handleDeleteMaterializedAttachment,
} from './services/filesystem'
import {
  BoxProcessError,
  listBoxContainers,
  listBoxProcesses,
  readPressure,
  signalBoxProcess,
  stopBoxContainer,
} from './services/processes'
import {
  cacheManagedToolchainEnv,
  ManagedToolchainTimeoutError,
  prepareDevboxShellEnv,
  selfCacheDevboxEnvOnBoot,
} from './services/devbox-env'
import { getHealthResponse, setDevboxReady } from './services/health'
import { handleShell } from './services/shell'
import { WorkspaceWatcher } from './services/watcher'
import { exemptLongLivedStreamFromIdleTimeout, sandboxListenerIdleTimeout } from './services/streaming-routes'

const watcher = new WorkspaceWatcher(process.env.WORKSPACE_PATH || '/workspace')

const PORT = Number(process.env.EXECUTOR_PORT || '50051')
// Bind address. k8s pods are reached over pod networking, so the default stays
// 0.0.0.0; VM boxes are only ever reached through an SSH -L forward that
// connects to 127.0.0.1 ON the machine, so their server.env sets
// EXECUTOR_BIND=127.0.0.1. That bind removes OFF-MACHINE exposure only
// (defense-in-depth): every process on the machine shares the loopback
// interface regardless of uid, so a co-located box CAN still connect to a
// sibling's 127.0.0.1:<port>. Cross-box isolation on a shared machine rests
// ENTIRELY on the EXECUTOR_AUTH_TOKEN bearer check below.
const BIND = process.env.EXECUTOR_BIND || '0.0.0.0'
// Socket-activated VM box (box-provision.sh's `<prefix>.socket` +
// systemd-socket-proxyd): when set, the server listens on THIS unix socket
// instead of a TCP hostname/port, and `systemd-socket-proxyd` — which owns the
// box's 127.0.0.1:<port> — forwards to it. Unset everywhere else (k8s pods and
// docker sandboxes are reached directly over TCP), so their listen is unchanged.
const SOCKET_PATH = process.env.EXECUTOR_SOCKET || ''
// Idle self-exit window. Forced OFF without a unix socket: a k8s/docker server
// that exited would simply be gone, with nothing to re-activate it. See
// services/idle-exit.ts for the policy and the measurement that motivated it.
const IDLE_EXIT_MS = resolveIdleExitWindowMs({ socketPath: SOCKET_PATH, raw: process.env.EXECUTOR_IDLE_EXIT_MS })
// Set only by the pinned systemd units' ExecStart switch (`--service-cgroup`,
// the authoritative marker — environment files cannot override argv) and,
// transitionally, the pre-flag units' EXECUTOR_SERVICE_CGROUP=1 value. Direct
// TCP/k8s execution must never assume systemd will clean this process's
// cgroup after a clean exit.
const SERVICE_CGROUP_MANAGED = isServiceCgroupManaged()
// Optional per-box auth token (VM runtime). When set, every route except
// GET /healthz requires `Authorization: Bearer <token>` (see services/auth.ts).
// k8s pods never set it, so enforcement is off there.
const AUTH_TOKEN = loadExecutorAuthToken()

// Fail closed in VM mode: on a VM the bearer token is the ONLY cross-box
// boundary (see above), so booting without one would serve an unauthenticated
// executor to every co-located box. Two markers identify a VM boot — k8s and
// docker set neither:
//  - EXECUTOR_BIND — pushed in the box's server.env (catches a partial/
//    malformed env that carries the bind but lost the token, or a
//    machine-global bind);
//  - FICUS_BOX_PORT — baked as `Environment=` into the box's systemd unit
//    itself by box-provision.sh, so it is present even when server.env has
//    not landed yet. This closes the fresh-provision window: a unit started
//    before the env push used to stay shut only by accident (the bun-pty
//    dlopen of BUN_PTY_LIB, also server.env-only, crashed the import first).
// Refusing to serve makes the guarantee explicit and independent of loader
// behavior; k8s/docker (neither marker) keep the legacy no-enforcement path.
if ((process.env.EXECUTOR_BIND || process.env.FICUS_BOX_PORT || process.env.EXECUTOR_DOCKER_RUNTIME) && !AUTH_TOKEN) {
  console.error(
    '[sandbox] FATAL: VM sandbox server requires EXECUTOR_AUTH_TOKEN when EXECUTOR_BIND or ' +
      'FICUS_BOX_PORT is set; refusing to start unauthenticated'
  )
  process.exit(1)
}
const MAX_BODY = 100 * 1024 * 1024 // 100MB
const INVALID_JSON_BODY_MESSAGE = 'Invalid JSON body'
const JSON_BODY_PATHS = new Set([
  '/toolchain-ready',
  '/processes',
  '/processes/signal',
  '/containers/stop',
  '/bash',
  '/bash/cancel',
  '/read',
  '/write',
  '/write-verified',
  '/mkdir',
  '/materialize-attachment',
  '/delete-materialized-attachment',
  '/list',
  '/stat',
  '/watch',
  '/browser/open',
  '/browser/click',
  '/browser/type',
  '/browser/scroll',
  '/browser/screenshot',
  '/browser/read',
  '/browser/console',
  '/browser/close',
])

class MalformedJsonBodyError extends Error {
  constructor(cause: SyntaxError) {
    super(INVALID_JSON_BODY_MESSAGE, { cause })
    this.name = 'MalformedJsonBodyError'
  }
}

async function parseJsonRequestBody(req: Request): Promise<any> {
  try {
    return await req.json()
  } catch (error) {
    if (error instanceof SyntaxError) throw new MalformedJsonBodyError(error)
    throw error
  }
}

const log = (msg: string) => console.log(`[sandbox] ${msg}`)

async function main(): Promise<void> {
  log('Starting sandbox...')
  const bootStart = performance.now()
  const profile = (section: string, since: number) =>
    log(`[profile] ${section} ${Math.round(performance.now() - since)}ms`)

  // Step 1: Start the HTTP server first so /healthz (the readiness/startup probe
  // target) is up immediately — do NOT block pod-ready on dockerd cold-start.
  // Health starts promptly, but bash admission waits for durable cleanup.
  let bashReconciliationSettled = false
  const bashReady = reconcileBashInvocations()
    .then((report) => {
      if (report.quarantined.length)
        log(
          `Bash reconciliation degraded: quarantined=${report.quarantined.length} keys=${report.quarantined.join(',')}`
        )
      return report
    })
    .finally(() => {
      bashReconciliationSettled = true
    })
  // Unix-socket listen (socket-activated VM box) or the legacy TCP listen.
  // A stale socket file survives a crash/SIGKILL and would make bind() fail, so
  // unlink it first — systemd has already torn down any predecessor by the time
  // this unit's ExecStart runs, so nothing live can own it.
  if (SOCKET_PATH) {
    await mkdir(dirname(SOCKET_PATH), { recursive: true }).catch(() => {})
    await unlink(SOCKET_PATH).catch(() => {})
  }
  // The cast is about Bun's TYPES only: they declare `idleTimeout?: never`
  // alongside `unix`, but a unix listener without it silently inherits Bun's
  // 10s request timeout (measured on 1.3.8: a 20s-quiet response stream is
  // killed with "request timed out after 10 seconds"), which would cut every
  // long-running /bash SSE stream. The runtime accepts and honors idleTimeout
  // on a unix listener; only the declaration disallows it.
  const listen = (SOCKET_PATH ? { unix: SOCKET_PATH } : { hostname: BIND, port: PORT }) as {
    hostname?: string
    port?: number
  }

  // Idle self-exit bookkeeping. `lastActivityAt` is bumped on EVERY fetch
  // (including /healthz — a health probe is Core talking to this box) and every
  // websocket message; `openShells` counts live /shell upgrades.
  const bootedAt = Date.now()
  let lastActivityAt = bootedAt
  let openShells = 0
  const idleCoordinator = new IdleExitCoordinator({
    bootedAt,
    lastActivityAt,
    windowMs: IDLE_EXIT_MS,
  })

  const server = Bun.serve({
    ...listen,
    maxRequestBodySize: MAX_BODY,
    // Unix listeners ignore server.timeout(req, 0), so their listener timeout
    // must be disabled. TCP retains its timeout with per-request exemptions.
    // Bash deadlines and the idle self-exit coordinator still bound commands
    // and unused boxes independently of the HTTP listener.
    idleTimeout: sandboxListenerIdleTimeout(Boolean(SOCKET_PATH)),

    async fetch(req, server) {
      // This synchronous reservation is the first operation in fetch. It closes
      // the gap before body parsing, Docker readiness, registry acquire, or spawn.
      const requestAt = Date.now()
      const admission = beginRequestOrDrainingResponse(idleCoordinator, requestAt)
      if (admission instanceof Response) return admission
      const requestReservation = admission
      lastActivityAt = requestAt
      let bashReservationTransferred = false
      try {
        const url = new URL(req.url)
        const { pathname } = url
        exemptLongLivedStreamFromIdleTimeout(server, req, pathname)

        // Health check — exempt from the auth gate (readiness probes run
        // unauthenticated; health exposes no execution/file surface).
        if (pathname === '/healthz' && req.method === 'GET') {
          return Response.json(getHealthResponse())
        }

        // Auth gate for EVERYTHING else (including the /shell WS upgrade, whose
        // headers arrive on this same fetch before server.upgrade). Enforcement
        // is conditional on EXECUTOR_AUTH_TOKEN being configured.
        if (!isAuthorized(req.headers, AUTH_TOKEN)) {
          return new Response('Unauthorized', { status: 401 })
        }

        // Devbox ready signal (called by background entrypoint process)
        if (pathname === '/devbox-ready' && req.method === 'POST') {
          const ready = prepareDevboxShellEnv()
          setDevboxReady(ready)
          return Response.json({ ok: ready }, { status: ready ? 200 : 503 })
        }

        // WebSocket upgrade for shell
        if (pathname === '/shell' && req.method === 'GET') {
          const upgraded = server.upgrade(req)
          if (!upgraded) {
            return new Response('WebSocket upgrade failed', { status: 400 })
          }
          return undefined as unknown as Response
        }

        // GET /watch — watcher status
        if (req.method === 'GET' && pathname === '/watch') {
          return Response.json(watcher.getStatus())
        }

        // DELETE /watch — stop watching
        if (req.method === 'DELETE' && pathname === '/watch') {
          await watcher.stop()
          return Response.json({ ok: true })
        }

        // All other routes are POST with JSON body
        if (req.method !== 'POST') {
          return new Response('Method not allowed', { status: 405 })
        }

        try {
          // These routes intentionally have no JSON request body. Classify them
          // before parsing so malformed ignored bytes cannot change their contract.
          if (pathname === '/watch/rescan') {
            const result = await watcher.rescan()
            return Response.json({ ok: true, ...result })
          }
          // Raw-body upload (application/octet-stream, params in the query
          // string) — the large-file transport; see handleUpload's doc. Bounded
          // by maxRequestBodySize like everything else, but with no base64/JSON
          // envelope inflating the payload by a third.
          if (pathname === '/upload') {
            return handleUpload(url, req)
          }
          if (!JSON_BODY_PATHS.has(pathname)) {
            return new Response('Not found', { status: 404 })
          }

          let body: any
          try {
            body = await parseJsonRequestBody(req)
          } catch (error) {
            if (error instanceof MalformedJsonBodyError) {
              return Response.json({ error: INVALID_JSON_BODY_MESSAGE }, { status: 400 })
            }
            return Response.json({ error: 'Failed to read request body' }, { status: 500 })
          }

          switch (pathname) {
            case '/toolchain-ready':
              try {
                const fingerprint = typeof body.fingerprint === 'string' ? body.fingerprint : undefined
                const result = await cacheManagedToolchainEnv(body.active !== false, fingerprint)
                return Response.json({ ok: true, result })
              } catch (error) {
                if (error instanceof ManagedToolchainTimeoutError) {
                  return Response.json({ error: error.message, code: 'timeout' }, { status: 504 })
                }
                return Response.json({ error: 'Managed toolchain activation failed' }, { status: 500 })
              }
            case '/processes':
              return Response.json({
                pressure: readPressure(),
                processes: await listBoxProcesses(),
                containers: await listBoxContainers(),
              })
            case '/processes/signal':
            case '/containers/stop':
              try {
                return Response.json(
                  pathname === '/processes/signal'
                    ? signalBoxProcess(body.pid, body.signal)
                    : await stopBoxContainer(body.id)
                )
              } catch (error) {
                if (error instanceof BoxProcessError) {
                  return Response.json({ error: error.message }, { status: error.status })
                }
                throw error
              }
            case '/bash': {
              await bashReady
              const response = handleBash(body, undefined, { onAdmissionFenced: requestReservation.release })
              bashReservationTransferred = true
              return response
            }
            case '/bash/cancel': {
              await bashReady
              if (typeof body.invocationId !== 'string' || !body.invocationId) {
                return Response.json({ error: 'invocationId is required' }, { status: 400 })
              }
              return Response.json(
                await cancelBashInvocation(body.invocationId, typeof body.reason === 'string' ? body.reason : undefined)
              )
            }
            case '/read':
              return handleRead(body)
            case '/write':
              return handleWrite(body)
            case '/write-verified':
              return handleVerifiedWrite(body)
            case '/mkdir':
              return handleMkdir(body)
            case '/materialize-attachment':
              return handleMaterializeAttachment(body)
            case '/delete-materialized-attachment':
              return handleDeleteMaterializedAttachment(body)
            case '/list':
              return handleList(body)
            case '/stat':
              return handleStat(body)
            case '/browser/open':
            case '/browser/click':
            case '/browser/type':
            case '/browser/scroll':
            case '/browser/screenshot':
            case '/browser/read':
            case '/browser/console':
            case '/browser/close':
              return handleBrowserProxy(pathname, body, AUTH_TOKEN)
            case '/watch': {
              log(`Watch start requested: include=${JSON.stringify(body.include)}, squadId=${body.squadId}`)
              const result = await watcher.start(body)
              log(`Watch started: ${result.fileCount} files, ${result.skipped.length} skipped`)
              return Response.json({ ok: true, ...result })
            }
            default:
              return new Response('Not found', { status: 404 })
          }
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : `Unknown error: ${String(err)}`
          return new Response(message, { status: 400 })
        }
      } finally {
        if (!bashReservationTransferred) requestReservation.release()
      }
    },

    websocket: {
      open(ws) {
        openShells += 1
        lastActivityAt = Date.now()
        idleCoordinator.noteActivity(lastActivityAt)
        handleShell(ws)
      },
      message(ws, message) {
        lastActivityAt = Date.now()
        idleCoordinator.noteActivity(lastActivityAt)
        // Messages are handled by the shell handler via ws.data
        const handler = (ws as any)._shellHandler as ((msg: string | Buffer) => void) | undefined
        if (handler) {
          handler(typeof message === 'string' ? message : Buffer.from(message))
        }
      },
      close(ws) {
        openShells = Math.max(0, openShells - 1)
        lastActivityAt = Date.now()
        idleCoordinator.noteActivity(lastActivityAt)
        const cleanup = (ws as any)._shellCleanup as (() => void) | undefined
        if (cleanup) cleanup()
      },
    },
  })

  if (SOCKET_PATH) {
    // Both the server and systemd-socket-proxyd run as the box user, so the
    // default perms already suffice; narrowing to 0660 keeps the executor's
    // unauthenticated-on-the-socket surface off every OTHER user on the host
    // (the bearer check is still the real boundary — see BIND's note).
    try {
      await chmod(SOCKET_PATH, 0o660)
    } catch (err) {
      log(`WARN: could not chmod ${SOCKET_PATH}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  log(
    `HTTP server listening on ${SOCKET_PATH ? `unix:${SOCKET_PATH}` : `${BIND}:${server.port}`}${
      AUTH_TOKEN ? ' (token auth enforced)' : ''
    }`
  )
  profile('http-listen', bootStart)

  // VM box only: nothing POSTs /devbox-ready (the systemd unit execs the server
  // directly, no entrypoint), so self-cache the seeded devbox shellenv at boot so
  // a plain /bash PATH includes the comfort set (rg/fd/gh). Gated on FICUS_BOX_HOME
  // (+ a packaged devbox.json), so this is a NO-OP on k8s/docker — boot stays
  // byte-identical there.
  if (selfCacheDevboxEnvOnBoot()) setDevboxReady(true)

  // Step 2: Bring up dockerd in the background (sysbox mode), unless this is an
  // agent (light) box — those are minimal and never run docker. Commands that
  // need docker await readiness lazily; pod-readiness is not gated on it.
  if (process.env.FICUS_SANDBOX_ROLE === 'agent') {
    log('Docker: skipped (agent role)')
  } else {
    const dockerStart = performance.now()
    ensureDocker()
      .then((ok) => {
        profile('ensureDocker', dockerStart)
        log(ok ? 'Docker: available' : 'Docker: not available')
      })
      .catch((err) => log(`Docker: failed to start: ${err instanceof Error ? err.message : String(err)}`))
  }

  // Idle self-exit (socket-activated VM boxes only). Admission and drain are
  // serialized by IdleExitCoordinator. Unsupported residual children are only
  // counted here; the pinned systemd KillMode owns lifecycle cleanup.
  if (IDLE_EXIT_MS > 0) {
    const idleTimer = setInterval(() => {
      const now = Date.now()
      const claim = idleCoordinator.tryBeginExit({
        now,
        activeInvocations: hasActiveBashInvocations(),
        openShells,
        watcherActive: watcher.getStatus().active,
        reconciliationSettled: bashReconciliationSettled,
      })
      if (!claim) return
      void (async () => {
        try {
          const childCount = SERVICE_CGROUP_MANAGED ? await countOwnServiceCgroupChildren() : 0
          if (childCount > 0) console.warn(formatDetachedProcessWarning(childCount))
          clearInterval(idleTimer)
          log(`idle for ${Math.round((now - lastActivityAt) / 1000)}s, exiting`)
          server.stop(false)
          process.exit(0)
        } catch {
          claim.abort()
          log('WARN: idle exit deferred because service cgroup child count is unavailable')
        }
      })()
    }, idleExitCheckIntervalMs(IDLE_EXIT_MS))
    // Never keep the process alive on the timer alone.
    idleTimer.unref?.()
    log(`Idle self-exit armed: ${IDLE_EXIT_MS}ms`)
  }

  // Graceful shutdown
  let shutdownPromise: Promise<void> | undefined
  const shutdown = () => {
    shutdownPromise ??= (async () => {
      log('Shutting down...')
      server.stop(false)
      await bashReady
      await terminateAllBashInvocations()
      process.exit(0)
    })()
    void shutdownPromise.catch((error) => {
      console.error('Bash shutdown cleanup failed:', error)
      process.exit(1)
    })
  }

  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
