import { Type } from '@sinclair/typebox'
import type { ToolDefinition, AgentToolResult } from '@earendil-works/pi-coding-agent'
import { getSandboxManager } from '../services/sandbox/factory'
import { SandboxHttpError } from '../services/sandbox/client/http-client'
import type { BrowserBackend } from '../services/sandbox/browser-backend'
import type { SandboxToolsManager } from './sandbox-tools'
import { resolveLocalDeploymentBrowserUrl } from '../services/deploy/local-deployment-browser-url'

// --- Types ---

export type BrowserToolWithKey = ToolDefinition & { key: string }

const NO_SANDBOX_ERROR = 'Sandbox is not running — browser tools need the agent sandbox up.'
const LOCAL_DEPLOYMENT_ERROR =
  'Could not open local preview. Check deployment access, current state, APP_URL configuration, and browser connectivity.'

// --- Helper: screenshot as base64 content block ---

function screenshotResult(screenshotBase64: string, extraText?: string): AgentToolResult<unknown> {
  const content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> = []

  if (extraText) {
    content.push({ type: 'text' as const, text: extraText })
  }

  content.push({
    type: 'image',
    data: screenshotBase64,
    mimeType: 'image/png',
  })

  return { content: content as any, details: {} }
}

function errorResult(message: string): AgentToolResult<unknown> {
  return {
    content: [{ type: 'text' as const, text: `Error: ${message}` }],
    details: { error: message },
  }
}

/**
 * Result for click/type/scroll: a screenshot is requested (`returnScreenshot:
 * true`) but a stale (pre-this-branch) box server may ignore that flag and
 * omit `screenshotBase64` entirely. Emitting an empty-string image block is a
 * hard 400 with most model providers and — since the tool result stays in the
 * message list — wedges the whole run. Degrade to text-only instead whenever
 * the screenshot is missing OR empty.
 */
function actionResult(text: string, shot?: string): AgentToolResult<unknown> {
  return shot
    ? screenshotResult(shot, text)
    : { content: [{ type: 'text' as const, text: `${text} (screenshot unavailable)` }], details: {} }
}

/**
 * Maps a failure from a `SandboxClient.browser*` call to the message shown
 * to the agent. `SandboxHttpError` carries the box server's HTTP status/code;
 * connection-level failures (box unreachable) surface as a plain `Error`
 * whose message already reads "Sandbox is not reachable...".
 *
 * `isOpen` distinguishes `browser_open` from the other verbs: an old,
 * pre-Phase-2 box bundle answers ANY unknown route (including `/browser/open`
 * itself) with a plain 404, so folding that into the "no page is open — use
 * browser_open" message would send the agent into a loop retrying its own
 * advice. `browser_open` gets a distinct "stale box" message instead.
 */
function mapBrowserError(err: unknown, isOpen: boolean): string {
  if (err instanceof SandboxHttpError) {
    if (err.code === 'BROWSER_UNAVAILABLE' || err.status === 503) {
      return 'Browser is unavailable on this machine.'
    }
    if (err.status === 404) {
      return isOpen
        ? 'Browser routes are unavailable on this box (stale sandbox server) — the box will gain browser support when it is next recreated.'
        : 'No page is open in this browser session — use browser_open with a URL first.'
    }
    // 429 (rate limit) and any other status: pass the server's message through.
    return err.message
  }
  return err instanceof Error ? err.message : String(err)
}

function getClient(sandboxId: string, getManager: typeof getSandboxManager): BrowserBackend | null {
  const manager = getManager() as unknown as SandboxToolsManager & {
    getBrowserBackend?(sandboxId: string): BrowserBackend | null
  }
  // The host runtime has no box to reach over HTTP — it drives a locally
  // installed browser from the core itself, and exposes it here instead.
  // Not every runtime's manager implements getClientForSandbox either, so a
  // manager with neither returns null and callers hit their normal
  // NO_SANDBOX_ERROR result instead of a raw TypeError.
  return (
    manager.getBrowserBackend?.(sandboxId) ??
    (typeof manager.getClientForSandbox === 'function' ? manager.getClientForSandbox(sandboxId) : null)
  )
}

// --- TypeBox Schemas ---

const BrowserOpenSchema = Type.Object({
  url: Type.Optional(Type.String({ description: 'URL to navigate to. Omit when using localDeploymentId.' })),
  localDeploymentId: Type.Optional(
    Type.String({
      description:
        'Full UUID of an authorized local deployment. Opens its current URL internally without exposing the launch credential. Use instead of url.',
    })
  ),
})

