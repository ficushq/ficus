import { Command } from 'commander'
import { apiGet, apiPost } from '../client'
import { output, outputError, isJsonMode } from '../output'

interface MemoryWriteResult {
  success: boolean
  path: string
  deleted?: boolean
  error?: {
    code: string
    message: string
    details?: Record<string, unknown>
  }
}

interface MemoryReadResult {
  path: string
  content: string
}

interface MemoryListResult {
  path: string
  entries: Array<{
    name: string
    path: string
    type: 'file' | 'directory'
  }>
}

interface SearchResult {
  documentId: string
  path: string | null
  title: string | null
  sourceType?: string | null
  score: number
  snippet: string
  chunkIndex: number
}

interface BacklinkResult {
  sourcePath: string
  sourceTitle: string | null
  heading: string | null
}

export function registerMemoryCommands(program: Command): void {
  const memory = program.command('memory').description('Memory vault operations')

  // ficus memory search <query> --squad <id> --limit N --mode <mode> --source-type <type> --kind <kind> --tag <tag> --path <glob>
  memory
    .command('search <query>')
    .description('Search memory documents using hybrid retrieval')
    .requiredOption('--squad <squadId>', 'Squad ID')
    .option('--limit <n>', 'Maximum results (default: 10)', '10')
    .option('--mode <mode>', 'Search mode: hybrid, vector, keyword', 'hybrid')
    .option('--source-type <types...>', 'Filter by source type (memory_file, workspace_file)')
    .option('--kind <kinds...>', 'Filter by frontmatter kind (decision, pattern, etc.)')
    .option('--tag <tags...>', 'Filter by frontmatter tags (matches any)')
    .option('--path <globs...>', 'Filter by path glob patterns (decisions/**, patterns/*.md)')
    .action(async (query, options) => {
      try {
        const params = new URLSearchParams()
        params.set('query', query)
        params.set('limit', options.limit)
        params.set('mode', options.mode)

        // Add filter parameters
        if (options.sourceType?.length) {
          params.set('sourceTypes', options.sourceType.join(','))
        }
        if (options.kind?.length) {
          params.set('kinds', options.kind.join(','))
        }
        if (options.tag?.length) {
          params.set('tags', options.tag.join(','))
        }
        if (options.path?.length) {
          params.set('paths', options.path.join(','))
        }

        const results = await apiGet<SearchResult[]>(`/api/memory/${options.squad}/search?${params}`)

        if (isJsonMode()) {
          output(results)
        } else {
          if (results.length === 0) {
            console.log('No matching documents found.')
            return
          }

          console.log(`Found ${results.length} result(s):\n`)
          for (const r of results) {
            const label = formatSearchResultLabel(r)
            console.log(`${label}${r.title && r.title !== label ? ` — ${r.title}` : ''}`)
            console.log(`  Score: ${r.score.toFixed(3)}`)
            console.log(`  ${r.snippet.slice(0, 150)}${r.snippet.length > 150 ? '...' : ''}`)
            console.log()
          }
        }
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus memory get <path> --squad <id>
  memory
    .command('get <path>')
    .description('Read a memory file')
    .requiredOption('--squad <squadId>', 'Squad ID')
    .action(async (path, options) => {
      try {
        const params = new URLSearchParams()
        params.set('path', path)

        const result = await apiGet<MemoryReadResult>(`/api/memory/${options.squad}/file?${params}`)

        if (isJsonMode()) {
          output(result)
        } else {
          console.log(`# ${path}\n`)
          console.log(result.content)
        }
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus memory list [path] --squad <id>
  memory
    .command('list [path]')
    .description('List files in a memory directory')
    .requiredOption('--squad <squadId>', 'Squad ID')
    .action(async (path = '/memory', options) => {
      try {
        const params = new URLSearchParams()
        params.set('path', path)

        const result = await apiGet<MemoryListResult>(`/api/memory/${options.squad}/list?${params}`)

        if (isJsonMode()) {
          output(result)
        } else {
          if (result.entries.length === 0) {
            console.log(`No entries found in ${result.path}`)
            return
          }

          for (const entry of result.entries) {
            console.log(`${entry.type === 'directory' ? 'dir ' : 'file'}  ${entry.path}`)
          }
        }
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus memory write <path> --squad <id> --content <content>
  // or: ficus memory write <path> --squad <id> < file.md
  // or: ficus memory write <path> --squad <id> --delete
  memory
    .command('write <path>')
    .description('Write (overwrite) a memory file, or delete it with --delete')
    .requiredOption('--squad <squadId>', 'Squad ID')
    .option('--content <content>', 'Content to write (or pipe content via stdin)')
    .option('--delete', 'Delete the file instead of writing')
    .action(async (path, options) => {
      try {
        let content: string | null = options.content ?? null

        if (options.delete) {
          // Delete mode - send null content
          content = null
        } else if (!content) {
          // If no content option and not deleting, read from stdin
          content = await readStdin()
          if (!content) {
            console.error('Error: --content, stdin input, or --delete required')
            process.exit(1)
          }
        }

        const result = await apiPost<MemoryWriteResult>(`/api/memory/${options.squad}/write`, { path, content })

        if (!result.success) {
          if (isJsonMode()) {
            output(result)
          } else {
            console.error(`Error: ${result.error?.message}`)
            console.error(`Code: ${result.error?.code}`)
          }
          process.exit(1)
        }

        if (result.deleted) {
          output(result, `Successfully deleted ${path}`)
        } else {
          output(result, `Successfully wrote ${path}`)
        }
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus memory patch <path> --squad <id> --match <text> --replace <text>
  memory
    .command('patch <path>')
    .description('Patch a memory file (exact match replacement)')
    .requiredOption('--squad <squadId>', 'Squad ID')
    .requiredOption('--match <text>', 'Exact text to find and replace')
    .requiredOption('--replace <text>', 'Replacement text')
    .action(async (path, options) => {
      try {
        const result = await apiPost<MemoryWriteResult>(`/api/memory/${options.squad}/patch`, {
          path,
          match: options.match,
          replacement: options.replace,
        })

        if (!result.success) {
          if (isJsonMode()) {
            output(result)
          } else {
            console.error(`Error: ${result.error?.message}`)
            console.error(`Code: ${result.error?.code}`)
            if (result.error?.code === 'PATCH_AMBIGUOUS_MATCH') {
              const count = result.error.details?.matchCount ?? 'multiple'
              console.error(`\nThe match string appears ${count} times. Use a more specific match.`)
            }
          }
          process.exit(1)
        }

        output(result, `Successfully patched ${path}`)
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus memory append <path> --squad <id> --content <content>
  memory
    .command('append <path>')
    .description('Append content to a memory file')
    .requiredOption('--squad <squadId>', 'Squad ID')
    .option('--content <content>', 'Content to append (or pipe content via stdin)')
    .option('--newline', 'Ensure a newline before appending')
    .action(async (path, options) => {
      try {
        let content = options.content

        // If no content option, read from stdin
        if (!content) {
          content = await readStdin()
          if (!content) {
            console.error('Error: --content or stdin input required')
            process.exit(1)
          }
        }

        const result = await apiPost<MemoryWriteResult>(`/api/memory/${options.squad}/append`, {
          path,
          content,
          ensureNewline: options.newline,
        })

        if (!result.success) {
          if (isJsonMode()) {
            output(result)
          } else {
            console.error(`Error: ${result.error?.message}`)
            console.error(`Code: ${result.error?.code}`)
          }
          process.exit(1)
        }

        output(result, `Successfully appended to ${path}`)
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus memory backlinks <path> --squad <id>
  memory
    .command('backlinks <path>')
    .description('Get documents that link to a memory file')
    .requiredOption('--squad <squadId>', 'Squad ID')
    .action(async (path, options) => {
      try {
        const params = new URLSearchParams()
        params.set('path', path)

        const results = await apiGet<BacklinkResult[]>(`/api/memory/${options.squad}/backlinks?${params}`)

        if (isJsonMode()) {
          output(results)
        } else {
          if (results.length === 0) {
            console.log(`No backlinks found for ${path}`)
            return
          }

          console.log(`Backlinks to ${path}:\n`)
          for (const r of results) {
            console.log(`- ${r.sourcePath}${r.heading ? ` (heading: ${r.heading})` : ''}`)
          }
        }
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus memory sync <action> --squad <id>
  const sync = memory.command('sync').description('Memory sync operations')

  sync
    .command('pull')
    .description('Pull changes from remote sync provider')
    .requiredOption('--squad <squadId>', 'Squad ID')
    .action(async (options) => {
      try {
        const result = await apiPost(`/api/memory/${options.squad}/sync/pull`, {})
        output(result, 'Sync pull completed')
      } catch (error) {
        outputError(error as Error)
      }
    })

  sync
    .command('push')
    .description('Push local changes to remote sync provider')
    .requiredOption('--squad <squadId>', 'Squad ID')
    .action(async (options) => {
      try {
        const result = await apiPost(`/api/memory/${options.squad}/sync/push`, {})
        output(result, 'Sync push completed')
      } catch (error) {
        outputError(error as Error)
      }
    })

  sync
    .command('status')
    .description('Show sync status')
    .requiredOption('--squad <squadId>', 'Squad ID')
    .action(async (options) => {
      try {
        const result = await apiGet(`/api/memory/${options.squad}/sync/status`)
        if (isJsonMode()) {
          output(result)
        } else {
          console.log('Sync Status:')
          console.log(JSON.stringify(result, null, 2))
        }
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus memory reindex --squad <id> --source <source>
  memory
    .command('reindex')
    .description('Reindex memory documents')
    .requiredOption('--squad <squadId>', 'Squad ID')
    .option('--source <source>', 'Source type: memory_file, workspace_file, or all', 'all')
    .action(async (options) => {
      try {
        const result = await apiPost(`/api/memory/${options.squad}/reindex`, {
          source: options.source,
        })
        output(result, 'Reindex completed')
      } catch (error) {
        outputError(error as Error)
      }
    })
}

/**
 * Read content from stdin (for piped input).
 */
function formatSearchResultLabel(result: SearchResult): string {
  if (result.path) return result.path
  if (result.title) return result.title
  if (result.sourceType === 'agent_thread') return `Agent thread ${result.documentId}`
  return result.documentId || 'Unknown source'
}

async function readStdin(): Promise<string> {
  // Check if stdin has data
  if (process.stdin.isTTY) {
    return ''
  }

  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf-8')
}
