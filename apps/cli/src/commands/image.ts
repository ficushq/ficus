import { readFileSync, writeFileSync, existsSync } from 'fs'
import { extname } from 'path'
import { Command } from 'commander'
import { apiPost, apiGetRaw } from '../client'
import { output, outputError, isJsonMode } from '../output'

const MIME_MAP: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}

export function registerImageCommands(program: Command) {
  const image = program.command('image').description('Manage images')

  // ficus image upload <file...> [--agent <agentId>]
  image
    .command('upload <file...>')
    .description('Upload one or more images')
    .option('-a, --agent <agentId>', 'Associate with an agent')
    .action(async (files: string[], options) => {
      try {
        const images = []
        for (const file of files) {
          if (!existsSync(file)) {
            throw new Error(`File not found: ${file}`)
          }
          const ext = extname(file).toLowerCase()
          const mimeType = MIME_MAP[ext]
          if (!mimeType) {
            throw new Error(`Unsupported image format: ${ext} (supported: ${Object.keys(MIME_MAP).join(', ')})`)
          }
          const data = readFileSync(file).toString('base64')
          images.push({ type: 'image', data, mimeType })
        }

        const body: Record<string, unknown> = { images }
        if (options.agent) body.agentId = options.agent

        const result = await apiPost<{ imageIds: string[] }>('/api/images', body)
        output(result, `Uploaded ${result.imageIds.length} image(s): ${result.imageIds.join(', ')}`)
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus image get <id> [--out <filepath>]
  image
    .command('get <id>')
    .alias('download')
    .description('Download an image')
    .option('-o, --out <filepath>', 'Save to file')
    .action(async (id, options) => {
      try {
        // Image bytes are served only from signed URLs; ask for one (this checks the caller may read it).
        const { urls } = await apiPost<{ urls: Record<string, string> }>('/api/images/sign-urls', { ids: [id] })
        const signed = urls[id]
        if (!signed) throw new Error(`Image ${id} not found, or you cannot read it`)
        const response = await apiGetRaw(signed)
        const contentType = response.headers.get('content-type') || 'unknown'
        const arrayBuffer = await response.arrayBuffer()
        const buffer = Buffer.from(arrayBuffer)

        if (isJsonMode()) {
          output({ id, mimeType: contentType, size: buffer.length })
        } else if (options.out) {
          writeFileSync(options.out, buffer)
          console.log(`Saved ${buffer.length} bytes to ${options.out}`)
        } else {
          process.stdout.write(buffer)
        }
      } catch (error) {
        outputError(error as Error)
      }
    })
}
