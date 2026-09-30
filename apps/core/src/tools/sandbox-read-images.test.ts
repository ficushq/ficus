import { afterEach, describe, expect, test, spyOn } from 'bun:test'
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { convertToLlm, createReadTool, type ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { ImageContent, ToolResultMessage, AssistantMessage, Model } from '@earendil-works/pi-ai'
import { convertResponsesMessages } from '@earendil-works/pi-ai/api/openai-responses-shared'
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript'
import { createK8sSandboxedReadTool, enforceAbsolutePaths, type SandboxToolsManager } from './sandbox-tools'
import { createDockerSandboxedReadTool } from './docker-sandbox'
import * as sandbox from '../services/sandbox'
import type { DockerSandboxManager } from '../services/sandbox/docker/manager'
import { SandboxClient } from '../services/sandbox/client/http-client'
import { AGENT_DIR } from '../lib/paths'
import { ContentSafety } from '../services/security/content-safety'
import { wrapToolWithOutputRedaction } from '../services/security/tool-output-redaction'

// Resolve the decoder from its owning package, not an assumed hoisted dependency.
const photon = createRequire(import.meta.resolve('@earendil-works/pi-coding-agent'))('@silvia-odwyer/photon-node')

function bmp(width = 2): Buffer {
  const stride = Math.ceil((width * 3) / 4) * 4
  const bytes = Buffer.alloc(54 + stride)
  bytes.write('BM')
  bytes.writeUInt32LE(bytes.length, 2)
  bytes.writeUInt32LE(54, 10)
  bytes.writeUInt32LE(40, 14)
  bytes.writeInt32LE(width, 18)
  bytes.writeInt32LE(1, 22)
  bytes.writeUInt16LE(1, 26)
  bytes.writeUInt16LE(24, 28)
  for (let x = 0; x < width; x++) bytes[54 + x * 3 + (x < width / 2 ? 2 : 0)] = 255
  return bytes
}

function encode(format: 'png' | 'jpeg' | 'webp', width = 2): Buffer {
  const image = photon.PhotonImage.new_from_byteslice(bmp(width))
  try {
    return Buffer.from(
      format === 'png' ? image.get_bytes() : format === 'jpeg' ? image.get_bytes_jpeg(80) : image.get_bytes_webp()
    )
  } finally {
    image.free()
  }
}

const png = encode('png')
const privatePath = '/private/read-image.png'
const sharedRoot = '/home/test-squad/workspace'
const sharedPath = `${sharedRoot}/read-image.png`
const route = { sandboxId: 'squad_image-fixture', workspaceRoot: sharedRoot }

const clients: SandboxClient[] = []
afterEach(() => {
  for (const client of clients.splice(0)) client.close()
})

type Request = { path: string; offset?: number; limit?: number }
function remote(bytes: Buffer, options: { pageBytes?: number; totalSize?: number; exists?: boolean } = {}) {
  const requests: Array<Request & { sandboxId: string }> = []
  const stats: string[] = []
  const manager: SandboxToolsManager = {
    getSandboxStatus: async () => ({ status: 'running' }),
    getClientForSandbox: (sandboxId) => {
      // Keep the real HTTP client and JSON/base64 wire conversion. Only the
      // fetch transport is injected, so no network or credentials are needed.
      const client = new SandboxClient('fixture.invalid', 'fixture-only-token', {
        fetch: async (url, init) => {
          expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fixture-only-token')
          const request = JSON.parse(String(init?.body)) as Request
          if (new URL(String(url)).pathname === '/stat') {
            stats.push(sandboxId)
            return Response.json({ exists: options.exists ?? true })
          }
          expect(new URL(String(url)).pathname).toBe('/read')
          requests.push({ sandboxId, ...request })
          const offset = request.offset ?? 0
          const limit = Math.min(request.limit ?? 50 * 1024, options.pageBytes ?? Infinity)
          return Response.json({
            content: bytes.subarray(offset, offset + limit).toString('base64'),
            totalSize: options.totalSize ?? bytes.length,
          })
        },
      })
      clients.push(client)
      return client
    },
  }
  return { manager, requests, stats }
}

function imageFrom(content: Array<{ type: string }>): ImageContent {
  expect(content.filter((part) => part.type === 'image')).toHaveLength(1)
  return content.find((part) => part.type === 'image') as ImageContent
}

function expectPixels(image: ImageContent) {
  const decoded = photon.PhotonImage.new_from_byteslice(Buffer.from(image.data, 'base64'))
  try {
    expect(Array.from(decoded.get_raw_pixels())).toEqual([255, 0, 0, 255, 0, 0, 255, 255])
  } finally {
    decoded.free()
  }
}

describe('sandbox read image attachments', () => {
  for (const [path, sandboxId] of [
    [privatePath, 'agent_image-fixture'],
    [sharedPath, route.sandboxId],
  ]) {
    for (const wrapped of [false, true]) {
      test(`${wrapped ? 'output-redaction-wrapped' : 'direct'} PNG read routes ${path} and reaches the provider as image pixels`, async () => {
        const fixture = remote(png)
        const tool = enforceAbsolutePaths(
          createK8sSandboxedReadTool('/ignored', 'agent_image-fixture', fixture.manager, route)
        )
        const result = wrapped
          ? await wrapToolWithOutputRedaction(
              tool as unknown as ToolDefinition,
              ContentSafety.fromSecretEntries([])
            ).execute('read-image-call', { path }, undefined, undefined, {} as never)
          : await tool.execute('read-image-call', { path })
        const image = imageFrom(result.content)
        expect(image.mimeType).toBe('image/png')
        expectPixels(image)
        expect(result.content.filter((part) => part.type === 'text')).toEqual([
          { type: 'text', text: 'Read image file [image/png]' },
        ])
        expect(fixture.stats).toEqual([sandboxId])
        expect(fixture.requests.every((request) => request.sandboxId === sandboxId && request.path === path)).toBe(true)

        // Exercise the real session/context and OpenAI Responses/Codex serializer,
        // not a screenshot-exists assertion or a stand-in attachment renderer.
        const message: ToolResultMessage = {
          role: 'toolResult',
          toolCallId: 'read-image-call',
          toolName: 'read',
          content: result.content,
          isError: false,
          timestamp: 1,
        }
        const model: Model<'openai-responses'> = {
          id: 'image-test',
          name: 'Image test',
          provider: 'openai',
          api: 'openai-responses',
          baseUrl: 'https://unused.invalid',
          reasoning: false,
          input: ['text', 'image'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 10000,
          maxTokens: 100,
        }
        const call: AssistantMessage = {
          role: 'assistant',
          api: model.api,
          provider: model.provider,
          model: model.id,
          content: [{ type: 'toolCall', id: message.toolCallId, name: 'read', arguments: { path } }],
          stopReason: 'toolUse',
          timestamp: 0,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        }
        const input = convertResponsesMessages(
          model,
          normalizeContext({ messages: convertToLlm(JSON.parse(JSON.stringify([call, message]))) }),
          new Set()
        )
        const nativeImages = input
          .flatMap((item) => (item.type === 'function_call_output' && Array.isArray(item.output) ? item.output : []))
          .filter((part) => part.type === 'input_image')
        expect(nativeImages).toHaveLength(1)
        const url = (nativeImages[0] as { image_url: string }).image_url
        expect(url).toBe(`data:image/png;base64,${image.data}`)
        expectPixels({ type: 'image', mimeType: 'image/png', data: url.split(',')[1]! })
      })
    }
  }

  for (const [format, bytes, mimeType] of [
    ['jpeg', encode('jpeg'), 'image/jpeg'],
    ['gif', Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'), 'image/gif'],
    ['webp', encode('webp'), 'image/webp'],
    ['bmp', bmp(), 'image/png'],
  ] as const) {
    test(`${format} is detected from bytes even with a misleading text extension`, async () => {
      const { manager } = remote(bytes)
      const result = await createK8sSandboxedReadTool('/ignored', 'agent_image-fixture', manager).execute('read', {
        path: '/private/image.txt',
      })
      const image = imageFrom(result.content)
      expect(image.mimeType).toBe(mimeType)
      const decoded = photon.PhotonImage.new_from_byteslice(Buffer.from(image.data, 'base64'))
      decoded.free()
    })
  }

  test('a large PNG is read completely across pages, ignoring text offset/limit', async () => {
    // A legal ancillary PNG chunk makes the file exceed both text and transport
    // page limits without needing a memory-intensive random megapixel fixture.
    const { crc32 } = await import('node:zlib')
    const chunk = Buffer.alloc(1024 * 1024 + 12, 0x61)
    chunk.writeUInt32BE(chunk.length - 12, 0)
    chunk.write('tEXt', 4)
    chunk.write('padding\0', 8)
    chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4)
    const bytes = Buffer.concat([png.subarray(0, -12), chunk, png.subarray(-12)])
    const fixture = remote(bytes, { pageBytes: 32 * 1024 })
    const result = await createK8sSandboxedReadTool('/ignored', 'agent_image-fixture', fixture.manager).execute(
      'read',
      { path: privatePath, offset: 9000, limit: 1 }
    )
    expect(Buffer.from(imageFrom(result.content).data, 'base64')).toEqual(bytes)
    expectPixels(imageFrom(result.content))
    expect(fixture.requests.some((request) => (request.offset ?? 0) >= 1024 * 1024)).toBe(true)
  })

  test('oversized dimensions still use the SDK image resizing path', async () => {
    const { manager } = remote(encode('png', 2400))
    const result = await createK8sSandboxedReadTool('/ignored', 'agent_image-fixture', manager).execute('read', {
      path: privatePath,
    })
    const image = imageFrom(result.content)
    const decoded = photon.PhotonImage.new_from_byteslice(Buffer.from(image.data, 'base64'))
    try {
      expect(decoded.get_width()).toBe(2000)
    } finally {
      decoded.free()
    }
    expect(JSON.stringify(result.content.filter((part) => part.type === 'text'))).toContain('original 2400x1')
  })

  test('text with an image extension retains line selection and uses a bounded sniff', async () => {
    const fixture = remote(Buffer.from('hello\nworld\n'))
    const result = await createK8sSandboxedReadTool('/ignored', 'agent_image-fixture', fixture.manager).execute(
      'read',
      { path: privatePath, offset: 2, limit: 1 }
    )
    expect(result.content).toEqual([
      { type: 'text', text: 'world\n\n[1 more lines in file. Use offset=3 to continue.]' },
    ])
    expect(fixture.requests[0]?.limit).toBeLessThanOrEqual(4100)
  })

  for (const text of [
    '',
    'BM is plain text, not a bitmap header.',
    'GIF is plain text too.',
    'a'.repeat(4099) + '🖼️\nnext line',
  ]) {
    test(`text stays text for ${text.slice(0, 35) || 'an empty file'}`, async () => {
      const fixture = remote(Buffer.from(text), { pageBytes: 1000 })
      const result = await createK8sSandboxedReadTool('/ignored', 'agent_image-fixture', fixture.manager).execute(
        'read',
        { path: privatePath }
      )
      expect(result.content).toEqual([{ type: 'text', text }])
      if (Buffer.byteLength(text) > 4100) {
        expect(fixture.requests.slice(0, 5).map(({ offset, limit }) => ({ offset, limit }))).toEqual([
          { offset: 0, limit: 4100 },
          { offset: 1000, limit: 3100 },
          { offset: 2000, limit: 2100 },
          { offset: 3000, limit: 1100 },
          { offset: 4000, limit: 100 },
        ])
      }
    })
  }

  test('concurrent private/shared calls preserve separate native image results', async () => {
    const fixture = remote(png)
    const tool = createK8sSandboxedReadTool('/ignored', 'agent_image-fixture', fixture.manager, route)
    const results = await Promise.all(
      [privatePath, sharedPath].map((path, index) => tool.execute(`parallel-${index}`, { path }))
    )
    for (const result of results) expectPixels(imageFrom(result.content))
    expect(new Set(fixture.requests.map(({ sandboxId }) => sandboxId))).toEqual(
      new Set(['agent_image-fixture', route.sandboxId])
    )
  })

  test('locally served config images do not attempt a remote MIME lookup', async () => {
    const root = mkdtempSync(join(AGENT_DIR, 'read-image-test-'))
    try {
      const path = join(root, 'image.png')
      writeFileSync(path, png)
      const fixture = remote(Buffer.from('must not be read'))
      const result = await createK8sSandboxedReadTool('/ignored', 'agent_image-fixture', fixture.manager).execute(
        'read',
        { path }
      )
      expectPixels(imageFrom(result.content))
      expect(fixture.requests).toHaveLength(0)
      expect(fixture.stats).toHaveLength(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('invalid image data is omitted rather than leaked as binary text', async () => {
    const { manager } = remote(png.subarray(0, 40))
    const result = await createK8sSandboxedReadTool('/ignored', 'agent_image-fixture', manager).execute('read', {
      path: privatePath,
    })
    expect(result.content).toHaveLength(1)
    expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('Image omitted:') })
    expect(JSON.stringify(result.content)).not.toContain('IHDR')
  })

  for (const bytes of [
    Buffer.from([0, 0xff, 0x42, 0x49, 0x4e]),
    Buffer.from([0xff, 0xfe]),
    Buffer.from([0xe2, 0x82]),
  ]) {
    test(`unknown binary ${bytes.toString('hex')} with a PNG extension is rejected without leaking bytes`, async () => {
      const { manager } = remote(bytes)
      await expect(
        createK8sSandboxedReadTool('/ignored', 'agent_image-fixture', manager).execute('read', { path: privatePath })
      ).rejects.toThrow(/unsupported binary file/i)
    })
  }

  test('missing files and the remote size cap remain errors', async () => {
    for (const [options, error] of [
      [{ exists: false }, /ENOENT/],
      [{ totalSize: 64 * 1024 * 1024 + 1 }, /maximum is 67108864/],
    ] as const) {
      const fixture = remote(png, options)
      await expect(
        createK8sSandboxedReadTool('/ignored', 'agent_image-fixture', fixture.manager).execute('read', {
          path: privatePath,
        })
      ).rejects.toThrow(error)
    }
  })

  test('host default operations already return image content', async () => {
    const root = mkdtempSync(join(tmpdir(), 'read-images-'))
    try {
      const path = join(root, 'image.png')
      writeFileSync(path, png)
      const result = await createReadTool(root).execute('read', { path })
      expectPixels(imageFrom(result.content))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('Docker reads sniff and attach the same bytes without a host filesystem lookup', async () => {
    const commands: string[][] = []
    const manager = {
      execStatus: async () => 0,
      exec: async (_sandboxId: string, args: string[]) => {
        commands.push(args)
        return png
      },
    } as unknown as DockerSandboxManager
    const spy = spyOn(sandbox, 'getSandboxManager').mockReturnValue(manager)
    try {
      const result = await createDockerSandboxedReadTool('/ignored', 'agent_image-fixture').execute('read', {
        path: privatePath,
      })
      expectPixels(imageFrom(result.content))
      expect(commands).toContainEqual(['head', '-c', '4100', privatePath])
      expect(commands).toContainEqual(['cat', privatePath])
    } finally {
      spy.mockRestore()
    }
  })
})
