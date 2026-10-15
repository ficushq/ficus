import { randomUUID } from 'node:crypto'
import { describe, expect, mock, test } from 'bun:test'
import { createBashToolDefinition, DEFAULT_MAX_BYTES } from '@earendil-works/pi-coding-agent'
import { ContentSafety } from './content-safety'
import { wrapToolWithOutputRedaction, wrapToolsWithOutputRedaction } from './tool-output-redaction'

function tool(name: string, result: unknown) {
  return {
    name,
    label: name,
    description: name,
    parameters: {} as never,
    execute: async () => result,
  } as never
}

function toolWith(execute: (...args: unknown[]) => Promise<unknown>) {
  return {
    name: 'generated-tool',
    label: 'generated-tool',
    description: 'generated-tool',
    parameters: {} as never,
    execute,
  } as never
}

describe('inbound tool-output redaction', () => {
  test('replaces a stored secret in tool output before the model sees it', async () => {
    const canary = `CANARY_SECRET_${randomUUID()}`
    const safety = ContentSafety.fromSecretEntries([{ key: 'GITHUB_TOKEN', value: canary }])
    const wrapped = wrapToolWithOutputRedaction(
      tool('bash', { content: [{ type: 'text', text: `token is ${canary}` }], details: {} }),
      safety
    )

    const result = await (wrapped as never as { execute: () => Promise<{ content: { text: string }[] }> }).execute()

    expect(result.content[0]!.text).toBe('token is [REDACTED_SECRET_ENV:GITHUB_TOKEN]')
    expect(JSON.stringify(result)).not.toContain(canary)
  })

  test('completes the tool call rather than failing it', async () => {
    const canary = `CANARY_SECRET_${randomUUID()}`
    const safety = ContentSafety.fromSecretEntries([{ key: 'K', value: canary }])
    const wrapped = wrapToolWithOutputRedaction(
      tool('bash', { content: [{ type: 'text', text: canary }], details: { exitCode: 0 } }),
      safety
    )

    const result = await (wrapped as never as { execute: () => Promise<unknown> }).execute()

    expect(result).toEqual({ content: [{ type: 'text', text: '[REDACTED_SECRET_ENV:K]' }], details: { exitCode: 0 } })
  })

  test('leaves output without a secret byte-for-byte identical', async () => {
    const safety = ContentSafety.fromSecretEntries([{ key: 'K', value: `CANARY_${randomUUID()}` }])
    const content = [{ type: 'text', text: 'ordinary output with no secret' }]
    const wrapped = wrapToolWithOutputRedaction(tool('bash', { content, details: {} }), safety)

    const result = await (wrapped as never as { execute: () => Promise<{ content: unknown }> }).execute()

    expect(result.content).toEqual(content)
  })

  test('wraps every registered tool', async () => {
    const canary = `CANARY_SECRET_${randomUUID()}`
    const safety = ContentSafety.fromSecretEntries([{ key: 'K', value: canary }])
    const wrapped = wrapToolsWithOutputRedaction(
      [
        tool('bash', { content: [{ type: 'text', text: canary }], details: {} }),
        tool('squad_bash', { content: [{ type: 'text', text: canary }], details: {} }),
      ],
      safety
    )

    for (const item of wrapped) {
      const result = await (item as never as { execute: () => Promise<unknown> }).execute()
      expect(JSON.stringify(result)).not.toContain(canary)
    }
  })
})

