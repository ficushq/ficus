import { describe, expect, test } from 'bun:test'
import { detectLocalServers, probeOpenAICompatible, type ProviderFetch } from './openai-compatible'

describe('openai-compatible providers', () => {
  test('does not probe in the background', async () => {
    const moduleUrl = new URL('./openai-compatible.ts', import.meta.url).href
    const subprocess = Bun.spawn(
      [
        process.execPath,
        '--eval',
        `
          let calls = 0
          globalThis.fetch = async () => {
            calls++
            throw new Error('unexpected background probe')
          }
          await import(${JSON.stringify(moduleUrl)})
          await Bun.sleep(20)
          console.log(calls)
        `,
      ],
      { stdout: 'pipe', stderr: 'pipe' }
    )

    const [exitCode, stdout, stderr] = await Promise.all([
      subprocess.exited,
      new Response(subprocess.stdout).text(),
      new Response(subprocess.stderr).text(),
    ])
    expect(exitCode, stderr).toBe(0)
    expect(stdout.trim()).toBe('0')
  })
  test('marks a model without a tool call as tools false', async () => {
    const fetcher: ProviderFetch = async (_url, init) => {
      if (init?.method !== 'POST') return Response.json({ data: [{ id: 'local-model' }] })
      return Response.json({ choices: [{ message: { content: 'no tool call' } }] })
    }
    const result = await probeOpenAICompatible({ baseUrl: 'http://localhost:8080', model: 'local-model', fetcher })
    expect(result.models).toEqual(['local-model'])
    expect(result.capabilities.tools).toBe(false)
  })

  test('recognizes a successful trivial tool call', async () => {
    const fetcher: ProviderFetch = async (_url, init) =>
      init?.method === 'POST'
        ? Response.json({ choices: [{ message: { tool_calls: [{ function: { name: 'ficus_probe' } }] } }] })
        : Response.json({ data: [{ id: 'tools-model' }] })
    const result = await probeOpenAICompatible({ baseUrl: 'http://localhost:1234/v1', model: 'tools-model', fetcher })
    expect(result.capabilities.tools).toBe(true)
  })

  test('rejects non-http base URL schemes before probing', async () => {
    await expect(probeOpenAICompatible({ baseUrl: 'file:///tmp/provider', model: 'local-model' })).rejects.toThrow(
      'baseUrl must use http or https'
    )
  })

  test('honors the configured detection timeout', async () => {
    const fetcher: ProviderFetch = async (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
      })
    const started = Date.now()
    expect(await detectLocalServers({ fetcher, timeoutMs: 5 })).toEqual([])
    expect(Date.now() - started).toBeLessThan(100)
  })

  test('explicit detection reports partial results from only well-known ports', async () => {
    const seen: string[] = []
    const fetcher: ProviderFetch = async (url) => {
      seen.push(String(url))
      if (String(url).includes(':11434')) return Response.json({ data: [{ id: 'ollama-model' }] })
      throw new Error('silent')
    }
    const found = await detectLocalServers({ fetcher, timeoutMs: 5 })
    expect(seen.map((url) => new URL(url).port)).toEqual(['8080', '11434', '1234', '8000'])
    expect(found).toEqual([{ baseUrl: 'http://localhost:11434/v1', models: ['ollama-model'] }])
  })
})
