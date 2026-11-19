import { allCalls, allOf, endsWithChatQuestion, fail, finalText, type Trace, type Verdict } from './define'
import { executedCommands } from './shell-commands'
import { parseRequesterCommand } from './requester-options'

/** Noah authorized this executable/flag-scoped correction on 2026-11-19. The goal is unchanged. */
export function gradeRequester(trace: Trace, requester: string, forbiddenReviewers: string[]): Verdict {
  let created = false
  let correctReviewer = false
  let wrongReviewer = false
  const createdIds = new Set<string>()
  for (const call of allCalls(trace)) {
    if (!['bash', 'squad_bash'].includes(call.name)) continue
    const commands = executedCommands(String(call.args.command ?? ''))
    for (const raw of commands) {
      const request = parseRequesterCommand(raw)
      if (!request) continue
      const create = request.action === 'create'
      const update = request.action === 'update' && createdIds.has(request.target ?? '')
      if (!create && !update) continue
      if (/^Error:|^error:/m.test(call.result)) continue
      if (create) {
        created = true
        // A shell result does not label each command's stdout. Bind follow-up updates only when
        // this call contains the create alone and one whole creation result. Compound or mixed
        // output is ambiguous: an inspection must never donate its identity to the new stream.
        if (commands.length === 1) {
          try {
            const value: unknown = JSON.parse(call.result)
            if (value && typeof value === 'object' && !Array.isArray(value)) {
              if ('id' in value && typeof value.id === 'string') createdIds.add(value.id)
              if ('number' in value && typeof value.number === 'number') createdIds.add(String(value.number))
            }
          } catch {
            const match = /^Created work stream #(\d+) \(([^)]+)\)$/.exec(call.result.trim())
            if (match) {
              createdIds.add(match[1]!)
              createdIds.add(match[2]!)
            }
          }
        }
      }
      if (update && (request.clearReviewers || request.reviewers.length))
        correctReviewer = request.reviewers.includes(requester)
      for (const reviewer of request.reviewers) {
        if (reviewer === requester) correctReviewer = true
        if (reviewer && forbiddenReviewers.includes(reviewer)) wrongReviewer = true
      }
    }
  }
  if (!created)
    return endsWithChatQuestion(finalText(trace))
      ? fail('Asked in chat instead of reading the sender metadata.')
      : fail('Did not create the work stream.')
  return allOf(
    "Made the message's sender, from its metadata, the reviewer.",
    [!wrongReviewer, 'Used the wrong identity (another sender, or its own) as the reviewer.'],
    [correctReviewer, 'Did not set the requester as reviewer by user id.']
  )
}