describe('post-execution stored-key audit at the inbound boundary', () => {
  test('reports stored keys as already executed while returning redacted content', async () => {
    const value = `CANARY_SECRET_${randomUUID()}`
    const safety = ContentSafety.fromSecretEntries([{ key: 'SYNTHETIC_KEY', value }])
    const order: string[] = []
    const execute = mock(async () => {
      order.push('execute')
      return { content: [{ type: 'text', text: value }], details: { exitCode: 0 } }
    })
    const detections: Array<{ toolCallId: string; storedKeys: readonly string[] }> = []
    const wrapped = wrapToolWithOutputRedaction(toolWith(execute), safety, (event) => {
      order.push('callback')
      detections.push(event)
    })

    const result = await (
      wrapped as never as {
        execute: (...args: unknown[]) => Promise<{ content: { type: string; text: string }[]; details: unknown }>
      }
    ).execute('call-1', {}, undefined, undefined, {})

    // The original tool already ran when this boundary observes the match, so
    // the report is post-execution by construction: execute first, then the
    // callback, then the redacted return reaches the caller.
    expect(order).toEqual(['execute', 'callback'])
    expect(execute).toHaveBeenCalledTimes(1)
    expect(result.content).toEqual([{ type: 'text', text: '[REDACTED_SECRET_ENV:SYNTHETIC_KEY]' }])
    expect(result.details).toEqual({ exitCode: 0 })
    expect(detections).toEqual([{ toolCallId: 'call-1', storedKeys: ['SYNTHETIC_KEY'] }])
    expect(JSON.stringify({ result, detections })).not.toContain(value)
  })

  test('reports each stored key of a multi-secret result once through one event', async () => {
    const first = `CANARY_SECRET_${randomUUID()}`
    const second = `CANARY_SECRET_${randomUUID()}`
    const safety = ContentSafety.fromSecretEntries([
      { key: 'SYNTHETIC_A', value: first },
      { key: 'SYNTHETIC_B', value: second },
    ])
    const detections: Array<{ toolCallId: string; storedKeys: readonly string[] }> = []
    const wrapped = wrapToolWithOutputRedaction(
      toolWith(async () => ({ content: [{ type: 'text', text: `${first}:${second}` }], details: {} })),
      safety,
      (event) => {
        detections.push(event)
      }
    )

    const result = await (
      wrapped as never as { execute: (id: string) => Promise<{ content: { type: string; text: string }[] }> }
    ).execute('call-2')

    expect(result.content).toEqual([
      { type: 'text', text: '[REDACTED_SECRET_ENV:SYNTHETIC_A]:[REDACTED_SECRET_ENV:SYNTHETIC_B]' },
    ])
    expect(detections).toEqual([{ toolCallId: 'call-2', storedKeys: ['SYNTHETIC_A', 'SYNTHETIC_B'] }])
    expect(JSON.stringify({ result, detections })).not.toContain(first)
    expect(JSON.stringify({ result, detections })).not.toContain(second)
  })

  test('redacts a heuristic credential without invoking the stored-key callback', async () => {
    const credential = `ghp_${randomUUID().replaceAll('-', '')}${randomUUID().replaceAll('-', '')}`
    const safety = ContentSafety.fromSecretEntries([])
    const detections: unknown[] = []
    const wrapped = wrapToolWithOutputRedaction(
      toolWith(async () => ({ content: [{ type: 'text', text: `token ${credential}` }], details: {} })),
      safety,
      (event) => {
        detections.push(event)
      }
    )

    const result = await (
      wrapped as never as { execute: (id: string) => Promise<{ content: { type: string; text: string }[] }> }
    ).execute('call-3')

    expect(result.content).toEqual([{ type: 'text', text: 'token [REDACTED_CREDENTIAL]' }])
    expect(detections).toEqual([])
    expect(JSON.stringify(result)).not.toContain(credential)
  })

  test('leaves a secret-free result byte-for-byte identical and unreported', async () => {
    const safety = ContentSafety.fromSecretEntries([{ key: 'SYNTHETIC_KEY', value: `CANARY_${randomUUID()}` }])
    const detections: unknown[] = []
    const content = [{ type: 'text', text: 'ordinary output with no secret' }]
    const wrapped = wrapToolWithOutputRedaction(
      toolWith(async () => ({ content, details: { exitCode: 0 } })),
      safety,
      (event) => {
        detections.push(event)
      }
    )

    const result = await (
      wrapped as never as { execute: (id: string) => Promise<{ content: unknown[]; details: unknown }> }
    ).execute('call-4')

    expect(result.content).toEqual(content)
    expect(result.details).toEqual({ exitCode: 0 })
    expect(detections).toEqual([])
  })

  test('threads the callback through every wrapped tool', async () => {
    const value = `CANARY_SECRET_${randomUUID()}`
    const safety = ContentSafety.fromSecretEntries([{ key: 'SYNTHETIC_KEY', value }])
    const detections: Array<{ toolCallId: string }> = []
    const onStoredToolResult = (event: { toolCallId: string }) => {
      detections.push(event)
    }
    const wrapped = wrapToolsWithOutputRedaction(
      [
        toolWith(async () => ({ content: [{ type: 'text', text: value }] })),
        toolWith(async () => ({ content: [{ type: 'text', text: value }] })),
      ],
      safety,
      onStoredToolResult
    )

    for (const [index, item] of wrapped.entries()) {
      await (item as never as { execute: (id: string) => Promise<unknown> }).execute(`call-${index}`)
    }

    expect(detections.map((event) => event.toolCallId)).toEqual(['call-0', 'call-1'])
  })
})

