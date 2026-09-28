import { QuestionData } from '@ficus/shared'
import { getErrorSystemMessage } from '../../lib/error'

/**
 * The outcome of classifying an execution failure: the system message to
 * record (if any) and the agent disposition it routes to.
 *
 * Extracted verbatim from `Execution.fail` (see entities/Execution.ts) so the
 * question-building policy for rate-limit / all-providers-exhausted failures
 * lives in one place, independent of the entity's transactional write.
 */
export interface FailureRoute {
  /** Recorded as an assistant system message when non-null. */
  systemMessage: string | null
  disposition: { status: 'idle' } | { status: 'waiting-input'; questionData: QuestionData }
}

/**
 * Classify an execution failure error string into a {@link FailureRoute}.
 *
 * Three routes, verbatim from today's `Execution.fail`:
 * - Rate limit / plan credit / overloaded / auth errors (via
 *   `getErrorSystemMessage`) → waiting-input with a `rate_limit` question.
 * - "provider exhausted" errors (ModelSelectionError from selectModelSpec) →
 *   waiting-input with an `all_providers_exhausted` question.
 * - Everything else → idle, with a generic `[System] Execution failed: …`
 *   message.
 */
export function routeFailure(error: string): FailureRoute {
  const systemMessage = getErrorSystemMessage(error)
  if (systemMessage) {
    return {
      systemMessage,
      disposition: {
        status: 'waiting-input',
        questionData: {
          questions: [
            {
              id: 'rate_limit',
              type: 'select',
              question: systemMessage.replace('[System]', '').trim(),
              optional: false,
              options: [{ value: 'Continue', label: 'Continue' }],
            },
          ],
        },
      },
    }
  } else if (error.includes('provider exhausted')) {
    // All providers exhausted (ModelSelectionError from selectModelSpec). Route
    // to waiting-input with a clear message so the user can retry after
    // cooldowns expire, rather than a generic idle error.
    const message = '[System] All configured providers are currently exhausted. Try again later.'
    return {
      systemMessage: message,
      disposition: {
        status: 'waiting-input',
        questionData: {
          questions: [
            {
              id: 'all_providers_exhausted',
              type: 'select',
              question: 'All configured providers are currently exhausted. Try again later.',
              optional: false,
              options: [{ value: 'Continue', label: 'Continue' }],
            },
          ],
        },
      },
    }
  } else {
    return {
      systemMessage: `[System] Execution failed: ${error}`,
      disposition: { status: 'idle' },
    }
  }
}
