import { allCalls, allOf, endsWithChatQuestion, fail, finalText, type Trace, type Verdict } from './define'
import { executedCommands } from './shell-commands'

/** Noah authorized this executable/flag-scoped correction on 2026-11-19. The goal is unchanged. */
export function gradeRequester(trace: Trace, requester: string, forbiddenReviewers: string[]): Verdict {
  let created = false
  let correctReviewer = false
  let wrongReviewer = false
  const createdIds = new Set<string>()
  for (const call of allCalls(trace)) {
    if (!['bash', 'squad_bash'].includes(call.name)) continue
    for (const raw of executedCommands(String(call.args.command ?? ''))) {
      const argv = [...raw]
      // Global output flags can precede the group; do not scan quoted descriptions as commands.
      while (['--json', '--quiet'].includes(argv[1]!)) argv.splice(1, 1)
      if (
        argv[0] !== 'ficus' ||
        !['workstream', 'ws'].includes(argv[1]!) ||
        argv.includes('--help') ||
        argv.includes('-h')
      )
        continue
      const create = ['create', 'new'].includes(argv[2]!)
      const update = argv[2] === 'update' && createdIds.has(argv[3]!)
      if (!create && !update) continue
      if (/^Error:|^error:/m.test(call.result)) continue
      if (create) {
        created = true
        for (const line of call.result.split('\n')) {
          try {
            const value = JSON.parse(line)
            if (typeof value.id === 'string') createdIds.add(value.id)
            if (typeof value.number === 'number') createdIds.add(String(value.number))
          } catch {
            const match = /Created work stream #(\d+) \(([^)]+)\)/.exec(line)
            if (match) {
              createdIds.add(match[1]!)
              createdIds.add(match[2]!)
            }
          }
        }
      }
      for (let i = 4; i < argv.length; i++) {
        const word = argv[i]!
        const reviewer =
          word === '--reviewer'
            ? argv[++i]
            : word.startsWith('--reviewer=')
              ? word.slice('--reviewer='.length)
              : undefined
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