type Partial = { content?: { type: string; text?: string }[]; details?: unknown }
type Executable = {
  execute: (id: string, params?: unknown, signal?: AbortSignal, onUpdate?: (partial: Partial) => void) => Promise<any>
}

/** Every non-empty prefix of `value` at least `min` long, i.e. every recognisable piece of it. */
function containsFragment(text: string, value: string, min = 4): boolean {
  for (let start = 0; start + min <= value.length; start++) {
    if (text.includes(value.slice(start, start + min))) return true
  }
  return false
}

describe('details, structured content and errors', () => {
  test('redacts a stored value in details and structuredContent, keeping their shape', async () => {
    const value = `CANARY_SECRET_${randomUUID()}`
    const safety = ContentSafety.fromSecretEntries([{ key: 'SYNTHETIC_KEY', value }])
    const detections: unknown[] = []
    const wrapped = wrapToolWithOutputRedaction(
      toolWith(async () => ({
        content: [{ type: 'text', text: 'ok' }],
        details: { exitCode: 0, env: { TOKEN: value }, lines: [`echo ${value}`] },
        structuredContent: { output: `value: ${value}\n`, truncated: false, exit_code: 0 },
      })),
      safety,
      (event) => {
        detections.push(event)
      }
    ) as never as Executable

    const result = await wrapped.execute('call-d')

    expect(result).toEqual({
      content: [{ type: 'text', text: 'ok' }],
      details: {
        exitCode: 0,
        env: { TOKEN: '[REDACTED_SECRET_ENV:SYNTHETIC_KEY]' },
        lines: ['echo [REDACTED_SECRET_ENV:SYNTHETIC_KEY]'],
      },
      structuredContent: { output: 'value: [REDACTED_SECRET_ENV:SYNTHETIC_KEY]\n', truncated: false, exit_code: 0 },
    })
    expect(detections).toEqual([{ toolCallId: 'call-d', storedKeys: ['SYNTHETIC_KEY'] }])
  })

  test('drops details the redactor cannot copy instead of failing the tool', async () => {
    const value = `CANARY_SECRET_${randomUUID()}`
    const safety = ContentSafety.fromSecretEntries([{ key: 'SYNTHETIC_KEY', value }])
    const details = Object.defineProperty({}, 'leak', { get: () => value, enumerable: true })
    const wrapped = wrapToolWithOutputRedaction(
      toolWith(async () => ({ content: [{ type: 'text', text: value }], details })),
      safety
    ) as never as Executable

    const result = await wrapped.execute('call-g')

    expect(result).toEqual({ content: [{ type: 'text', text: '[REDACTED_SECRET_ENV:SYNTHETIC_KEY]' }] })
  })

  test('redacts a thrown error message and stack, and reports the key', async () => {
    const value = `CANARY_SECRET_${randomUUID()}`
    const safety = ContentSafety.fromSecretEntries([{ key: 'SYNTHETIC_KEY', value }])
    const detections: unknown[] = []
    const wrapped = wrapToolWithOutputRedaction(
      toolWith(async () => {
        throw new Error(`value: ${value}\n\nCommand timed out after 5 seconds`)
      }),
      safety,
      (event) => {
        detections.push(event)
      }
    ) as never as Executable

    const error = (await wrapped.execute('call-e').catch((caught: unknown) => caught)) as Error

    expect(error).toBeInstanceOf(Error)
    expect(error.message).toBe('value: [REDACTED_SECRET_ENV:SYNTHETIC_KEY]\n\nCommand timed out after 5 seconds')
    expect(String(error.stack)).not.toContain(value)
    expect(detections).toEqual([{ toolCallId: 'call-e', storedKeys: ['SYNTHETIC_KEY'] }])
  })

  test('redacts a thrown non-Error value', async () => {
    const value = `CANARY_SECRET_${randomUUID()}`
    const safety = ContentSafety.fromSecretEntries([{ key: 'SYNTHETIC_KEY', value }])
    const wrapped = wrapToolWithOutputRedaction(
      toolWith(async () => {
        throw `failed with ${value}`
      }),
      safety
    ) as never as Executable

    expect(await wrapped.execute('call-s').catch((caught: unknown) => caught)).toBe(
      'failed with [REDACTED_SECRET_ENV:SYNTHETIC_KEY]'
    )
  })

  test('drops the end of a value cut off at the start of a truncated error message', async () => {
    const value = `S3CR3T-${randomUUID()}`
    const safety = ContentSafety.fromSecretEntries([{ key: 'SYNTHETIC_KEY', value }])
    const message = `${value.slice(9)}\nlast line\n\n[Showing lines 2-3 of 3. Full output: /tmp/pi-bash-x.log]\n\nCommand aborted`
    const wrapped = wrapToolWithOutputRedaction(
      toolWith(async () => {
        throw new Error(message)
      }),
      safety
    ) as never as Executable

    const error = (await wrapped.execute('call-t').catch((caught: unknown) => caught)) as Error

    expect(error.message).toBe(message.slice(value.length - 9))
    expect(containsFragment(`${error.message}${error.stack}`, value)).toBe(false)
  })

  test('rethrows an ordinary error itself, keeping its class and fields', async () => {
    class OutcomeUnknownError extends Error {
      readonly retryable = false
    }
    const original = new OutcomeUnknownError('Command exited with code 1')
    const safety = ContentSafety.fromSecretEntries([{ key: 'SYNTHETIC_KEY', value: `CANARY_${randomUUID()}` }])
    const wrapped = wrapToolWithOutputRedaction(
      toolWith(async () => {
        throw original
      }),
      safety
    ) as never as Executable

    expect(await wrapped.execute('call-o').catch((caught: unknown) => caught)).toBe(original)
  })
})

