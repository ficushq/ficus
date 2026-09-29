import { describe, expect, test } from 'bun:test'
import {
  applyJsonStringChanges,
  jsonStringChanges,
  rewriteEntityReferences,
  rewriteMemoryProvenance,
  rewriteStoredText,
} from './stored-text-rewrite'

// Migration history: these fixtures are the pre-rename spellings the Task 36c rewrite retires.
const UUID = 'deadbeef-1234-4abc-8def-0123456789ab'

describe('rewriteEntityReferences', () => {
  test.each([
    ['a Markdown work-stream link', '[#42](tau:ws:42)', '[#42](ficus:ws:42)'],
    ['a titled link', 'See [#42 — Fix](tau:ws:42 "Fix sign-in").', 'See [#42 — Fix](ficus:ws:42 "Fix sign-in").'],
    ['an agent link by UUID', `[Ada](tau:agent:${UUID})`, `[Ada](ficus:agent:${UUID})`],
    ['an agent link by UUID prefix', '[Ada](tau:agent:deadbeef)', '[Ada](ficus:agent:deadbeef)'],
    ['a work stream by UUID prefix', '[x](tau:ws:deadbeef-12)', '[x](ficus:ws:deadbeef-12)'],
    ['an autolink', '<tau:ws:7>', '<ficus:ws:7>'],
    ['a bare farm-chat reference', 'Anyone looked at tau:ws:2? @You', 'Anyone looked at ficus:ws:2? @You'],
    ['start and end of text', 'tau:agent:deadbeef', 'ficus:agent:deadbeef'],
    [
      'sentence punctuation after it',
      'Done: tau:ws:3. Next: tau:ws:4, then tau:ws:5!',
      'Done: ficus:ws:3. Next: ficus:ws:4, then ficus:ws:5!',
    ],
    ['a colon then a space', 'tau:ws:9: broken', 'ficus:ws:9: broken'],
    ['bold', '**tau:ws:12**', '**ficus:ws:12**'],
    ['any case the reader accepted, keeping kind and id as written', '[x](TAU:WS:DEADBEEF)', '[x](ficus:WS:DEADBEEF)'],
    ['the largest work number', '[x](tau:ws:2147483647)', '[x](ficus:ws:2147483647)'],
    ['several on one line', '[a](tau:ws:1) and [b](tau:agent:abc)', '[a](ficus:ws:1) and [b](ficus:agent:abc)'],
    ['prose around a code span', 'Use `tau:ws:1` for [real](tau:ws:1)', 'Use `tau:ws:1` for [real](ficus:ws:1)'],
  ])('rewrites %s', (_name, input, output) => {
    expect(rewriteEntityReferences(input)).toBe(output)
  })

  test.each([
    ['inline code', 'Write `[#42](tau:ws:42)` to link'],
    ['a double-backtick code span', 'Write ``tau:ws:42 `x` `` to link'],
    ['a fenced code block', 'Example:\n```md\n[#42](tau:ws:42)\n```\nend'],
    ['a tilde fence', '~~~\ntau:agent:deadbeef\n~~~'],
    ['an unclosed fence (code to the end)', '```\n[#42](tau:ws:42)'],
    ['an indented fence inside a list', '- item\n  ```\n  tau:ws:42\n  ```'],
    ['a URL path', 'https://example.com/tau:ws:42'],
    ['a URL query value', 'https://example.com/?ref=tau:ws:42'],
    ['a URL fragment behind a parenthesis', 'https://example.com/(tau:ws:42)'],
    ['a host', 'ssh a.tau:ws:42'],
    ['another scheme', 'x:tau:ws:42'],
    ['part of a word', 'mytau:ws:42 and tau_tau:ws:1'],
    ['a hyphenated word', 'pre-tau:ws:42'],
    ['a path suffix', '[x](tau:ws:42/extra)'],
    ['a longer id', 'tau:ws:42.example and tau:ws:42:x'],
    ['an id with a non-hex letter', '[x](tau:agent:xyz) and tau:ws:42g'],
    ['a malformed id', '[x](tau:ws:abc-def) and [y](tau:ws:not-an-id)'],
    ['an unknown kind', '[x](tau:squad:42) and tau:other:1'],
    ['a work number past int32 that is no UUID prefix', '[x](tau:ws:2147483648)'],
    ['a zero-led work number that is no UUID prefix', '[x](tau:ws:0123456789)'],
    ['an over-long id', `[x](tau:agent:${UUID}0)`],
    ['text that only mentions the scheme', 'tau: the Greek letter; tau:ws; tau:agent:'],
    ['the current scheme', `[x](ficus:ws:42) [y](ficus:agent:${UUID})`],
  ])('leaves %s alone', (_name, input) => {
    expect(rewriteEntityReferences(input)).toBe(input)
  })

  test('is idempotent', () => {
    const once = rewriteEntityReferences('[a](tau:ws:1) `tau:ws:2`')
    expect(rewriteEntityReferences(once)).toBe(once)
  })
})

describe('rewriteMemoryProvenance', () => {
  test('rewrites the marker the web parses, and only it', () => {
    const block = '\n<!--tau:memory-provenance [{"documentId":"d1"}] -->'
    expect(rewriteMemoryProvenance(`Found 1 result(s):${block}`)).toBe(
      'Found 1 result(s):\n<!--ficus:memory-provenance [{"documentId":"d1"}] -->'
    )
    for (const other of ['tau:memory-provenance [x]', '<!--tau:memory-provenance-extra [x] -->', '`<!--x-->`']) {
      expect(rewriteMemoryProvenance(other)).toBe(other)
    }
  })

  test('is part of the stored-text rewrite', () => {
    expect(rewriteStoredText('<!--tau:memory-provenance [] --> [x](tau:ws:1)')).toBe(
      '<!--ficus:memory-provenance [] --> [x](ficus:ws:1)'
    )
  })
})

describe('jsonStringChanges', () => {
  test('finds changed string values by path, never keys, and prunes skipped subtrees', () => {
    const document = {
      'tau:ws:1': 'key stays',
      content: [
        { type: 'text', id: 'a', content: 'See [x](tau:ws:1)' },
        { type: 'thinking', content: 'tau:ws:2' },
        { type: 'tool_use', toolCall: { result: 'ok\n<!--tau:memory-provenance [] -->' } },
      ],
      count: 3,
    }
    const changes = jsonStringChanges(document, rewriteStoredText, (object) => object.type === 'thinking')
    expect(changes).toEqual([
      { path: ['content', '0', 'content'], value: 'See [x](ficus:ws:1)' },
      { path: ['content', '2', 'toolCall', 'result'], value: 'ok\n<!--ficus:memory-provenance [] -->' },
    ])
    const patched = applyJsonStringChanges(structuredClone(document), changes) as typeof document
    expect(patched['tau:ws:1']).toBe('key stays')
    expect(patched.content[1]).toEqual({ type: 'thinking', content: 'tau:ws:2' })
    expect(jsonStringChanges(patched, rewriteStoredText, (object) => object.type === 'thinking')).toEqual([])
  })
})
