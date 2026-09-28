import {
  createSyntheticSourceInfo,
  type CompactionResult,
  type Extension,
  type SessionBeforeCompactEvent,
} from '@earendil-works/pi-coding-agent'
import type { PrecompactionController } from './controller'

/**
 * Build a programmatic pi `Extension` that injects a pre-computed compaction
 * result into pi's `session_before_compact` hook.
 *
 * Precedence: baked cache result (from `getController`) → on-demand fit
 * fallback (from `getFitFallback`, #625) → `undefined` so pi compacts
 * synchronously (today's behavior). The fit fallback runs even when the
 * controller is absent (ephemeral / `precompaction: false` sessions), because
 * those sessions can still hit an oversized synchronous compaction.
 *
 * Both getters are read lazily on every hook fire so the extension can be
 * constructed before the controller/fallback exist (they are set right after
 * the pi session is created). The extension is otherwise inert: no tools,
 * commands, or other handlers.
 */
export function createPrecompactionExtension(
  getController: () => PrecompactionController | undefined,
  getFitFallback?: () => ((event: SessionBeforeCompactEvent) => Promise<CompactionResult | undefined>) | undefined
): Extension {
  const handler = async (event: SessionBeforeCompactEvent) => {
    const controller = getController()
    const baked = controller ? await controller.awaitReadyResult(event) : undefined
    if (baked) return { compaction: baked }
    // Cache miss (or no controller): give the fit fallback a chance to
    // summarize with a summarizer that fits the current window (#625) before
    // pi compacts synchronously with the possibly-too-small current model.
    const fitFallback = getFitFallback?.()
    if (!fitFallback) return undefined
    // Defense in depth: fitFallback is documented as resolving `undefined` on
    // any failure, but a hook that throws instead of resolving must not take
    // down pi's compaction path — fall through to pi's synchronous compaction.
    let compaction: CompactionResult | undefined
    try {
      compaction = await fitFallback(event)
    } catch {
      return undefined
    }
    return compaction ? { compaction } : undefined
  }

  return {
    path: 'ficus:precompaction',
    resolvedPath: 'ficus:precompaction',
    sourceInfo: createSyntheticSourceInfo('ficus:precompaction', {
      source: 'ficus',
      scope: 'temporary',
      origin: 'top-level',
    }),
    // pi's HandlerFn is `(...args: unknown[]) => Promise<unknown>`; our typed
    // handler is structurally compatible, cast to satisfy the map value type.
    handlers: new Map([['session_before_compact', [handler]]]) as Extension['handlers'],
    tools: new Map(),
    messageRenderers: new Map(),
    commands: new Map(),
    flags: new Map(),
    shortcuts: new Map(),
  }
}
