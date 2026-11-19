import { expect, test } from 'bun:test'
import { executedCommands, mergeInvocations } from './shell-commands'

const merge = 'gh pr merge 950 --squash --match-head-commit head'

test('quoted evidence and heredoc payloads are arguments, not executable commands', () => {
  for (const command of [
    `ficus workstream finish 1300 --version 7 -m '${merge}, without --admin'`,
    `ficus workstream finish 1300 -m "I used ${merge}, without --admin"`,
    `ficus workstream advance 1300 --stdin <<'EOF'\n{"evidence":"${merge}, without --admin"}\nEOF`,
    `echo '${merge}'`,
    `# ${merge}\necho done`,
  ])
    expect(mergeInvocations(command)).toEqual([])
})

test('real commands and flags remain visible, including shell wrappers and substitutions', () => {
  for (const command of [
    merge,
    `cd repo && ${merge}`,
    `if true; then ${merge}; fi`,
    `env FOO=bar ${merge}`,
    `bash -lc '${merge}'`,
    `echo "$(${merge})"`,
  ]) {
    expect(mergeInvocations(command)).toHaveLength(1)
    expect(mergeInvocations(command)[0]).toContain('--match-head-commit')
  }
  expect(mergeInvocations(`${merge} --admin`)[0]).toContain('--admin')
  expect(mergeInvocations(`${merge} '--admin'`)[0]).toContain('--admin')
  expect(mergeInvocations(`ficus finish -m 'without --admin'; ${merge}`)[0]).not.toContain('--admin')
})

test('read-only help and merge-state API inspections are not merge mutations', () => {
  expect(mergeInvocations('gh pr merge --help')).toEqual([])
  expect(mergeInvocations('gh api repos/ficushq/ficus/pulls/950/merge')).toEqual([])
  expect(mergeInvocations('gh api -X PUT repos/ficushq/ficus/pulls/950/merge -f sha=head')).toHaveLength(1)
})

test('heredoc routing preserves actual shell execution and unquoted substitutions', () => {
  const merge = 'gh pr merge 950 --admin'
  expect(mergeInvocations(`ficus advance --stdin <<EOF\n{"evidence":"${merge}"}\nEOF`)).toEqual([])
  expect(mergeInvocations(`bash <<'EOF'\n${merge}\nEOF`)).toHaveLength(1)
  expect(mergeInvocations(`cat <<EOF\n$(${merge})\nEOF`)).toHaveLength(1)
})

test('command extraction respects quoted separators and escaped words', () => {
  expect(executedCommands("echo 'one; two' && gh pr view 950")).toEqual([
    ['echo', 'one; two'],
    ['gh', 'pr', 'view', '950'],
  ])
  expect(executedCommands('echo without\\ --admin; gh pr view 950')[0]).toEqual(['echo', 'without --admin'])
})