describe('streamed partial updates', () => {
  test('redacts a stored value echoed whole in a partial, including its details', async () => {
    const value = `CANARY_SECRET_${randomUUID()}`
    const safety = ContentSafety.fromSecretEntries([{ key: 'SYNTHETIC_KEY', value }])
    const detections: unknown[] = []
    const partials: Partial[] = []
    const wrapped = wrapToolWithOutputRedaction(
      toolWith(async (...args: unknown[]) => {
        const onUpdate = args[3] as (partial: Partial) => void
        onUpdate({ content: [{ type: 'text', text: `value: ${value}\n` }], details: { note: value } })
        return { content: [{ type: 'text', text: 'done' }] }
      }),
      safety,
      (event) => {
        detections.push(event)
      }
    ) as never as Executable

    await wrapped.execute('call-p', {}, undefined, (partial) => partials.push(partial))

    expect(partials).toEqual([
      {
        content: [{ type: 'text', text: 'value: [REDACTED_SECRET_ENV:SYNTHETIC_KEY]\n' }],
        details: { note: '[REDACTED_SECRET_ENV:SYNTHETIC_KEY]' },
      },
    ])
    expect(detections).toEqual([{ toolCallId: 'call-p', storedKeys: ['SYNTHETIC_KEY'] }])
  })

  test('never shows any part of a value split across cumulative snapshots', async () => {
    const value = `S3CR3T-${randomUUID()}`
    const safety = ContentSafety.fromSecretEntries([{ key: 'SYNTHETIC_KEY', value }])
    const output = `before\nprinting ${value}\nafter\n`
    const partials: Partial[] = []
    const wrapped = wrapToolWithOutputRedaction(
      toolWith(async (...args: unknown[]) => {
        const onUpdate = args[3] as (partial: Partial) => void
        // Every possible chunk boundary: one snapshot per streamed character.
        for (let end = 1; end <= output.length; end++) {
          onUpdate({ content: [{ type: 'text', text: output.slice(0, end) }] })
        }
        return { content: [{ type: 'text', text: output }] }
      }),
      safety
    ) as never as Executable

    const result = await wrapped.execute('call-c', {}, undefined, (partial) => partials.push(partial))

    expect(partials).toHaveLength(output.length)
    for (const partial of partials) {
      const text = partial.content![0]!.text!
      expect(text.includes(value.slice(0, 2))).toBe(false)
      expect(output.replace(value, '[REDACTED_SECRET_ENV:SYNTHETIC_KEY]').startsWith(text)).toBe(true)
    }
    expect(partials.at(-1)!.content![0]!.text).toBe('before\nprinting [REDACTED_SECRET_ENV:SYNTHETIC_KEY]\nafter\n')
    expect(result.content[0].text).toBe('before\nprinting [REDACTED_SECRET_ENV:SYNTHETIC_KEY]\nafter\n')
  })

  test('passes ordinary partials through unchanged', async () => {
    const safety = ContentSafety.fromSecretEntries([{ key: 'SYNTHETIC_KEY', value: `S3CR3T-${randomUUID()}` }])
    const sent: Partial[] = [
      { content: [], details: undefined },
      { content: [{ type: 'text', text: 'building...\n' }], details: { truncation: undefined } },
      { content: [{ type: 'text', text: 'building...\ndone\n' }], details: { fullOutputPath: '/tmp/out.log' } },
    ]
    const partials: Partial[] = []
    const wrapped = wrapToolWithOutputRedaction(
      toolWith(async (...args: unknown[]) => {
        for (const partial of sent) (args[3] as (partial: Partial) => void)(partial)
        return { content: [{ type: 'text', text: 'done' }] }
      }),
      safety
    ) as never as Executable

    await wrapped.execute('call-n', {}, undefined, (partial) => partials.push(partial))

    expect(partials).toEqual(sent)
  })
})

