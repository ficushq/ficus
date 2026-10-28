import { describe, expect, it } from 'bun:test'
import {
  sendInboxMessageSchema,
  chatRequestSchema,
  amtpEnvelopeSchema,
  registerAgentSchema,
  squadMetadataSchema,
  squadScheduleSpawnAgentActionSchema,
  squadScheduleCreateWorkStreamActionSchema,
  hostWorkspacePathSchema,
  createSquadSchema,
  updateSquadSchema,
} from './schemas'
import {
  IMAGE_ATTACHMENT_MIME_TYPES,
  MAX_IMAGE_ATTACHMENT_BYTES,
  MAX_IMAGE_ATTACHMENTS_PER_MESSAGE,
  MAX_IMAGE_ATTACHMENTS_TOTAL_BYTES,
} from './image-attachments'

const completionModes = ['pr-merge', 'pr-auto-merge', 'review-approval', 'direct-merge'] as const

describe('squad creation defaults', () => {
  it('preserves omitted members for preset inheritance while keeping an explicit empty list', () => {
    expect(createSquadSchema.parse({ name: 'Engineering', squadPresetId: 'engineering' }).defaultAgents).toBeUndefined()
    expect(
      createSquadSchema.parse({ name: 'Engineering', squadPresetId: 'engineering', defaultAgents: [] }).defaultAgents
    ).toEqual([])
  })
  it('creates with an omitted or empty purpose while still requiring a name', () => {
    expect(createSquadSchema.parse({ name: 'Research' }).purpose).toBe('')
    expect(createSquadSchema.parse({ name: 'Research', purpose: '' }).purpose).toBe('')
    expect(createSquadSchema.safeParse({ purpose: 'Research topics' }).success).toBe(false)
  })

  it('allows clearing a purpose without treating omission as a request to clear it', () => {
    expect(updateSquadSchema.parse({ purpose: '' })).toEqual({ purpose: '' })
    expect(updateSquadSchema.parse({})).not.toHaveProperty('purpose')
  })
})

describe('schedule work stream completion mode schemas', () => {
  it.each(completionModes.map((mode) => [mode] as const))(
    'accepts %s for spawn_agent work streams',
    (completionMode) => {
      const result = squadScheduleSpawnAgentActionSchema.parse({
        type: 'spawn_agent',
        agentTypeId: 'sysops',
        prompt: 'check health',
        workStream: { title: 'Health check', completionMode },
      })

      expect(result.workStream?.completionMode).toBe(completionMode)
    }
  )

  it.each(completionModes.map((mode) => [mode] as const))(
    'accepts %s for create_work_stream actions',
    (completionMode) => {
      const result = squadScheduleCreateWorkStreamActionSchema.parse({
        type: 'create_work_stream',
        title: 'Health check',
        completionMode,
      })

      expect(result.completionMode).toBe(completionMode)
    }
  )

  it('rejects unknown completion modes for both work stream action shapes', () => {
    expect(
      squadScheduleSpawnAgentActionSchema.safeParse({
        type: 'spawn_agent',
        agentTypeId: 'sysops',
        prompt: 'check health',
        workStream: { title: 'Health check', completionMode: 'unknown' },
      }).success
    ).toBe(false)
    expect(
      squadScheduleCreateWorkStreamActionSchema.safeParse({
        type: 'create_work_stream',
        title: 'Health check',
        completionMode: 'unknown',
      }).success
    ).toBe(false)
  })
})

describe('sendInboxMessageSchema', () => {
  it('defaults inbox delivery mode to steer', () => {
    const parsed = sendInboxMessageSchema.parse({
      recipientId: 'agent-id',
      senderType: 'system',
      content: 'hello',
    })

    expect(parsed.deliveryMode).toBe('steer')
  })
})

describe('chatRequestSchema consultant scope', () => {
  it('accepts scope.type "consultant" with a squad id', () => {
    const parsed = chatRequestSchema.parse({
      message: 'hello',
      scope: { type: 'consultant', id: '11111111-1111-4111-8111-111111111111' },
    })
    expect(parsed.scope?.type).toBe('consultant')
  })
})