const BrowserClickSchema = Type.Object({
  selector: Type.Optional(Type.String({ description: 'CSS selector to click.' })),
  x: Type.Optional(Type.Number({ description: 'X coordinate to click.' })),
  y: Type.Optional(Type.Number({ description: 'Y coordinate to click.' })),
})

const BrowserTypeSchema = Type.Object({
  text: Type.String({ description: 'Text to type.' }),
  selector: Type.Optional(
    Type.String({
      description: 'CSS selector of input to fill. If omitted, types into the focused element.',
    })
  ),
})

const BrowserScrollSchema = Type.Object({
  direction: Type.Union([Type.Literal('up'), Type.Literal('down')], {
    description: 'Scroll direction.',
  }),
  amount: Type.Optional(Type.Number({ description: 'Pixels to scroll (default 500).' })),
})

const BrowserReadSchema = Type.Object({
  selector: Type.Optional(
    Type.String({
      description: 'CSS selector to read. If omitted, reads the full page visible text.',
    })
  ),
})

// --- Factory ---

/**
 * Builds the 7 browser tools as thin clients over the box server's
 * `/browser/*` routes. The `SandboxClient` is resolved fresh on every call
 * (not captured at factory time) so a sandbox that (re)starts between calls
 * is picked up automatically.
 *
 * @param runId     The calling agent's id — keys the page on the box server
 *                   (one page per (box, runId)).
 * @param sandboxId The agent's sandbox id, resolved by the runner the same
 *                   way it resolves the id for its bash/toolkit wiring.
 */
