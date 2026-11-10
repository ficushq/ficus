import { Type } from '@sinclair/typebox'
import type { ToolDefinition, AgentToolResult } from '@earendil-works/pi-coding-agent'
import { truncateHead, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from '@earendil-works/pi-coding-agent'
import { Text } from '@earendil-works/pi-tui'
import { Readability } from '@mozilla/readability'
import { JSDOM } from 'jsdom'
import TurndownService from 'turndown'
import { gfm } from 'turndown-plugin-gfm'

const MAX_RESPONSE_SIZE = 5 * 1024 * 1024
const DEFAULT_TIMEOUT_SECONDS = 30
const MAX_TIMEOUT_SECONDS = 120
const EXA_SEARCH_TIMEOUT_MS = 25_000
const DEFAULT_NUM_RESULTS = 8
const EXA_MCP_URL = 'https://mcp.exa.ai/mcp'

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36'

const WebFetchSchema = Type.Object({
  url: Type.String({ description: 'The URL to fetch content from' }),
  format: Type.Optional(
    Type.Union([Type.Literal('markdown'), Type.Literal('text'), Type.Literal('html')], {
      description: "Output format: 'markdown' (default), 'text', or 'html'",
    })
  ),
  timeout: Type.Optional(Type.Number({ description: 'Timeout in seconds (default 30, max 120)' })),
})

const WebSearchSchema = Type.Object({
  query: Type.String({ description: 'Search query' }),
  numResults: Type.Optional(Type.Number({ description: 'Number of results to return (default: 8)' })),
  type: Type.Optional(
    Type.Union([Type.Literal('auto'), Type.Literal('fast'), Type.Literal('deep')], {
      description: "Search type: 'auto' (default), 'fast', or 'deep'",
    })
  ),
  livecrawl: Type.Optional(
    Type.Union([Type.Literal('fallback'), Type.Literal('preferred')], {
      description: "Live crawl mode: 'fallback' (default) or 'preferred'",
    })
  ),
  contextMaxCharacters: Type.Optional(Type.Number({ description: 'Max characters for context (default: 10000)' })),
})

export type WebToolWithKey = ToolDefinition & { key: string }
export type WebSearchToolWithKey = WebToolWithKey

function convertHtmlToMarkdown(html: string): string {
  const turndown = new TurndownService({
    headingStyle: 'atx',
    hr: '---',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '*',
  })
  turndown.use(gfm)
  turndown.remove(['script', 'style', 'meta', 'link', 'noscript'])
  turndown.addRule('removeEmptyLinks', {
    filter: (node: any) => node.nodeName === 'A' && !node.textContent?.trim(),
    replacement: () => '',
  })

  return turndown
    .turndown(html)
    .replace(/\[\\?\[\s*\\?\]\]\([^)]*\)/g, '')
    .replace(/ +/g, ' ')
    .replace(/\s+,/g, ',')
    .replace(/\s+\./g, '.')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function extractReadableContent(html: string, url: string): { title?: string; content: string } | null {
  try {
    const dom = new JSDOM(html, { url })
    const reader = new Readability(dom.window.document)
    const article = reader.parse()
    if (article?.content) return { title: article.title || undefined, content: article.content }
  } catch {
    return null
  }
  return null
}

function extractTextFromHtml(html: string): string {
  const dom = new JSDOM(html)
  const doc = dom.window.document
  doc.querySelectorAll('script, style, noscript, iframe, object, embed').forEach((el: Element) => el.remove())
  const main = doc.querySelector("main, article, [role='main'], .content, #content") || doc.body
  return main?.textContent?.trim() || ''
}

function truncateOutput(text: string): string {
  const truncation = truncateHead(text, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES })
  if (!truncation.truncated) return text

  return `${truncation.content}\n\n[Output truncated: showing ${formatSize(Buffer.byteLength(truncation.content, 'utf-8'))} of ${formatSize(Buffer.byteLength(text, 'utf-8'))}]`
}

