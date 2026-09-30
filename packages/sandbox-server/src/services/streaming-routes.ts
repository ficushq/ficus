/**
 * Long-lived streaming routes must be exempted from Bun.serve's `idleTimeout`.
 *
 * Bun's idle timer is NOT reset by bytes the server writes: a streaming
 * response is severed `idleTimeout` seconds after the request arrived
 * regardless of how much output it carried (verified on Bun 1.3.8 — SSE
 * comment frames, data frames, 4 KB chunks and direct-stream flushes every
 * 250 ms were all cut at the idle window). With the server at the 255 s
 * maximum, every `/bash` invocation longer than ~255 s — a typecheck, a quiet
 * test suite — lost its stream mid-run: the client saw no terminal frame
 * (BashOutcomeUnknownError), proved cleanup by killing the still-running
 * command, and the agent re-issued it. The command's own `timeoutSeconds`
 * never fired because the transport died first.
 *
 * On TCP, `server.timeout(req, 0)` disables the idle timer for that one request; the
 * invocation's own `timeoutSeconds` (enforced in services/bash.ts) remains the
 * bound on its lifetime. Bun ignores this per-request override on Unix sockets
 * (reproduced on 1.2.23 and 1.3.8), so VM listeners must disable it globally.
 */

/** Routes whose response is a stream that legitimately outlives the idle window. */
export const LONG_LIVED_STREAM_ROUTES: ReadonlySet<string> = new Set(['/bash'])

export function sandboxListenerIdleTimeout(unixSocket: boolean): number {
  return unixSocket ? 0 : 255
}

export interface IdleTimeoutServer {
  timeout(request: Request, seconds: number): void
}

/**
 * Exempt `req` from the server idle timeout when `pathname` is a long-lived
 * streaming route. Returns whether an exemption was applied.
 */
export function exemptLongLivedStreamFromIdleTimeout(
  server: IdleTimeoutServer,
  req: Request,
  pathname: string
): boolean {
  if (!LONG_LIVED_STREAM_ROUTES.has(pathname)) return false
  server.timeout(req, 0)
  return true
}
