import { DERIVATION_SURFACES, DROP_REASONS, type DerivationEvent } from '@ficus/shared'

const labels = {
  'pull-requests': 'Pull requests',
  'issue-comments': 'Comments',
  reviews: 'Review bodies and inline comments',
  commits: 'Commits',
}
const reasons = {
  date: 'by date',
  repository: 'by repository',
  tool_authored: 'as tool-authored (heuristic)',
  template_or_short: 'as templates or too short',
  surface_limit: 'by surface limit',
  sample_limit: 'by sample limit',
  input_byte_limit: 'by input byte limit',
}
// Control characters must never execute as terminal instructions.
// eslint-disable-next-line no-control-regex
const plain = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
export function formatVoiceProgress(event: DerivationEvent): string[] {
  switch (event.type) {
    case 'phase':
      return [
        {
          collecting: 'Reading GitHub activity.',
          sampling: 'Selecting writing samples.',
          drafting: 'Drafting style observations. Findings appear after validation.',
          validating: 'Validating the draft.',
        }[event.phase],
      ]
    case 'repositories':
      return event.repositories.map((repo) =>
        plain(
          `${{ activity_read: 'Activity read from', reading_commits: 'Reading commits in', commits_read: 'Commits read from', unavailable: 'Not found or not visible', commit_limit: 'Commit limit; not read' }[repo.activity]} ${repo.name}.`
        )
      )
    case 'counts':
      return DERIVATION_SURFACES.map((surface) => {
        const tally = event.bySurface[surface]
        const dropped = DROP_REASONS.reduce((n, reason) => n + tally.dropped[reason], 0)
        const detail = DROP_REASONS.filter((r) => tally.dropped[r])
          .map((r) => `${tally.dropped[r]} ${reasons[r]}`)
          .join(', ')
        return `${labels[surface]}: seen ${tally.seen}, kept ${tally.kept}, dropped ${dropped}${detail ? ` (${detail})` : ''}. ${event.provisional ? 'Counts are provisional.' : 'Sampling finished.'}`
      }).concat(event.pagingCapped ? ['Paging stopped at its limit; older items may exist.'] : [])
    case 'finding':
      return [plain(`Finding: ${event.text}`)]
    default:
      return []
  }
}
export class VoiceDerivationCancelled extends Error {
  constructor(readonly exitCode: 130 | 143) {
    super('Derivation cancelled. Nothing was saved.')
  }
}
interface SignalHandlers {
  on: (name: 'SIGINT' | 'SIGTERM', fn: () => void) => unknown
  off: (name: 'SIGINT' | 'SIGTERM', fn: () => void) => unknown
}
/** Own signal handlers only for this command, including fetch and terminal output. */
export async function withDerivationSignals<T>(
  run: (signal: AbortSignal) => Promise<T>,
  handlers: SignalHandlers = process
): Promise<T> {
  const controller = new AbortController()
  const interrupt = () => controller.abort(new VoiceDerivationCancelled(130))
  const terminate = () => controller.abort(new VoiceDerivationCancelled(143))
  handlers.on('SIGINT', interrupt)
  handlers.on('SIGTERM', terminate)
  const timer = setTimeout(() => controller.abort(new Error('Derivation timed out. Nothing was saved.')), 220_000)
  try {
    const result = await run(controller.signal)
    controller.signal.throwIfAborted()
    return result
  } catch (error) {
    controller.signal.throwIfAborted()
    throw error
  } finally {
    clearTimeout(timer)
    controller.abort()
    handlers.off('SIGINT', interrupt)
    handlers.off('SIGTERM', terminate)
  }
}
