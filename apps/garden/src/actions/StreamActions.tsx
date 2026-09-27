import type { WorkStream } from '@ficus/shared'
import { StreamQuestionWait } from './AgentQuestions'
import { PauseControls } from './PauseControls'
import { ReviewForm } from './ReviewForm'
import { UnblockForm } from './UnblockForm'
import { WorkflowDecision } from './WorkflowDecision'

/**
 * Everything a person can do on one plot, in the order the web's work stream
 * detail shows it: the cloche (pause), workflow decisions, the top review or
 * manual wait, then question waits answerable in place.
 */
export function StreamActions({
  stream,
  showPauseControls = true,
  onOpenAgent,
}: {
  stream: WorkStream
  showPauseControls?: boolean
  onOpenAgent?: (agentId: string) => void
}) {
  const openWaits = stream.openWaits ?? []
  // The server sorts open waits by display precedence; review beats manual.
  const callout = openWaits.find((wait) => wait.type === 'review') ?? openWaits.find((wait) => wait.type === 'manual')
  const needsResponse = !!callout && callout.resolutionHandler !== 'workflow'
  const questionWaits = openWaits.filter((wait) => wait.type === 'question')
  const terminal = stream.status === 'done' || stream.status === 'canceled'

  return (
    <div className="g-action">
      <WorkflowDecision workStreamId={stream.id} stream={stream} onOpenAgent={onOpenAgent} />
      {needsResponse && callout.type === 'review' && (
        <ReviewForm
          workStreamId={stream.id}
          squadId={stream.squadId}
          wait={callout}
          completionMode={stream.completionMode}
          message={callout.message ?? stream.handoffMessage}
          onOpenAgent={onOpenAgent}
        />
      )}
      {needsResponse && callout.type === 'manual' && (
        <UnblockForm workStreamId={stream.id} squadId={stream.squadId} wait={callout} onOpenAgent={onOpenAgent} />
      )}
      {questionWaits.map((wait) => (
        <StreamQuestionWait key={wait.id} wait={wait} onOpenAgent={onOpenAgent} />
      ))}
      {/* The decision comes first; pausing is the quieter, secondary control. */}
      {showPauseControls && !terminal && <PauseControls stream={stream} />}
    </div>
  )
}
