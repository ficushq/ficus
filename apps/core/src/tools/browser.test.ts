import { describe, test, expect, mock, spyOn, afterEach } from 'bun:test'
import { createBrowserTools as buildBrowserTools } from './browser'
import { SandboxHttpError } from '../services/sandbox/client/http-client'

const RUN_ID = 'run-1'
const SANDBOX_ID = 'agent_run-1'

function fakeManager(client: any) {
  return { getClientForSandbox: mock(() => client) } as any
}

// A fixture-owned provider cannot rebind a shared ES-module export for another
// suite. Keep resolution lazy so the existing fresh-client assertions apply.
const factory = { getSandboxManager: () => fakeManager(null) }
function createBrowserTools(runId: string, sandboxId: string) {
  return buildBrowserTools(runId, sandboxId, () => factory.getSandboxManager())
}

describe('browser tools', () => {
  const spies: Array<{ mockRestore: () => void }> = []
  afterEach(() => {
    spies.forEach((s) => s.mockRestore())
    spies.length = 0
  })

  test('createBrowserTools returns all 7 expected tools with key === name', () => {
    spies.push(spyOn(factory, 'getSandboxManager').mockReturnValue(fakeManager(null)))
    const tools = createBrowserTools(RUN_ID, SANDBOX_ID)
    const names = tools.map((t) => t.name)
    expect(names).toEqual([
      'browser_open',
      'browser_click',
      'browser_type',
      'browser_scroll',
      'browser_screenshot',
      'browser_read',
      'browser_console',
    ])
    for (const tool of tools) {
      expect(tool.key).toBe(tool.name)
    }
  })

  test('browser_open returns image block and title text on success', async () => {
    const client = {
      browserOpen: mock(async () => ({ title: 'Example Domain', screenshotBase64: 'BASE64DATA' })),
    }
    spies.push(spyOn(factory, 'getSandboxManager').mockReturnValue(fakeManager(client)))

    const tools = createBrowserTools(RUN_ID, SANDBOX_ID)
    const openTool = tools.find((t) => t.name === 'browser_open')!
    const result = await openTool.execute('call-1', { url: 'https://example.com' }, undefined, undefined, {} as any)

    expect(client.browserOpen).toHaveBeenCalledWith(RUN_ID, 'https://example.com')
    const [textBlock, imageBlock] = result.content as any[]
    expect(textBlock.text).toBe('Page loaded: "Example Domain" (https://example.com)')
    expect(imageBlock.type).toBe('image')
    expect(imageBlock.data).toBe('BASE64DATA')
    expect(imageBlock.mimeType).toBe('image/png')
  })

  test('browser_click returns a client-side validation error when neither selector nor x/y are given', async () => {
    const client = { browserClick: mock(async () => ({})) }
    spies.push(spyOn(factory, 'getSandboxManager').mockReturnValue(fakeManager(client)))

    const tools = createBrowserTools(RUN_ID, SANDBOX_ID)
    const clickTool = tools.find((t) => t.name === 'browser_click')!
    const result = await clickTool.execute('call-1', {}, undefined, undefined, {} as any)

    expect((result.content[0] as any).text).toBe('Error: Provide either a selector or x/y coordinates.')
    expect(client.browserClick).not.toHaveBeenCalled()
  })

  test('maps a 503 BROWSER_UNAVAILABLE SandboxHttpError to the unavailable message', async () => {
    const client = {
      browserOpen: mock(async () => {
        throw new SandboxHttpError('service unavailable', 503, 'BROWSER_UNAVAILABLE')
      }),
    }
    spies.push(spyOn(factory, 'getSandboxManager').mockReturnValue(fakeManager(client)))

    const tools = createBrowserTools(RUN_ID, SANDBOX_ID)
    const openTool = tools.find((t) => t.name === 'browser_open')!
    const result = await openTool.execute('call-1', { url: 'https://example.com' }, undefined, undefined, {} as any)

    expect((result.content[0] as any).text).toBe('Error: Browser is unavailable on this machine.')
  })

  test('maps a 404 SandboxHttpError on a non-open verb to the "no page open" message', async () => {
    const client = {
      browserClick: mock(async () => {
        throw new SandboxHttpError('not found', 404)
      }),
    }
    spies.push(spyOn(factory, 'getSandboxManager').mockReturnValue(fakeManager(client)))

    const tools = createBrowserTools(RUN_ID, SANDBOX_ID)
    const clickTool = tools.find((t) => t.name === 'browser_click')!
    const result = await clickTool.execute('call-1', { x: 1, y: 2 }, undefined, undefined, {} as any)

    expect((result.content[0] as any).text).toBe(
      'Error: No page is open in this browser session — use browser_open with a URL first.'
    )
  })

  test('maps a 404 SandboxHttpError on browser_open to the stale-box message, not the "no page open" advice', async () => {
    const client = {
      browserOpen: mock(async () => {
        throw new SandboxHttpError('not found', 404)
      }),
    }
    spies.push(spyOn(factory, 'getSandboxManager').mockReturnValue(fakeManager(client)))

    const tools = createBrowserTools(RUN_ID, SANDBOX_ID)
    const openTool = tools.find((t) => t.name === 'browser_open')!
    const result = await openTool.execute('call-1', { url: 'https://example.com' }, undefined, undefined, {} as any)

    const text = (result.content[0] as any).text
    expect(text).toBe(
      'Error: Browser routes are unavailable on this box (stale sandbox server) — the box will gain browser support when it is next recreated.'
    )
    expect(text).not.toContain('use browser_open with a URL first')
  })

  test('passes a 429 SandboxHttpError message through unchanged', async () => {
    const client = {
      browserOpen: mock(async () => {
        throw new SandboxHttpError('Too many requests, retry in 2s', 429)
      }),
    }
    spies.push(spyOn(factory, 'getSandboxManager').mockReturnValue(fakeManager(client)))

    const tools = createBrowserTools(RUN_ID, SANDBOX_ID)
    const openTool = tools.find((t) => t.name === 'browser_open')!
    const result = await openTool.execute('call-1', { url: 'https://example.com' }, undefined, undefined, {} as any)

    expect((result.content[0] as any).text).toBe('Error: Too many requests, retry in 2s')
  })

  test('surfaces a connection-level error message as-is', async () => {
    const client = {
      browserOpen: mock(async () => {
        throw new Error('Sandbox is not reachable (pod may be starting or stopped). URL: http://x')
      }),
    }
    spies.push(spyOn(factory, 'getSandboxManager').mockReturnValue(fakeManager(client)))

    const tools = createBrowserTools(RUN_ID, SANDBOX_ID)
    const openTool = tools.find((t) => t.name === 'browser_open')!
    const result = await openTool.execute('call-1', { url: 'https://example.com' }, undefined, undefined, {} as any)

    expect((result.content[0] as any).text).toBe(
      'Error: Sandbox is not reachable (pod may be starting or stopped). URL: http://x'
    )
  })

  test('browser_read does not truncate text at exactly the 10000-char limit', async () => {
    const exactText = 'x'.repeat(10000)
    const client = { browserRead: mock(async () => ({ text: exactText })) }
    spies.push(spyOn(factory, 'getSandboxManager').mockReturnValue(fakeManager(client)))

    const tools = createBrowserTools(RUN_ID, SANDBOX_ID)
    const readTool = tools.find((t) => t.name === 'browser_read')!
    const result = await readTool.execute('call-1', {}, undefined, undefined, {} as any)

    const text = (result.content[0] as any).text
    expect(text).toBe(exactText)
    expect(text).not.toContain('truncated')
    expect(result.details).toEqual({ length: 10000, truncated: false })
  })

  test('browser_read truncates text one char past the 10000-char limit, at the exact boundary', async () => {
    const overText = 'x'.repeat(10001)
    const client = { browserRead: mock(async () => ({ text: overText })) }
    spies.push(spyOn(factory, 'getSandboxManager').mockReturnValue(fakeManager(client)))

    const tools = createBrowserTools(RUN_ID, SANDBOX_ID)
    const readTool = tools.find((t) => t.name === 'browser_read')!
    const result = await readTool.execute('call-1', {}, undefined, undefined, {} as any)

    const text = (result.content[0] as any).text
    const suffix = '\n\n... (truncated)'
    expect(text).toBe('x'.repeat(10000) + suffix)
    expect(text.length).toBe(10000 + suffix.length)
    expect(result.details).toEqual({ length: 10001, truncated: true })
  })

  test('browser_read truncates well past the boundary and reports the original length', async () => {
    const longText = 'x'.repeat(15000)
    const client = { browserRead: mock(async () => ({ text: longText })) }
    spies.push(spyOn(factory, 'getSandboxManager').mockReturnValue(fakeManager(client)))

    const tools = createBrowserTools(RUN_ID, SANDBOX_ID)
    const readTool = tools.find((t) => t.name === 'browser_read')!
    const result = await readTool.execute('call-1', {}, undefined, undefined, {} as any)

    const text = (result.content[0] as any).text
    expect(text).toContain('... (truncated)')
    expect(text.length).toBeLessThan(15000)
    expect(result.details).toEqual({ length: 15000, truncated: true })
  })

  test('browser_read returns full text untruncated when under the limit', async () => {
    const client = { browserRead: mock(async () => ({ text: 'short text' })) }
    spies.push(spyOn(factory, 'getSandboxManager').mockReturnValue(fakeManager(client)))

    const tools = createBrowserTools(RUN_ID, SANDBOX_ID)
    const readTool = tools.find((t) => t.name === 'browser_read')!
    const result = await readTool.execute('call-1', {}, undefined, undefined, {} as any)

    expect((result.content[0] as any).text).toBe('short text')
    expect(result.details).toEqual({ length: 10, truncated: false })
  })

  test('browser_console formats empty entries', async () => {
    const client = { browserConsole: mock(async () => ({ entries: [] })) }
    spies.push(spyOn(factory, 'getSandboxManager').mockReturnValue(fakeManager(client)))

    const tools = createBrowserTools(RUN_ID, SANDBOX_ID)
    const consoleTool = tools.find((t) => t.name === 'browser_console')!
    const result = await consoleTool.execute('call-1', {}, undefined, undefined, {} as any)

    expect((result.content[0] as any).text).toBe('No console entries.')
    expect(result.details).toEqual({ count: 0 })
  })

  test('browser_console formats log entries', async () => {
    const client = {
      browserConsole: mock(async () => ({
        entries: [
          { type: 'log', text: 'hello world' },
          { type: 'error', text: 'something broke' },
        ],
      })),
    }
    spies.push(spyOn(factory, 'getSandboxManager').mockReturnValue(fakeManager(client)))

    const tools = createBrowserTools(RUN_ID, SANDBOX_ID)
    const consoleTool = tools.find((t) => t.name === 'browser_console')!
    const result = await consoleTool.execute('call-1', {}, undefined, undefined, {} as any)

    expect((result.content[0] as any).text).toBe('[log] hello world\n[error] something broke')
    expect(result.details).toEqual({ count: 2 })
  })

  test('returns the null-client error when no sandbox is running', async () => {
    spies.push(spyOn(factory, 'getSandboxManager').mockReturnValue(fakeManager(null)))

    const tools = createBrowserTools(RUN_ID, SANDBOX_ID)
    const openTool = tools.find((t) => t.name === 'browser_open')!
    const result = await openTool.execute('call-1', { url: 'https://example.com' }, undefined, undefined, {} as any)

    expect((result.content[0] as any).text).toBe(
      'Error: Sandbox is not running — browser tools need the agent sandbox up.'
    )
  })

  test('browser_open returns the no-sandbox error, not a throw, when the manager exposes neither browser surface', async () => {
    // A manager with neither getBrowserBackend nor getClientForSandbox must
    // degrade to the normal NO_SANDBOX_ERROR result rather than throwing a
    // TypeError out of the tool's execute().
    spies.push(spyOn(factory, 'getSandboxManager').mockReturnValue({} as any))

    const tools = createBrowserTools(RUN_ID, SANDBOX_ID)
    const openTool = tools.find((t) => t.name === 'browser_open')!
    const result = await openTool.execute('call-1', { url: 'https://example.com' }, undefined, undefined, {} as any)

    expect((result.content[0] as any).text).toBe(
      'Error: Sandbox is not running — browser tools need the agent sandbox up.'
    )
  })

  test('prefers the manager getBrowserBackend (host runtime drives the browser in-process)', async () => {
    const backend = {
      browserOpen: mock(async () => ({ title: 'Host Page', screenshotBase64: 'HOSTPNG' })),
    }
    const manager = {
      getBrowserBackend: mock(() => backend),
      getClientForSandbox: mock(() => null),
    } as any
    spies.push(spyOn(factory, 'getSandboxManager').mockReturnValue(manager))

    const tools = createBrowserTools(RUN_ID, SANDBOX_ID)
    const openTool = tools.find((t) => t.name === 'browser_open')!
    const result = await openTool.execute('call-1', { url: 'https://example.com' }, undefined, undefined, {} as any)

    expect(manager.getBrowserBackend).toHaveBeenCalledWith(SANDBOX_ID)
    expect(manager.getClientForSandbox).not.toHaveBeenCalled()
    expect(backend.browserOpen).toHaveBeenCalledWith(RUN_ID, 'https://example.com')
    const [textBlock, imageBlock] = result.content as any[]
    expect(textBlock.text).toBe('Page loaded: "Host Page" (https://example.com)')
    expect(imageBlock.data).toBe('HOSTPNG')
  })

  test('browser_screenshot returns an image-only result with no text block', async () => {
    const client = { browserScreenshot: mock(async () => ({ screenshotBase64: 'SHOTPNG' })) }
    spies.push(spyOn(factory, 'getSandboxManager').mockReturnValue(fakeManager(client)))

    const tools = createBrowserTools(RUN_ID, SANDBOX_ID)
    const screenshotTool = tools.find((t) => t.name === 'browser_screenshot')!
    const result = await screenshotTool.execute('call-1', {}, undefined, undefined, {} as any)

    expect(result.content.length).toBe(1)
    const [imageBlock] = result.content as any[]
    expect(imageBlock.type).toBe('image')
    expect(imageBlock.data).toBe('SHOTPNG')
    expect(imageBlock.mimeType).toBe('image/png')
  })

  test('click/type/scroll always request returnScreenshot and return the exact success text with the image', async () => {
    const client = {
      browserClick: mock(async () => ({ ok: true, screenshotBase64: 'CLICKPNG' })),
      browserType: mock(async () => ({ ok: true, screenshotBase64: 'TYPEPNG' })),
      browserScroll: mock(async () => ({ ok: true, deltaPx: 123, screenshotBase64: 'SCROLLPNG' })),
    }
    spies.push(spyOn(factory, 'getSandboxManager').mockReturnValue(fakeManager(client)))

    const tools = createBrowserTools(RUN_ID, SANDBOX_ID)
    const clickTool = tools.find((t) => t.name === 'browser_click')!
    const typeTool = tools.find((t) => t.name === 'browser_type')!
    const scrollTool = tools.find((t) => t.name === 'browser_scroll')!

    const clickResult = await clickTool.execute('call-1', { selector: '#btn' }, undefined, undefined, {} as any)
    expect(client.browserClick).toHaveBeenCalledWith(RUN_ID, {
      selector: '#btn',
      x: undefined,
      y: undefined,
      returnScreenshot: true,
    })
    expect((clickResult.content[0] as any).text).toBe('Clicked successfully.')
    expect((clickResult.content[1] as any).data).toBe('CLICKPNG')

    const typeResult = await typeTool.execute('call-1', { text: 'hi' }, undefined, undefined, {} as any)
    expect(client.browserType).toHaveBeenCalledWith(RUN_ID, {
      text: 'hi',
      selector: undefined,
      returnScreenshot: true,
    })
    expect((typeResult.content[0] as any).text).toBe('Typed text successfully.')
    expect((typeResult.content[1] as any).data).toBe('TYPEPNG')

    // amount is left at the schema default (500) client-side, but the server's deltaPx (123) wins
    // in the reported text — this pins that the server value is used, not a recomputed local one.
    const scrollResult = await scrollTool.execute('call-1', { direction: 'down' }, undefined, undefined, {} as any)
    expect(client.browserScroll).toHaveBeenCalledWith(RUN_ID, {
      direction: 'down',
      amount: undefined,
      returnScreenshot: true,
    })
    expect((scrollResult.content[0] as any).text).toBe('Scrolled down 123px.')
    expect((scrollResult.content[1] as any).data).toBe('SCROLLPNG')
  })

  test('scroll falls back to the client-computed delta when the server omits deltaPx', async () => {
    const client = {
      browserScroll: mock(async () => ({ ok: true, screenshotBase64: 'SCROLLPNG' })),
    }
    spies.push(spyOn(factory, 'getSandboxManager').mockReturnValue(fakeManager(client)))

    const tools = createBrowserTools(RUN_ID, SANDBOX_ID)
    const scrollTool = tools.find((t) => t.name === 'browser_scroll')!
    const result = await scrollTool.execute('call-1', { direction: 'up', amount: 200 }, undefined, undefined, {} as any)

    expect((result.content[0] as any).text).toBe('Scrolled up 200px.')
  })

  test('browser_open degrades to text-only when the server omits screenshotBase64', async () => {
    const client = { browserOpen: mock(async () => ({ title: 'T' })) }
    spies.push(spyOn(factory, 'getSandboxManager').mockReturnValue(fakeManager(client)))

    const tools = createBrowserTools(RUN_ID, SANDBOX_ID)
    const openTool = tools.find((t) => t.name === 'browser_open')!
    const result = await openTool.execute('call-1', { url: 'https://x.test' }, undefined, undefined, {} as any)
    expect(result.content.length).toBe(1)
    expect(result.content[0]).toEqual({
      type: 'text',
      text: 'Page loaded: "T" (https://x.test) (screenshot unavailable)',
    })
  })

  test('browser_screenshot returns an error, never an empty image, when the server omits screenshotBase64', async () => {
    const client = { browserScreenshot: mock(async () => ({ screenshotBase64: '' })) }
    spies.push(spyOn(factory, 'getSandboxManager').mockReturnValue(fakeManager(client)))

    const tools = createBrowserTools(RUN_ID, SANDBOX_ID)
    const shotTool = tools.find((t) => t.name === 'browser_screenshot')!
    const result = await shotTool.execute('call-1', {}, undefined, undefined, {} as any)
    expect(result.content.every((c: any) => c.type === 'text')).toBe(true)
    expect((result.content[0] as any).text).toContain('Screenshot unavailable')
  })

  test('click/type/scroll degrade to text-only when the server omits screenshotBase64 entirely', async () => {
    const client = {
      browserClick: mock(async () => ({ ok: true })),
      browserType: mock(async () => ({ ok: true })),
      browserScroll: mock(async () => ({ ok: true })),
    }
    spies.push(spyOn(factory, 'getSandboxManager').mockReturnValue(fakeManager(client)))

    const tools = createBrowserTools(RUN_ID, SANDBOX_ID)
    const clickTool = tools.find((t) => t.name === 'browser_click')!
    const typeTool = tools.find((t) => t.name === 'browser_type')!
    const scrollTool = tools.find((t) => t.name === 'browser_scroll')!

    const clickResult = await clickTool.execute('call-1', { selector: '#btn' }, undefined, undefined, {} as any)
    expect(clickResult.content.length).toBe(1)
    expect((clickResult.content[0] as any).type).toBe('text')
    expect((clickResult.content[0] as any).text).toBe('Clicked successfully. (screenshot unavailable)')

    const typeResult = await typeTool.execute('call-1', { text: 'hi' }, undefined, undefined, {} as any)
    expect(typeResult.content.length).toBe(1)
    expect((typeResult.content[0] as any).text).toBe('Typed text successfully. (screenshot unavailable)')

    const scrollResult = await scrollTool.execute('call-1', { direction: 'down' }, undefined, undefined, {} as any)
    expect(scrollResult.content.length).toBe(1)
    expect((scrollResult.content[0] as any).text).toBe('Scrolled down 500px. (screenshot unavailable)')
  })

  test('click degrades to text-only when the server returns an empty-string screenshot', async () => {
    const client = {
      browserClick: mock(async () => ({ ok: true, screenshotBase64: '' })),
    }
    spies.push(spyOn(factory, 'getSandboxManager').mockReturnValue(fakeManager(client)))

    const tools = createBrowserTools(RUN_ID, SANDBOX_ID)
    const clickTool = tools.find((t) => t.name === 'browser_click')!
    const result = await clickTool.execute('call-1', { selector: '#btn' }, undefined, undefined, {} as any)

    expect(result.content.length).toBe(1)
    expect((result.content[0] as any).type).toBe('text')
    expect((result.content[0] as any).text).toBe('Clicked successfully. (screenshot unavailable)')
  })

  test('resolves the sandbox client using the exact sandboxId passed to createBrowserTools', async () => {
    const client = { browserOpen: mock(async () => ({ title: 't', screenshotBase64: 'X' })) }
    const manager = fakeManager(client)
    spies.push(spyOn(factory, 'getSandboxManager').mockReturnValue(manager))

    const tools = createBrowserTools(RUN_ID, SANDBOX_ID)
    const openTool = tools.find((t) => t.name === 'browser_open')!
    await openTool.execute('call-1', { url: 'https://example.com' }, undefined, undefined, {} as any)

    expect(manager.getClientForSandbox).toHaveBeenCalledWith(SANDBOX_ID)
  })

  test('resolves the client fresh on every call, not once at factory time', async () => {
    const clientA = { browserOpen: mock(async () => ({ title: 'A', screenshotBase64: 'A_PNG' })) }
    const clientB = { browserOpen: mock(async () => ({ title: 'B', screenshotBase64: 'B_PNG' })) }
    const getSandboxManagerSpy = spyOn(factory, 'getSandboxManager')
    spies.push(getSandboxManagerSpy)

    getSandboxManagerSpy.mockReturnValueOnce(fakeManager(clientA))
    const tools = createBrowserTools(RUN_ID, SANDBOX_ID)
    const openTool = tools.find((t) => t.name === 'browser_open')!

    const first = await openTool.execute('call-1', { url: 'https://a.example' }, undefined, undefined, {} as any)
    expect((first.content[0] as any).text).toBe('Page loaded: "A" (https://a.example)')
    expect(clientA.browserOpen).toHaveBeenCalledTimes(1)

    getSandboxManagerSpy.mockReturnValueOnce(fakeManager(clientB))
    const second = await openTool.execute('call-1', { url: 'https://b.example' }, undefined, undefined, {} as any)
    expect((second.content[0] as any).text).toBe('Page loaded: "B" (https://b.example)')
    expect(clientB.browserOpen).toHaveBeenCalledTimes(1)
    // The first client must not have been reused for the second call.
    expect(clientA.browserOpen).toHaveBeenCalledTimes(1)
  })
})
