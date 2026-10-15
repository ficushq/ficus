import { describe, expect, test } from 'bun:test'
import { isHiddenPrivatePath, isWritablePrivatePath } from './policy'

describe('agent private path policy', () => {
  test.each([
    [['.ficus'], true],
    [['.ficus', 'identity.pem'], true],
    [['.ficus', 'agent-secrets.env'], true],
    [['.ssh', 'id_ed25519'], true],
    [['notes', '.env'], true],
    [['identity.pem'], true],
    [['Identity.PEM'], true],
    [['.ficus-upload-0123'], true],
    [['notes', 'identity.pem'], false],
    [['creds', 'token.txt'], false],
    [['chat-attachments', 'a', 'b.pdf'], false],
    [[], false],
  ])('hidden(%p) = %p', (parts, hidden) => {
    expect(isHiddenPrivatePath(parts)).toBe(hidden)
  })

  test('chat attachments and hidden paths are not writable; ordinary paths are', () => {
    expect(isWritablePrivatePath(['creds', 'token.txt'])).toBe(true)
    expect(isWritablePrivatePath(['chat-attachments', 'x.txt'])).toBe(false)
    expect(isWritablePrivatePath(['Chat-Attachments', 'x.txt'])).toBe(false)
    expect(isWritablePrivatePath(['.ficus', 'x'])).toBe(false)
    expect(isWritablePrivatePath(['identity.pem'])).toBe(false)
    expect(isWritablePrivatePath([])).toBe(false)
  })
})