/** pi's real bash tool over synthetic operations that stream `chunks` with a pause between them. */
function streamingBash(chunks: string[], pauseMs = 0) {
  return createBashToolDefinition('/', {
    operations: {
      exec: async (_command, _cwd, options) => {
        for (const chunk of chunks) {
          options.onData(Buffer.from(chunk))
          if (pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, pauseMs))
        }
        return { exitCode: 0 }
      },
    },
  })
}

describe("pi's bash tool behind the redaction wrapper", () => {
  test('a value split across streamed chunks never appears in a live update or the result', async () => {
    const value = `S3CR3T-${randomUUID()}`
    const safety = ContentSafety.fromSecretEntries([{ key: 'SYNTHETIC_KEY', value }])
    const chunks = ['starting\nvalue: ', value.slice(0, 5), value.slice(5, 20), `${value.slice(20)}\nfinished\n`]
    // Longer than pi's 100 ms update throttle, so each chunk produces its own snapshot.
    const bash = streamingBash(chunks, 120)

    const raw: Partial[] = []
    await (bash as never as Executable).execute('raw', { command: 'x' }, undefined, (partial) => raw.push(partial))
    // Precondition: unwrapped, pi does stream the value in pieces.
    expect(raw.some((partial) => partial.content?.[0]?.text?.endsWith(`value: ${value.slice(0, 5)}`))).toBe(true)

    const partials: Partial[] = []
    const wrapped = wrapToolWithOutputRedaction(bash as never, safety) as never as Executable
    const result = await wrapped.execute('call-b', { command: 'x' }, undefined, (partial) => partials.push(partial))

    expect(partials.length).toBeGreaterThanOrEqual(chunks.length)
    for (const partial of partials) expect(containsFragment(JSON.stringify(partial), value)).toBe(false)
    expect(result.content[0].text).toBe('starting\nvalue: [REDACTED_SECRET_ENV:SYNTHETIC_KEY]\nfinished\n')
    expect(containsFragment(JSON.stringify(result), value)).toBe(false)
  })

  test('ordinary streamed output is unchanged', async () => {
    const safety = ContentSafety.fromSecretEntries([{ key: 'SYNTHETIC_KEY', value: `S3CR3T-${randomUUID()}` }])
    const chunks = ['compiling 1/2\n', 'compiling 2/2\n', 'ok\n']

    const raw: Partial[] = []
    const rawResult = await (streamingBash(chunks, 120) as never as Executable).execute(
      'raw',
      { command: 'x' },
      undefined,
      (partial) => raw.push(partial)
    )
    const partials: Partial[] = []
    const result = await (
      wrapToolWithOutputRedaction(streamingBash(chunks, 120) as never, safety) as never as Executable
    ).execute('call-u', { command: 'x' }, undefined, (partial) => partials.push(partial))

    expect(partials).toEqual(raw)
    expect(result.content).toEqual(rawResult.content)
    expect(result.details).toEqual(rawResult.details)
    expect(result.structuredContent.output).toBe(rawResult.structuredContent.output)
  })

  test('a value cut by output truncation leaves no piece in the result or structured output', async () => {
    const value = `S3CR3T-${randomUUID()}`
    const safety = ContentSafety.fromSecretEntries([{ key: 'SYNTHETIC_KEY', value }])
    // One line longer than the display limit, so pi keeps only its last bytes:
    // the cut falls 10 characters into the value.
    const tail = 'y'.repeat(DEFAULT_MAX_BYTES - (value.length - 10))
    const bash = streamingBash([`${'x'.repeat(4096)}${value}${tail}`])

    const raw = await (bash as never as Executable).execute('raw', { command: 'x' })
    // Precondition: unwrapped, the truncated output starts with the end of the value.
    expect((raw.content[0].text as string).startsWith(value.slice(10))).toBe(true)

    const result = await (wrapToolWithOutputRedaction(bash as never, safety) as never as Executable).execute('call-x', {
      command: 'x',
    })

    expect((result.content[0].text as string).startsWith('y')).toBe(true)
    expect(containsFragment(JSON.stringify(result), value)).toBe(false)
  })

  test('a value split across chunks of head-truncated streamed output never appears', async () => {
    const value = `S3CR3T-${randomUUID()}`
    const safety = ContentSafety.fromSecretEntries([{ key: 'SYNTHETIC_KEY', value }])
    const chunks = [`${'x'.repeat(DEFAULT_MAX_BYTES + 1000)}${value.slice(0, 8)}`, `${value.slice(8)}\ndone\n`]
    const bash = streamingBash(chunks, 120)

    const raw: Partial[] = []
    await (bash as never as Executable).execute('raw', { command: 'x' }, undefined, (partial) => raw.push(partial))
    expect(raw.some((partial) => containsFragment(JSON.stringify(partial), value))).toBe(true)

    const partials: Partial[] = []
    const result = await (wrapToolWithOutputRedaction(bash as never, safety) as never as Executable).execute(
      'call-h',
      { command: 'x' },
      undefined,
      (partial) => partials.push(partial)
    )

    expect(partials.length).toBeGreaterThanOrEqual(chunks.length)
    for (const partial of partials) expect(containsFragment(JSON.stringify(partial), value)).toBe(false)
    expect(result.structuredContent.output).toContain('[REDACTED_SECRET_ENV:SYNTHETIC_KEY]\ndone\n')
    expect(containsFragment(JSON.stringify(result), value)).toBe(false)
  })
})

