import { describe, expect, test } from 'bun:test'
import {
  AGENT_ATTACHMENT_ROOT,
  agentAttachmentRoot,
  buildAgentAttachmentPath,
  extractAgentAttachmentReferences,
  sanitizeAgentAttachmentName,
} from './agent-file-attachments'

const ID = '6f7e72d8-1aa6-4cec-8d24-80c8ca80ef4d'

describe('sanitizeAgentAttachmentName', () => {
  test.each([
    ['../quarterly report.pdf', 'quarterly_report.pdf'],
    ['..\\evil\r\n.txt', 'evil.txt'],
    ['..', 'attachment'],
    ['.', 'attachment'],
    ['folder/name with   spaces.csv', 'name_with_spaces.csv'],
    ['résumé 💼.pdf', 'r_sum_.pdf'],
    ['safe-name_2.tar.gz', 'safe-name_2.tar.gz'],
  ])('sanitizes %s', (input, expected) => {
    expect(sanitizeAgentAttachmentName(input)).toBe(expected)
  })

  test('caps long names while preserving a safe extension', () => {
    const result = sanitizeAgentAttachmentName(`${'a'.repeat(500)}.pdf`)
    expect(result.length).toBeLessThanOrEqual(120)
    expect(result.endsWith('.pdf')).toBe(true)
  })
})

describe('agent attachment paths', () => {
  test('builds a canonical path from an id and display name', () => {
    expect(buildAgentAttachmentPath(ID, 'quarterly report.pdf')).toBe(
      `${AGENT_ATTACHMENT_ROOT}/${ID}/quarterly_report.pdf`
    )
  })

  test('rejects malformed ids', () => {
    expect(() => buildAgentAttachmentPath('not-a-uuid', 'report.pdf')).toThrow('Invalid attachment id')
  })

  test('derives the attachment root from any runtime private mount', () => {
    expect(agentAttachmentRoot('/private')).toBe('/private/chat-attachments')
    expect(agentAttachmentRoot('/Users/n/.tau/private/agent_x')).toBe('/Users/n/.tau/private/agent_x/chat-attachments')
    expect(agentAttachmentRoot('/home/box/.private/')).toBe('/home/box/.private/chat-attachments')
  })

  test('builds a path under a runtime root', () => {
    const root = agentAttachmentRoot('/Users/n/.tau/private/agent_x')
    expect(buildAgentAttachmentPath(ID, 'quarterly report.pdf', root)).toBe(`${root}/${ID}/quarterly_report.pdf`)
  })
})