function getAcceptHeader(format: string): string {
  switch (format) {
    case 'markdown':
      return 'text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1'
    case 'text':
      return 'text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1'
    case 'html':
      return 'text/html;q=1.0, application/xhtml+xml;q=0.9, */*;q=0.1'
    default:
      return 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
  }
}

export function createWebFetchTool(): WebToolWithKey {
  return {
    name: 'webfetch',
    key: 'webfetch',
    label: 'Web Fetch',
    description: [
      'Fetch content from a URL and return it as markdown, text, or HTML.',
      '- URL must start with http:// or https://',
      "- Format options: 'markdown' (default), 'text', or 'html'",
      '- Converts HTML to clean readable markdown by default',
      '- Use for reading documentation, articles, web pages',
      '- Results may be truncated if the content is very large',
      '- Optional timeout in seconds (default 30, max 120)',
    ].join('\n'),
    parameters: WebFetchSchema,
    async execute(
      _toolCallId,
      params: { url: string; format?: string; timeout?: number },
      signal
    ): Promise<AgentToolResult<unknown>> {
      const url = params.url
      const format = params.format || 'markdown'

      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        throw new Error('URL must start with http:// or https://')
      }

      const timeout = Math.min(params.timeout ?? DEFAULT_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS) * 1000
      const headers = {
        'User-Agent': USER_AGENT,
        Accept: getAcceptHeader(format),
        'Accept-Language': 'en-US,en;q=0.9',
      }

      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), timeout)
      signal?.addEventListener('abort', () => controller.abort(), { once: true })

      try {
        const initial = await fetch(url, { signal: controller.signal, headers })
        const response =
          initial.status === 403 && initial.headers.get('cf-mitigated') === 'challenge'
            ? await fetch(url, { signal: controller.signal, headers: { ...headers, 'User-Agent': 'pi-coding-agent' } })
            : initial

        if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`)

        const contentLength = response.headers.get('content-length')
        if (contentLength && parseInt(contentLength) > MAX_RESPONSE_SIZE) {
          throw new Error('Response too large (exceeds 5MB limit)')
        }

        const arrayBuffer = await response.arrayBuffer()
        if (arrayBuffer.byteLength > MAX_RESPONSE_SIZE) throw new Error('Response too large (exceeds 5MB limit)')

        const contentType = response.headers.get('content-type') || ''
        const isHtml = contentType.includes('text/html')
        const raw = new TextDecoder().decode(arrayBuffer)

        let output: string
        if (format === 'markdown' && isHtml) {
          const article = extractReadableContent(raw, url)
          output = article
            ? `${article.title ? `# ${article.title}\n\n` : ''}${convertHtmlToMarkdown(article.content)}`
            : convertHtmlToMarkdown(raw)
        } else if (format === 'text' && isHtml) {
          output = extractTextFromHtml(raw)
        } else {
          output = raw
        }

        return {
          content: [{ type: 'text', text: truncateOutput(output) }],
          details: { url, format, contentType, size: arrayBuffer.byteLength },
        }
      } catch (err: any) {
        throw new Error(err.name === 'AbortError' ? 'Request timed out' : err.message, { cause: err })
      } finally {
        clearTimeout(timeoutId)
      }
    },
    renderCall(args: any, theme: any) {
      const url = args.url || ''
      const format = args.format && args.format !== 'markdown' ? ` (${args.format})` : ''
      const display = url.length > 80 ? `${url.slice(0, 77)}...` : url
      return new Text(
        theme.fg('toolTitle', theme.bold('webfetch ')) + theme.fg('muted', display) + theme.fg('dim', format),
        0,
        0
      )
    },
    renderResult(result: any, _opts: any, theme: any, context: any) {
      if (context.isError) {
        const text = result.content?.[0]
        return new Text(theme.fg('error', text?.type === 'text' ? text.text : 'Error'), 0, 0)
      }
      const details = result.details || {}
      const size = details.size ? formatSize(details.size) : ''
      const contentType = details.contentType ? details.contentType.split(';')[0] : ''
      return new Text(
        theme.fg('success', '✓ ') + theme.fg('muted', [contentType, size].filter(Boolean).join(', ')),
        0,
        0
      )
    },
  }
}

export function createWebSearchTool(): WebSearchToolWithKey {
  return {
    name: 'websearch',
    key: 'websearch',
    label: 'Web Search',
    description: [
      'Search the web for information using Exa AI. No API key required.',
      '- Performs real-time web searches with up-to-date results',
      '- Returns content from the most relevant websites',
      '- Supports configurable result counts (default: 8)',
      "- Search types: 'auto' (balanced, default), 'fast' (quick), 'deep' (comprehensive)",
      "- Live crawl modes: 'fallback' (default) or 'preferred'",
      '- Use websearch for discovery, webfetch for retrieving a specific URL',
      `- The current year is ${new Date().getFullYear()}. Use the current year when searching for recent information.`,
    ].join('\n'),
    parameters: WebSearchSchema,
    async execute(
      _toolCallId,
      params: { query: string; numResults?: number; type?: string; livecrawl?: string; contextMaxCharacters?: number },
      signal
    ): Promise<AgentToolResult<unknown>> {
      const numResults = params.numResults || DEFAULT_NUM_RESULTS
      const searchRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'web_search_exa',
          arguments: {
            query: params.query,
            type: params.type || 'auto',
            numResults,
            livecrawl: params.livecrawl || 'fallback',
            contextMaxCharacters: params.contextMaxCharacters,
          },
        },
      }

      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), EXA_SEARCH_TIMEOUT_MS)
      signal?.addEventListener('abort', () => controller.abort(), { once: true })

      try {
        const response = await fetch(EXA_MCP_URL, {
          method: 'POST',
          headers: { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' },
          body: JSON.stringify(searchRequest),
          signal: controller.signal,
        })

        if (!response.ok) throw new Error(`Search error (HTTP ${response.status}): ${await response.text()}`)

        const responseText = await response.text()
        const resultText = extractExaResultText(responseText)
        return {
          content: [
            {
              type: 'text',
              text: resultText ? truncateOutput(resultText) : 'No search results found. Try a different query.',
            },
          ],
          details: { query: params.query, numResults },
        }
      } catch (err: any) {
        throw new Error(err.name === 'AbortError' ? 'Search request timed out' : err.message, { cause: err })
      } finally {
        clearTimeout(timeoutId)
      }
    },
    renderCall(args: any, theme: any) {
      const query = args.query || ''
      const display = query.length > 80 ? `${query.slice(0, 77)}...` : query
      const extra = args.type && args.type !== 'auto' ? ` (${args.type})` : ''
      return new Text(
        theme.fg('toolTitle', theme.bold('websearch ')) + theme.fg('muted', `"${display}"`) + theme.fg('dim', extra),
        0,
        0
      )
    },
    renderResult(result: any, _opts: any, theme: any, context: any) {
      if (context.isError) {
        const text = result.content?.[0]
        return new Text(theme.fg('error', text?.type === 'text' ? text.text : 'Error'), 0, 0)
      }
      const details = result.details || {}
      const content = result.content?.[0]?.text || ''
      const lines = content.split('\n').length
      const size = formatSize(Buffer.byteLength(content, 'utf-8'))
      return new Text(
        theme.fg('success', '✓ ') +
          theme.fg('muted', `${lines} lines, ${size}`) +
          (details.query ? theme.fg('dim', ` — "${details.query}"`) : ''),
        0,
        0
      )
    },
  }
}

function extractExaResultText(responseText: string): string | undefined {
  for (const line of responseText.split('\n')) {
    if (!line.startsWith('data: ')) continue
    try {
      const data = JSON.parse(line.substring(6))
      const text = data.result?.content?.[0]?.text
      if (text) return text
    } catch {
      continue
    }
  }

  try {
    const data = JSON.parse(responseText)
    return data.result?.content?.[0]?.text
  } catch {
    return undefined
  }
}

export function createWebTools(): WebToolWithKey[] {
  return [createWebFetchTool(), createWebSearchTool()]
}
