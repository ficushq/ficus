import { describe, expect, test } from 'bun:test'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import {
  recognizeShellCreatedLinks,
  withShellCreatedLinks,
  wrapShellToolsWithCreatedLinks,
  type ShellCreatedLink,
} from './shell-created-links'

// Combined stdout/stderr as the shell tools return it (gh writes its progress to stderr, the URL to stdout).
const GH_PR_CREATE_OUTPUT = [
  'Warning: 1 uncommitted change',
  '',
  'Creating pull request for work/feature into main in ficushq/ficus',
  '',
  'https://github.com/ficushq/ficus/pull/684',
  '',
].join('\n')
const FICUS_WS_CREATE_OUTPUT = 'Created work stream #829: Add inline actions for memory writes\n'

describe('recognizeShellCreatedLinks', () => {
  test('recognizes the PR that gh pr create printed', () => {
    expect(
      recognizeShellCreatedLinks(
        "git push -u origin work/feature && gh pr create --draft --title 'feat: x' --body-file - <<'EOF'\nBody\nEOF",
        GH_PR_CREATE_OUTPUT
      )
    ).toEqual([{ kind: 'pull_request', url: 'https://github.com/ficushq/ficus/pull/684', number: 684 }])
  })

  test('recognizes a PR on a GitHub Enterprise host', () => {
    expect(recognizeShellCreatedLinks('gh pr create --fill', 'https://git.example.com/team/app/pull/7\n')).toEqual([
      { kind: 'pull_request', url: 'https://git.example.com/team/app/pull/7', number: 7 },
    ])
  })

  test('recognizes the work stream that ficus workstream create or ficus ws create printed', () => {
    const expected: ShellCreatedLink[] = [{ kind: 'work_stream', number: 829 }]
    expect(
      recognizeShellCreatedLinks(
        "ficus workstream create --squad 4ea8b934 --title 'Add inline actions' --description 'x'",
        FICUS_WS_CREATE_OUTPUT
      )
    ).toEqual(expected)
    expect(recognizeShellCreatedLinks("ficus ws create -t 'Add inline actions'", FICUS_WS_CREATE_OUTPUT)).toEqual(
      expected
    )
    expect(
      recognizeShellCreatedLinks("ficus --backend staging ws create -t 'Add inline actions'", FICUS_WS_CREATE_OUTPUT)
    ).toEqual(expected)
  })

  test('recognizes both when one command creates a work stream and a PR, each once', () => {
    expect(
      recognizeShellCreatedLinks(
        "ficus ws create -t 'x' && gh pr create --fill",
        `${FICUS_WS_CREATE_OUTPUT}${GH_PR_CREATE_OUTPUT}https://github.com/ficushq/ficus/pull/684\n`
      )
    ).toEqual([
      { kind: 'work_stream', number: 829 },
      { kind: 'pull_request', url: 'https://github.com/ficushq/ficus/pull/684', number: 684 },
    ])
  })

  test('ignores a PR URL printed by a command that did not create a PR', () => {
    const output = 'title:\tfeat: x\nstate:\tOPEN\nurl:\thttps://github.com/ficushq/ficus/pull/684\n'
    expect(recognizeShellCreatedLinks('gh pr view 684', output)).toEqual([])
    expect(recognizeShellCreatedLinks('cat notes.md', 'https://github.com/ficushq/ficus/pull/684\n')).toEqual([])
    expect(recognizeShellCreatedLinks('gh pr list', 'https://github.com/ficushq/ficus/pull/684\n')).toEqual([])
    expect(recognizeShellCreatedLinks('ls ~/bin/ngh pr create', 'https://github.com/ficushq/ficus/pull/684')).toEqual(
      []
    )
  })

  test('ignores output lines that only mention a PR URL or work stream', () => {
    expect(
      recognizeShellCreatedLinks(
        'gh pr create --fill',
        'a pull request for branch "x" already exists:\nsee https://github.com/ficushq/ficus/pull/12 for it\n'
      )
    ).toEqual([])
    expect(recognizeShellCreatedLinks('gh pr create --fill', 'https://github.com/ficushq/ficus/issues/12\n')).toEqual(
      []
    )
    expect(recognizeShellCreatedLinks('cat log.txt', FICUS_WS_CREATE_OUTPUT)).toEqual([])
    // A reused stream, a stream without a number, and JSON output are not new numbered streams.
    expect(
      recognizeShellCreatedLinks(
        'ficus ws create --from-event e1 -t x',
        'Reused existing work stream #829 for this event'
      )
    ).toEqual([])
    expect(recognizeShellCreatedLinks('ficus ws create -t x', 'Created work stream 11111111: x')).toEqual([])
    expect(recognizeShellCreatedLinks('ficus --json ws create -t x', '{\n  "id": "1111",\n  "number": 829\n}')).toEqual(
      []
    )
  })
})