export function createBrowserTools(
  runId: string,
  sandboxId: string,
  getManager: typeof getSandboxManager = getSandboxManager
): BrowserToolWithKey[] {
  const browserOpen: BrowserToolWithKey = {
    name: 'browser_open',
    key: 'browser_open',
    label: 'Open URL',
    description:
      'Open a URL or an authorized local deployment in the browser. Prefer localDeploymentId for private previews: no credential URL needs to be copied. Returns a screenshot; URL mode also returns the page title.',
    parameters: BrowserOpenSchema,
    async execute(
      _toolCallId: string,
      params: { url?: string; localDeploymentId?: string }
    ): Promise<AgentToolResult<unknown>> {
      const isLocalDeployment = params.localDeploymentId !== undefined
      if ((params.url !== undefined) === isLocalDeployment) {
        return errorResult('Provide exactly one of url or localDeploymentId.')
      }
      const client = getClient(sandboxId, getManager)
      if (!client) return errorResult(NO_SANDBOX_ERROR)
      try {
        const url = isLocalDeployment
          ? await resolveLocalDeploymentBrowserUrl(runId, params.localDeploymentId!)
          : params.url!
        if (!url) return errorResult(isLocalDeployment ? LOCAL_DEPLOYMENT_ERROR : 'URL is required.')
        const res = await client.browserOpen(runId, url)
        // Navigation errors and even page titles can echo location.href. Never
        // reflect the internally resolved capability into the agent transcript.
        return actionResult(
          isLocalDeployment ? 'Local preview opened.' : `Page loaded: "${res.title}" (${params.url})`,
          res.screenshotBase64
        )
      } catch (err) {
        return errorResult(isLocalDeployment ? LOCAL_DEPLOYMENT_ERROR : mapBrowserError(err, true))
      }
    },
  }

  const browserClick: BrowserToolWithKey = {
    name: 'browser_click',
    key: 'browser_click',
    label: 'Click',
    description: 'Click an element by CSS selector or coordinates. Returns a screenshot after clicking.',
    parameters: BrowserClickSchema,
    async execute(
      _toolCallId: string,
      params: { selector?: string; x?: number; y?: number }
    ): Promise<AgentToolResult<unknown>> {
      if (!params.selector && (params.x === undefined || params.y === undefined)) {
        return errorResult('Provide either a selector or x/y coordinates.')
      }
      const client = getClient(sandboxId, getManager)
      if (!client) return errorResult(NO_SANDBOX_ERROR)
      try {
        const res = await client.browserClick(runId, {
          selector: params.selector,
          x: params.x,
          y: params.y,
          returnScreenshot: true,
        })
        return actionResult('Clicked successfully.', res.screenshotBase64)
      } catch (err) {
        return errorResult(mapBrowserError(err, false))
      }
    },
  }

  const browserType: BrowserToolWithKey = {
    name: 'browser_type',
    key: 'browser_type',
    label: 'Type Text',
    description:
      'Type text into an input. If selector is provided, fills that element. Otherwise types into the focused element. Returns a screenshot.',
    parameters: BrowserTypeSchema,
    async execute(_toolCallId: string, params: { text: string; selector?: string }): Promise<AgentToolResult<unknown>> {
      const client = getClient(sandboxId, getManager)
      if (!client) return errorResult(NO_SANDBOX_ERROR)
      try {
        const res = await client.browserType(runId, {
          text: params.text,
          selector: params.selector,
          returnScreenshot: true,
        })
        return actionResult('Typed text successfully.', res.screenshotBase64)
      } catch (err) {
        return errorResult(mapBrowserError(err, false))
      }
    },
  }

  const browserScroll: BrowserToolWithKey = {
    name: 'browser_scroll',
    key: 'browser_scroll',
    label: 'Scroll',
    description: 'Scroll the page up or down. Returns a screenshot.',
    parameters: BrowserScrollSchema,
    async execute(
      _toolCallId: string,
      params: { direction: 'up' | 'down'; amount?: number }
    ): Promise<AgentToolResult<unknown>> {
      const client = getClient(sandboxId, getManager)
      if (!client) return errorResult(NO_SANDBOX_ERROR)
      try {
        const res = await client.browserScroll(runId, {
          direction: params.direction,
          amount: params.amount,
          returnScreenshot: true,
        })
        const fallbackDelta = (params.amount ?? 500) * (params.direction === 'up' ? -1 : 1)
        const deltaPx = Math.abs(res.deltaPx ?? fallbackDelta)
        return actionResult(`Scrolled ${params.direction} ${deltaPx}px.`, res.screenshotBase64)
      } catch (err) {
        return errorResult(mapBrowserError(err, false))
      }
    },
  }

  const browserScreenshot: BrowserToolWithKey = {
    name: 'browser_screenshot',
    key: 'browser_screenshot',
    label: 'Screenshot',
    description: 'Take a screenshot of the current page.',
    parameters: Type.Object({}),
    async execute(): Promise<AgentToolResult<unknown>> {
      const client = getClient(sandboxId, getManager)
      if (!client) return errorResult(NO_SANDBOX_ERROR)
      try {
        const res = await client.browserScreenshot(runId)
        if (!res.screenshotBase64) {
          return errorResult('Screenshot unavailable (the browser service returned no image).')
        }
        return screenshotResult(res.screenshotBase64)
      } catch (err) {
        return errorResult(mapBrowserError(err, false))
      }
    },
  }

  const browserRead: BrowserToolWithKey = {
    name: 'browser_read',
    key: 'browser_read',
    label: 'Read Page',
    description:
      'Read text content from the page. If a selector is provided, reads that element. Otherwise reads all visible text.',
    parameters: BrowserReadSchema,
    async execute(_toolCallId: string, params: { selector?: string }): Promise<AgentToolResult<unknown>> {
      const client = getClient(sandboxId, getManager)
      if (!client) return errorResult(NO_SANDBOX_ERROR)
      try {
        const res = await client.browserRead(runId, params.selector)
        const text = res.text
        // Truncate very long text
        const maxLen = 10000
        const truncated = text.length > maxLen ? text.slice(0, maxLen) + '\n\n... (truncated)' : text
        return {
          content: [{ type: 'text' as const, text: truncated }],
          details: { length: text.length, truncated: text.length > maxLen },
        }
      } catch (err) {
        return errorResult(mapBrowserError(err, false))
      }
    },
  }

  const browserConsole: BrowserToolWithKey = {
    name: 'browser_console',
    key: 'browser_console',
    label: 'Console Logs',
    description: 'Read recent browser console log entries. Useful for debugging JavaScript errors.',
    parameters: Type.Object({}),
    async execute(): Promise<AgentToolResult<unknown>> {
      const client = getClient(sandboxId, getManager)
      if (!client) return errorResult(NO_SANDBOX_ERROR)
      try {
        const res = await client.browserConsole(runId)
        const logs = res.entries
        if (logs.length === 0) {
          return {
            content: [{ type: 'text' as const, text: 'No console entries.' }],
            details: { count: 0 },
          }
        }
        const formatted = logs.map((l) => `[${l.type}] ${l.text}`).join('\n')
        return {
          content: [{ type: 'text' as const, text: formatted }],
          details: { count: logs.length },
        }
      } catch (err) {
        return errorResult(mapBrowserError(err, false))
      }
    },
  }

  return [browserOpen, browserClick, browserType, browserScroll, browserScreenshot, browserRead, browserConsole]
}