describe('nested and overlapping stored values', () => {
  /** Synthetic stored URL that contains a separately stored username. */
  function nestedValues() {
    const user = `synthuser${randomUUID().slice(0, 8)}`
    const password = `Zq9Pw${randomUUID().replaceAll('-', '')}`
    const url = `https://${user}:${password}@db-qx7.zz/x`
    const safety = ContentSafety.fromSecretEntries([
      { key: 'SYNTH_DB_USER', value: user },
      { key: 'SYNTH_DB_URL', value: url },
    ])
    return { user, password, url, safety }
  }

  /** True when any 4-character window of the outer value outside the inner value shows. */
  function leaksOuter(text: string, url: string, user: string): boolean {
    return url
      .split(user)
      .filter((piece) => piece.length >= 4)
      .some((piece) => containsFragment(text, piece))
  }

  test('a partial cut after a nested stored value does not leak the outer value', async () => {
    const { user, password, url, safety } = nestedValues()
    const output = `conn: ${url}\nok\n`
    const partials: Partial[] = []
    const wrapped = wrapToolWithOutputRedaction(
      toolWith(async (...args: unknown[]) => {
        for (let end = 1; end <= output.length; end++) {
          ;(args[3] as (partial: Partial) => void)({ content: [{ type: 'text', text: output.slice(0, end) }] })
        }
        return { content: [{ type: 'text', text: output }] }
      }),
      safety
    ) as never as Executable

    const result = await wrapped.execute('call-n1', {}, undefined, (partial) => partials.push(partial))

    for (const partial of partials) {
      const text = JSON.stringify(partial)
      expect(containsFragment(text, password)).toBe(false)
      expect(leaksOuter(text, url, user)).toBe(false)
    }
    expect(result.content[0].text).toBe('conn: [REDACTED_SECRET_ENV:SYNTH_DB_URL]\nok\n')
  })

  test('the reviewer reproduction: real bash chunks split right after the nested value', async () => {
    const { user, password, url, safety } = nestedValues()
    const cut = url.indexOf(user) + user.length + 4
    const bash = streamingBash([`conn: ${url.slice(0, cut)}`, `${url.slice(cut)}\ndone\n`], 120)

    const partials: Partial[] = []
    const result = await (wrapToolWithOutputRedaction(bash as never, safety) as never as Executable).execute(
      'call-n2',
      { command: 'x' },
      undefined,
      (partial) => partials.push(partial)
    )

    for (const partial of partials) {
      expect(containsFragment(JSON.stringify(partial), password)).toBe(false)
      expect(leaksOuter(JSON.stringify(partial), url, user)).toBe(false)
    }
    expect(result.content[0].text).toBe('conn: [REDACTED_SECRET_ENV:SYNTH_DB_URL]\ndone\n')
  })

  test('a head-truncated start inside the outer value, past the nested value, does not leak', async () => {
    const { user, password, url, safety } = nestedValues()
    // Truncation kept only the part of the URL from just before the username onwards.
    const start = url.indexOf(user) - 2
    const text = `${url.slice(start)}\nlast line\n\n[Showing lines 2-3 of 3. Full output: /tmp/pi-bash-x.log]`
    const details = { truncation: { truncated: true, content: `${url.slice(start)}\nlast line` } }
    const wrapped = wrapToolWithOutputRedaction(
      toolWith(async () => ({ content: [{ type: 'text', text }], details })),
      safety
    ) as never as Executable
    const throwing = wrapToolWithOutputRedaction(
      toolWith(async () => {
        throw new Error(`${text}\n\nCommand aborted`)
      }),
      safety
    ) as never as Executable

    const result = await wrapped.execute('call-n3')
    const error = (await throwing.execute('call-n4').catch((caught: unknown) => caught)) as Error

    for (const shown of [JSON.stringify(result), error.message, String(error.stack)]) {
      expect(containsFragment(shown, password)).toBe(false)
      expect(leaksOuter(shown, url, user)).toBe(false)
    }
    expect(result.content[0].text.startsWith('\nlast line')).toBe(true)
    expect(result.details.truncation.content).toBe('\nlast line')
  })

  test('two values where one ends with the start of the other leave no piece of either', async () => {
    const shared = `OVL${randomUUID().slice(0, 8)}`
    const first = `AAAA${randomUUID().replaceAll('-', '')}${shared}`
    const second = `${shared}${randomUUID().replaceAll('-', '')}BBBB`
    const safety = ContentSafety.fromSecretEntries([
      { key: 'SYNTH_FIRST', value: first },
      { key: 'SYNTH_SECOND', value: second },
    ])
    // The first value printed whole, running straight into the second.
    const output = `x ${first}${second.slice(shared.length)}\n`
    const partials: Partial[] = []
    const wrapped = wrapToolWithOutputRedaction(
      toolWith(async (...args: unknown[]) => {
        for (let end = 1; end <= output.length; end++) {
          ;(args[3] as (partial: Partial) => void)({ content: [{ type: 'text', text: output.slice(0, end) }] })
        }
        return { content: [{ type: 'text', text: output }] }
      }),
      safety
    ) as never as Executable

    const result = await wrapped.execute('call-n5', {}, undefined, (partial) => partials.push(partial))

    for (const shown of [...partials.map((partial) => JSON.stringify(partial)), JSON.stringify(result)]) {
      expect(containsFragment(shown, first)).toBe(false)
      expect(containsFragment(shown, second)).toBe(false)
    }
  })

  test('the leading edge of truncated output that overlaps two values leaves no piece of either', async () => {
    const shared = `OVL${randomUUID().slice(0, 8)}`
    const first = `AAAA${randomUUID().replaceAll('-', '')}${shared}`
    const second = `${shared}${randomUUID().replaceAll('-', '')}BBBB`
    const safety = ContentSafety.fromSecretEntries([
      { key: 'SYNTH_FIRST', value: first },
      { key: 'SYNTH_SECOND', value: second },
    ])
    // Truncation started inside the first value, which runs into the second.
    const shown = `${first.slice(6)}${second.slice(shared.length)}\ntail`
    const text = `${shown}\n\n[Showing lines 2-3 of 3. Full output: /tmp/pi-bash-x.log]`
    const wrapped = wrapToolWithOutputRedaction(
      toolWith(async () => ({ content: [{ type: 'text', text }] })),
      safety
    ) as never as Executable

    const result = await wrapped.execute('call-n6')

    expect(containsFragment(JSON.stringify(result), first)).toBe(false)
    expect(containsFragment(JSON.stringify(result), second)).toBe(false)
    expect(result.content[0].text.startsWith('\ntail')).toBe(true)
  })

  test('audits a stored value that a cut removed from what is shown', async () => {
    const { user, url, safety } = nestedValues()
    const detections: Array<{ storedKeys: readonly string[] }> = []
    const wrapped = wrapToolWithOutputRedaction(
      toolWith(async (...args: unknown[]) => {
        // The username is printed whole, but it is also the start of the stored URL's
        // remainder here, so the partial holds it back.
        ;(args[3] as (partial: Partial) => void)({
          content: [{ type: 'text', text: `x ${url.slice(0, url.indexOf(user) + user.length)}` }],
        })
        return { content: [{ type: 'text', text: 'done' }] }
      }),
      safety,
      (event) => {
        detections.push(event)
      }
    ) as never as Executable

    await wrapped.execute('call-n7', {}, undefined, () => {})

    expect(detections.flatMap((event) => event.storedKeys)).toContain('SYNTH_DB_USER')
  })
})
