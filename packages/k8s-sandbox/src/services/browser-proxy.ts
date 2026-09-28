/**
 * `/browser/*` pass-through to the machine's tau-browser socket.
 *
 * The box server does not interpret browser verbs at all — it forwards the
 * already-authenticated request body to the per-machine `tau-browser`
 * service over its unix socket, identifying itself as this box's own unix
 * user (`x-ficus-box-user`, and for the cutover window the pre-Ficus name
 * too) with the box's own EXECUTOR_AUTH_TOKEN as the bearer (R-B3: "the
 * same secret the box already holds"). The upstream
 * status + JSON body are mirrored back verbatim in both directions.
 *
 * When the socket is absent or unreachable (no tau-browser service on this
 * machine — Phase 1's fail-open capability state), callers get a structured
 * 503 that Phase 3's tool turns into the browser-unavailable tool error.
 */

import { userInfo } from 'node:os'
import { boxUserHeaders } from '@ficus/shared/box-user'

const DEFAULT_SOCK = '/run/tau-browser/sock'

/**
 * Forward one already-parsed JSON body to the tau-browser socket and mirror
 * its response back verbatim (status + JSON body). `pathname` is the
 * incoming `/browser/<verb>` request path.
 */
export async function handleBrowserProxy(
  pathname: string,
  body: unknown,
  authToken: string | undefined
): Promise<Response> {
  const sock = process.env.FICUS_BROWSER_SOCK || DEFAULT_SOCK
  const subpath = pathname.slice('/browser'.length) // '/open', '/click', ...

  let upstream: Response
  try {
    upstream = await fetch(`http://tau-browser${subpath}`, {
      unix: sock,
      method: 'POST',
      headers: {
        // K3: every box-user name, for browser services on older machine images.
        ...boxUserHeaders(userInfo().username),
        authorization: `Bearer ${authToken ?? ''}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })
  } catch {
    // Socket missing/ENOENT, connection refused, etc. — no tau-browser
    // service reachable on this machine. Pass-through only, so this is the
    // one case the proxy interprets itself.
    return Response.json({ error: 'browser unavailable on this machine', code: 'BROWSER_UNAVAILABLE' }, { status: 503 })
  }

  const responseBody = await upstream.text()
  return new Response(responseBody, {
    status: upstream.status,
    headers: { 'content-type': upstream.headers.get('content-type') || 'application/json' },
  })
}
