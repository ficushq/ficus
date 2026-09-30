/**
 * The browser surface the browser tools drive, independent of any runtime.
 *
 * Two things satisfy it: `SandboxClient` (box-backed runtimes — the verbs are
 * HTTP calls to the box server's `/browser/*` routes) and the host runtime's
 * in-process backend (`sandbox/host/browser.ts`). Keeping the interface here,
 * next to the result types it uses, lets `types.ts` and `tools/browser.ts`
 * reference it without either of them reaching into a specific runtime.
 *
 * Type-only module: it must stay free of runtime imports.
 */

import type {
  BrowserActionResult,
  BrowserConsoleResult,
  BrowserOpenResult,
  BrowserReadResult,
  BrowserScreenshotResult,
} from './client/http-client'

export interface BrowserBackend {
  browserOpen(runId: string, url: string): Promise<BrowserOpenResult>
  browserClick(
    runId: string,
    opts: { selector?: string; x?: number; y?: number; returnScreenshot?: boolean }
  ): Promise<BrowserActionResult>
  browserType(
    runId: string,
    opts: { text: string; selector?: string; returnScreenshot?: boolean }
  ): Promise<BrowserActionResult>
  browserScroll(
    runId: string,
    opts: { direction: 'up' | 'down'; amount?: number; returnScreenshot?: boolean }
  ): Promise<BrowserActionResult>
  browserScreenshot(runId: string): Promise<BrowserScreenshotResult>
  browserRead(runId: string, selector?: string): Promise<BrowserReadResult>
  browserConsole(runId: string): Promise<BrowserConsoleResult>
  browserClose(runId: string): Promise<{ ok: boolean }>
}
