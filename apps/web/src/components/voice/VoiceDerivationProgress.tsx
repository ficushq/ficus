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
export function VoiceDerivationProgress({
  phase,
  tallyAnnouncement,
  elapsed,
  counts,
  history,
  omitted,
  isPending,
  cancel,
}: {
  phase: string
  tallyAnnouncement: string
  elapsed: number
  counts?: Extract<DerivationEvent, { type: 'counts' }>
  history: string[]
  omitted: boolean
  isPending: boolean
  cancel: () => void
}) {
  return (
    <section aria-label="Voice derivation progress" className="space-y-2 text-xs text-secondary">
      <p role="status" aria-live="polite">
        <span>{phase}</span> {isPending && <span>{tallyAnnouncement}</span>}
      </p>
      {isPending && <p>{elapsed} seconds elapsed.</p>}
      {isPending && (
        <button className="ficus-button ficus-button-secondary px-3 py-1" onClick={cancel}>
          Cancel
        </button>
      )}
      {counts && (
        <>
          <p>{counts.provisional ? 'Counts are provisional until sampling finishes.' : 'Sampling finished.'}</p>
          <div className="overflow-x-auto">
            <table className="ficus-table w-full text-left text-xs">
              <caption className="text-left text-xs">Writing candidates, not all GitHub contributions</caption>
              <thead>
                <tr>
                  <th className="py-1 pr-3 align-top">Surface</th>
                  <th className="py-1 pr-3 align-top">Seen</th>
                  <th className="py-1 pr-3 align-top">Kept</th>
                  <th className="py-1 pr-3 align-top">Dropped, by reason</th>
                </tr>
              </thead>
              <tbody>
                {DERIVATION_SURFACES.map((surface) => {
                  const tally = counts.bySurface[surface]
                  return (
                    <tr key={surface}>
                      <th scope="row" className="py-1 pr-3 align-top">
                        {labels[surface]}
                      </th>
                      <td className="py-1 pr-3 align-top">{tally.seen}</td>
                      <td className="py-1 pr-3 align-top">{tally.kept}</td>
                      <td className="py-1 pr-3 align-top">
                        {DROP_REASONS.filter((reason) => tally.dropped[reason])
                          .map((reason) => `${tally.dropped[reason]} ${reasons[reason]}`)
                          .join(', ') || '0'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {counts.pagingCapped && <p>Paging stopped at its limit; older items may exist.</p>}
        </>
      )}
      {history.length > 0 && (
        <div className="max-h-48 overflow-auto break-words">
          <h5>Activity and validated findings</h5>
          {omitted && <p>Older activity lines are omitted.</p>}
          <ul>
            {history.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
