import { describe, expect, test } from 'bun:test'
import { extractInboxBodies, extractInboxBody } from './inbox-delivery'

const framed = (count: number, sections: string) =>
  `You have ${count} unread message(s) in your inbox. Process them and take any required action.

${sections}

**Mark one or more messages as read after processing:**
\`\`\`
ficus inbox read <ids>
\`\`\``

const section = (id: string, subject: string, body: string) =>
  `### Message ${id}

**From:** Palmer (Reviewer) [bcc2e6fc]

**Sent at:** 6/24/2026, 4:48:00 PM

**Subject:** ${subject}

${body}`

describe('extractInboxBodies', () => {
  test('returns one body per delivered message, framing stripped, in order', () => {
    const content = framed(
      2,
      `${section('a1', 'One', 'Body one.')}\n\n---\n\n${section('a2', 'Two', '**Bold** two.\n\n- item')}`
    )
    expect(extractInboxBodies(content)).toEqual(['Body one.', '**Bold** two.\n\n- item'])
  })

  test('a single delivery yields a single body with markdown intact', () => {
    const content = framed(1, section('abc12345', 'Work stream done', 'This is the actual body.\n\nSecond paragraph.'))
    expect(extractInboxBodies(content)).toEqual(['This is the actual body.\n\nSecond paragraph.'])
  })

  test('content without framing yields no attributable bodies (callers fall back to previews)', () => {
    expect(extractInboxBodies('just a plain message')).toEqual([])
    expect(extractInboxBodies('   ')).toEqual([])
  })
})

describe('extractInboxBody', () => {
  test('joins multi-message bodies with a separator and falls back to raw content', () => {
    const content = framed(2, `${section('a1', 'One', 'Body one.')}\n\n---\n\n${section('a2', 'Two', 'Body two.')}`)
    expect(extractInboxBody(content)).toBe('Body one.\n\n---\n\nBody two.')
    expect(extractInboxBody('just a plain message')).toBe('just a plain message')
  })
})