describe('extractAgentAttachmentReferences', () => {
  test('returns every exact reference and its source span', () => {
    const path = buildAgentAttachmentPath(ID, 'quarterly report.pdf')
    const text = `read @${path} twice @${path}`

    expect(extractAgentAttachmentReferences(text)).toEqual([
      { id: ID, path, name: 'quarterly_report.pdf', start: 5, end: 6 + path.length },
      {
        id: ID,
        path,
        name: 'quarterly_report.pdf',
        start: 13 + path.length,
        end: 14 + path.length * 2,
      },
    ])
  })

  test.each([
    '@/private/.ficus/identity.pem',
    '@/workspace/report.pdf',
    `@${AGENT_ATTACHMENT_ROOT}/not-a-uuid/report.pdf`,
    `@${AGENT_ATTACHMENT_ROOT}/${ID}/report.pdf/../secret`,
    `@${AGENT_ATTACHMENT_ROOT}/${ID}/report.pdf?download=1`,
    `@${AGENT_ATTACHMENT_ROOT}/${ID}/report.pdf#section`,
    `@${AGENT_ATTACHMENT_ROOT}/${ID}/report.pdf%2fsecret`,
  ])('leaves unsupported reference inert: %s', (text) => {
    expect(extractAgentAttachmentReferences(text)).toEqual([])
  })

  // The private area is mounted at `/private` only on the container runtimes.
  // On host it is <HOME_DIR>/private/<sandboxId> and on vm the box's
  // ~/.private, so extraction must recognise a reference under ANY absolute
  // root. Which root is legitimate is decided by comparing the extracted path
  // with the attachment row's stored private_path, never by this regex.
  test.each([
    '/Users/noah/.host-test-ficus/private/agent_42315cff-239b-4940-a13f-4aa8da05c9cd',
    '/home/b3f2a1/.private',
    '/private',
  ])('extracts references under the runtime root %s', (privateMount) => {
    const path = buildAgentAttachmentPath(ID, 'new service.json', agentAttachmentRoot(privateMount))
    expect(extractAgentAttachmentReferences(`read @${path} please`)).toEqual([
      { id: ID, path, name: 'new_service.json', start: 5, end: 6 + path.length },
    ])
  })

  test('extracts a root with non-ASCII segments', () => {
    const path = buildAgentAttachmentPath(ID, 'report.pdf', agentAttachmentRoot('/Users/José/.tau/private/agent_x'))
    expect(extractAgentAttachmentReferences(`read @${path}`)).toEqual([
      { id: ID, path, name: 'report.pdf', start: 5, end: 6 + path.length },
    ])
  })

  // Matching is case-SENSITIVE: the marker directory must be spelled exactly,
  // so nothing is extracted by accident...
  test('does not match a mis-cased chat-attachments directory', () => {
    expect(extractAgentAttachmentReferences(`@/private/CHAT-ATTACHMENTS/${ID}/report.pdf`)).toEqual([])
  })

  // ...while the ROOT is preserved verbatim, because on a case-sensitive
  // filesystem a differently-cased root is a DIFFERENT directory. Such a
  // reference cannot impersonate the real one: the row lookup is exact
  // equality against the stored private_path, which this does not equal.
  test('preserves the root exactly as written', () => {
    const text = `@/PRIVATE/chat-attachments/${ID}/report.pdf`
    expect(extractAgentAttachmentReferences(text)).toEqual([
      {
        id: ID,
        path: `/PRIVATE/chat-attachments/${ID}/report.pdf`,
        name: 'report.pdf',
        start: 0,
        end: text.length,
      },
    ])
  })

  test('still normalises an upper-case attachment id', () => {
    const text = `@/private/chat-attachments/${ID.toUpperCase()}/report.pdf`
    expect(extractAgentAttachmentReferences(text)).toEqual([
      { id: ID, path: `/private/chat-attachments/${ID}/report.pdf`, name: 'report.pdf', start: 0, end: text.length },
    ])
  })

  test.each([
    '@chat-attachments/6f7e72d8-1aa6-4cec-8d24-80c8ca80ef4d/report.pdf',
    '@relative/chat-attachments/6f7e72d8-1aa6-4cec-8d24-80c8ca80ef4d/report.pdf',
    '@/home/box/.private/chat-attachments/6f7e72d8-1aa6-4cec-8d24-80c8ca80ef4d/report.pdf/../secret',
  ])('leaves unsupported non-container reference inert: %s', (text) => {
    expect(extractAgentAttachmentReferences(text)).toEqual([])
  })

  test('accepts a complete multi-dot filename before punctuation', () => {
    const path = buildAgentAttachmentPath(ID, 'report.pdf.extra')
    expect(extractAgentAttachmentReferences(`See @${path}!`)).toEqual([
      { id: ID, path, name: 'report.pdf.extra', start: 4, end: 5 + path.length },
    ])
  })

  test.each(['.', ',', '!', '?', ')', ':', ';'])('stops before sentence punctuation %s', (punctuation) => {
    const path = buildAgentAttachmentPath(ID, 'report.pdf')
    expect(extractAgentAttachmentReferences(`See @${path}${punctuation} Next`)).toEqual([
      { id: ID, path, name: 'report.pdf', start: 4, end: 5 + path.length },
    ])
  })

  test.each(['💼.pdf', '_private.txt', '-notes.md', 'safe-name_2.tar.gz'])(
    'extracts every path the builder can produce from %s',
    (originalName) => {
      const path = buildAgentAttachmentPath(ID, originalName)
      expect(extractAgentAttachmentReferences(`@${path}`)).toEqual([
        { id: ID, path, name: path.split('/').at(-1)!, start: 0, end: path.length + 1 },
      ])
    }
  )
})