describe('chatRequestSchema image attachments', () => {
  const imageId = '11111111-1111-4111-8111-111111111111'

  it('accepts an image-only request', () => {
    expect(chatRequestSchema.safeParse({ message: '', imageIds: [imageId] }).success).toBe(true)
  })

  it('rejects a blank request without images', () => {
    expect(chatRequestSchema.safeParse({ message: '   ' }).success).toBe(false)
  })

  it('rejects more than the attachment count limit', () => {
    const imageIds = Array.from(
      { length: 101 },
      (_, index) => `00000000-0000-4000-8000-${index.toString().padStart(12, '0')}`
    )
    expect(chatRequestSchema.safeParse({ message: '', imageIds }).success).toBe(false)
  })

  it('exports the server attachment constraints', () => {
    expect(IMAGE_ATTACHMENT_MIME_TYPES).toEqual(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
    expect(MAX_IMAGE_ATTACHMENT_BYTES).toBe(5 * 1024 * 1024)
    expect(MAX_IMAGE_ATTACHMENTS_TOTAL_BYTES).toBe(10 * 1024 * 1024)
    expect(MAX_IMAGE_ATTACHMENTS_PER_MESSAGE).toBe(100)
  })
})

describe('amtpEnvelopeSchema', () => {
  const valid = {
    v: 1,
    id: '11111111-1111-4111-8111-111111111111',
    ts: 1750000000000,
    from: 'amtp://senderInstance/alice',
    to: 'amtp://recipientInstance/bob',
    content: 'hello bob',
  }

  it('accepts a minimal valid envelope', () => {
    expect(amtpEnvelopeSchema.safeParse(valid).success).toBe(true)
  })

  it('accepts the optional subject/inReplyTo/agentKey/agentSig fields', () => {
    const result = amtpEnvelopeSchema.safeParse({
      ...valid,
      subject: 'greetings',
      inReplyTo: '22222222-2222-4222-8222-222222222222',
      agentKey: 'opaque-key',
      agentSig: 'opaque-sig',
    })
    expect(result.success).toBe(true)
  })

  it('rejects a wrong version literal', () => {
    expect(amtpEnvelopeSchema.safeParse({ ...valid, v: 2 }).success).toBe(false)
  })

  it('rejects a missing content field', () => {
    const { content: _content, ...rest } = valid
    expect(amtpEnvelopeSchema.safeParse(rest).success).toBe(false)
  })

  it('rejects a missing id field', () => {
    const { id: _id, ...rest } = valid
    expect(amtpEnvelopeSchema.safeParse(rest).success).toBe(false)
  })

  it('rejects a non-number ts', () => {
    expect(amtpEnvelopeSchema.safeParse({ ...valid, ts: '123' }).success).toBe(false)
  })

  it('rejects an envelope missing the from field', () => {
    const { from: _from, ...rest } = valid
    expect(amtpEnvelopeSchema.safeParse(rest).success).toBe(false)
  })

  it('rejects an envelope missing the to field', () => {
    const { to: _to, ...rest } = valid
    expect(amtpEnvelopeSchema.safeParse(rest).success).toBe(false)
  })

  it('rejects an envelope missing the ts field', () => {
    const { ts: _ts, ...rest } = valid
    expect(amtpEnvelopeSchema.safeParse(rest).success).toBe(false)
  })

  it('rejects an envelope with an empty-string subject', () => {
    expect(amtpEnvelopeSchema.safeParse({ ...valid, subject: '' }).success).toBe(false)
  })

  it('accepts an envelope with subject omitted entirely', () => {
    expect(amtpEnvelopeSchema.safeParse(valid).success).toBe(true)
  })
})

describe('squad toolchain metadata', () => {
  it('accepts a valid toolchain while retaining unrelated metadata', () => {
    expect(
      squadMetadataSchema.safeParse({
        unrelated: { value: true },
        sandbox: { toolchain: { packages: ['python3@latest'], setupScript: 'echo ready' } },
      }).success
    ).toBe(true)
  })

  it('allows null metadata as an internal deletion sentinel', () => {
    expect(squadMetadataSchema.safeParse({ sandbox: { toolchain: null } }).success).toBe(true)
  })

  it('rejects invalid package specs and setup scripts', () => {
    for (const toolchain of [
      { packages: ['python 3'] },
      { packages: ['python3', ' python3 '] },
      { packages: [''] },
      { packages: ['python\u0003'] },
      { packages: Array.from({ length: 65 }, (_, index) => `package-${index}`) },
      { packages: ['a'.repeat(256)] },
      { packages: [], setupScript: 'a'.repeat(64 * 1024 + 1) },
      { packages: [], setupScript: 'echo \u0000' },
      { packages: [], unexpected: true },
    ]) {
      expect(squadMetadataSchema.safeParse({ sandbox: { toolchain } }).success).toBe(false)
    }
  })
})

describe('registerAgentSchema handle charset', () => {
  it('accepts a valid handle with letters and digits', () => {
    expect(registerAgentSchema.safeParse({ handle: 'alice' }).success).toBe(true)
  })

  it('accepts a handle containing hyphens and underscores', () => {
    expect(registerAgentSchema.safeParse({ handle: 'my-agent_v2' }).success).toBe(true)
  })

  it('rejects a handle containing a slash', () => {
    expect(registerAgentSchema.safeParse({ handle: 'a/b' }).success).toBe(false)
  })

  it('rejects a handle containing whitespace', () => {
    expect(registerAgentSchema.safeParse({ handle: 'a b' }).success).toBe(false)
  })

  it('rejects a handle starting with a hyphen', () => {
    expect(registerAgentSchema.safeParse({ handle: '-bad' }).success).toBe(false)
  })

  it('rejects an empty handle', () => {
    expect(registerAgentSchema.safeParse({ handle: '' }).success).toBe(false)
  })
})

describe('hostWorkspacePathSchema', () => {
  it('rejects the bare root "/"', () => {
    expect(hostWorkspacePathSchema.safeParse('/').success).toBe(false)
  })

  it('rejects a path containing a NUL byte anywhere', () => {
    expect(hostWorkspacePathSchema.safeParse('/srv\0x').success).toBe(false)
  })
})