describe('withShellCreatedLinks', () => {
  const success = (text: string, extra: Record<string, unknown> = {}) => ({
    content: [{ type: 'text', text }],
    details: { truncation: undefined },
    structuredContent: { output: text, truncated: false, exit_code: 0, wall_time_seconds: 1 },
    ...extra,
  })

  test('adds created links to a successful result and keeps its other details', () => {
    const result = withShellCreatedLinks({ command: 'gh pr create --fill' }, success(GH_PR_CREATE_OUTPUT))
    expect(result.details as unknown).toEqual({
      truncation: undefined,
      createdLinks: [{ kind: 'pull_request', url: 'https://github.com/ficushq/ficus/pull/684', number: 684 }],
    })
    expect(result.content).toEqual([{ type: 'text', text: GH_PR_CREATE_OUTPUT }])
  })

  test('reads the full structured output, falling back to the text content', () => {
    const truncated = success('[output truncated]', {
      structuredContent: { output: GH_PR_CREATE_OUTPUT, truncated: false, exit_code: 0 },
    })
    expect(withShellCreatedLinks({ command: 'gh pr create --fill' }, truncated).details).toHaveProperty('createdLinks')
    const textOnly = { content: [{ type: 'text', text: FICUS_WS_CREATE_OUTPUT }] }
    expect(withShellCreatedLinks({ command: 'ficus ws create -t x' }, textOnly) as unknown).toEqual({
      ...textOnly,
      details: { createdLinks: [{ kind: 'work_stream', number: 829 }] },
    })
  })

  test('leaves failed, non-matching and malformed calls unchanged', () => {
    const failed = success(`${GH_PR_CREATE_OUTPUT}\n\nCommand exited with code 1`, {
      structuredContent: { output: GH_PR_CREATE_OUTPUT, exit_code: 1 },
      isError: true,
    })
    expect(withShellCreatedLinks({ command: 'gh pr create --fill' }, failed)).toBe(failed)
    const nonZero = success(GH_PR_CREATE_OUTPUT, { structuredContent: { output: GH_PR_CREATE_OUTPUT, exit_code: 2 } })
    expect(withShellCreatedLinks({ command: 'gh pr create --fill' }, nonZero)).toBe(nonZero)
    const viewed = success('https://github.com/ficushq/ficus/pull/684')
    expect(withShellCreatedLinks({ command: 'gh pr view 684 --json url -q .url' }, viewed)).toBe(viewed)
    const ok = success(GH_PR_CREATE_OUTPUT)
    expect(withShellCreatedLinks({}, ok)).toBe(ok)
    expect(withShellCreatedLinks(undefined, ok)).toBe(ok)
  })
})

describe('wrapShellToolsWithCreatedLinks', () => {
  const tool = (name: string): ToolDefinition =>
    ({
      name,
      label: name,
      description: name,
      parameters: {},
      execute: async () => ({
        content: [{ type: 'text', text: GH_PR_CREATE_OUTPUT }],
        details: {},
        structuredContent: { output: GH_PR_CREATE_OUTPUT, exit_code: 0 },
      }),
    }) as unknown as ToolDefinition

  test('wraps bash and squad_bash and leaves other tools as they are', async () => {
    const read = tool('read')
    const [bash, squadBash, untouched] = wrapShellToolsWithCreatedLinks([tool('bash'), tool('squad_bash'), read])
    expect(untouched).toBe(read)
    for (const wrapped of [bash!, squadBash!]) {
      const result = (await wrapped.execute(
        'tc-1',
        { command: 'gh pr create --fill' } as never,
        undefined,
        undefined,
        {} as never
      )) as {
        details: Record<string, unknown>
      }
      expect(result.details.createdLinks).toEqual([
        { kind: 'pull_request', url: 'https://github.com/ficushq/ficus/pull/684', number: 684 },
      ])
    }
  })
})
