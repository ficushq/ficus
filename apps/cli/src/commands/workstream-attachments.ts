import { writeFileSync } from 'node:fs'
import type { Command } from 'commander'
import type { WorkStreamAssetAttachment, WorkStreamAssetAttachments, WorkStreamAssetSource } from '@ficus/shared'
import { apiDelete, apiFetch, apiGet, apiPatch, apiPost } from '../client'
import { isJsonMode, output, outputError } from '../output'

const path = (id: string, rest = '') => `/api/workstreams/${encodeURIComponent(id)}/asset-attachments${rest}`

interface SourceOptions {
  image?: string
  agentFile?: string
  inboxAttachment?: string
}

function sourceFrom(options: SourceOptions): WorkStreamAssetSource {
  const given = [options.image, options.agentFile, options.inboxAttachment].filter(Boolean)
  if (given.length !== 1)
    throw new Error(
      'Give exactly one of --image IMAGE_ID, --agent-file FILE_ATTACHMENT_ID or --inbox-attachment INBOX_ATTACHMENT_ID'
    )
  if (options.image) return { kind: 'image', imageId: options.image }
  if (options.agentFile) return { kind: 'agent-file', attachmentId: options.agentFile }
  return { kind: 'inbox-attachment', attachmentId: options.inboxAttachment! }
}

function describe(attachment: WorkStreamAssetAttachment): string {
  const source =
    attachment.source.kind === 'image'
      ? `image ${attachment.source.imageId}`
      : attachment.source.kind === 'inbox-attachment'
        ? `inbox attachment ${attachment.source.attachmentId}`
        : `chat file ${attachment.source.attachmentId}`
  const label = attachment.label ? `  "${attachment.label}"` : ''
  return `${attachment.id}${label}  ${attachment.filename}  ${attachment.contentType}  ${attachment.byteSize} bytes  (${source})`
}

/**
 * The bytes of one of a stream's attachments: a stored-asset reference, or else a file a flow
 * attempt handed off with --attach (both are listed with the stream; their IDs never collide).
 */
async function download(id: string, attachmentId: string): Promise<Response> {
  const asset = await apiFetch(path(id, `/${encodeURIComponent(attachmentId)}`))
  if (asset.status !== 404) return asset
  return apiFetch(`/api/workflows/runs/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attachmentId)}`)
}

/**
 * `ficus workstream attachment ...`: share stored chat images, chat files and inbox attachments with
 * a work stream by ID, and label them.
 */
export function registerWorkstreamAttachmentCommands(ws: Command): void {
  const attachment = ws
    .command('attachment')
    .alias('attachments')
    .description(
      'Share stored chat images, chat files and inbox attachments with a work stream by ID (no workspace copy), and list, label, download or remove them'
    )

  attachment
    .command('add <id>')
    .description(
      'Share an image, chat file or inbox attachment Ficus already stores with the work stream as an input; everyone who can read the work stream can see it'
    )
    .option('--image <imageId>', 'Chat image ID (from your conversation)')
    .option('--agent-file <attachmentId>', 'Chat file attachment ID')
    .option('--inbox-attachment <attachmentId>', 'Inbox attachment ID (from an inbox message you can read)')
    .option('--label <label>', `Optional short label shown instead of the filename (at most 120 characters)`)
    .action(async (id: string, options: SourceOptions & { label?: string }) => {
      try {
        const source = sourceFrom(options)
        if (options.label !== undefined && !options.label.trim())
          throw new Error('A label cannot be empty; leave out --label to share without one')
        const result = await apiPost<WorkStreamAssetAttachment>(path(id), {
          source,
          ...(options.label !== undefined ? { label: options.label } : {}),
        })
        output(result, `Attached ${describe(result)}`)
      } catch (error) {
        outputError(error as Error)
      }
    })

  attachment
    .command('list <id>')
    .description("List the work stream's stored inputs and each attempt's attached references")
    .action(async (id: string) => {
      try {
        const result = await apiGet<WorkStreamAssetAttachments>(path(id))
        if (isJsonMode()) return output(result)
        if (!result.inputs.length && !Object.keys(result.attempts).length) {
          console.log('No stored attachments.')
          return
        }
        if (result.inputs.length) {
          console.log('Inputs:')
          for (const entry of result.inputs) console.log(`  ${describe(entry)}`)
        }
        for (const [attemptId, entries] of Object.entries(result.attempts)) {
          console.log(`Attempt ${attemptId}:`)
          for (const entry of entries) console.log(`  ${describe(entry)}`)
        }
        console.log('Agents can view these with the read_attachment tool; download only when a local tool needs bytes.')
      } catch (error) {
        outputError(error as Error)
      }
    })

  attachment
    .command('label <id> <attachmentId> [label]')
    .description(
      "Set a stored input's short label (shown instead of its filename), or clear it with --clear; the filename never changes"
    )
    .option('--clear', 'Remove the label, so the filename shows again')
    .action(async (id: string, attachmentId: string, label: string | undefined, options: { clear?: boolean }) => {
      try {
        if (Boolean(options.clear) === (label !== undefined))
          throw new Error('Give a label, or --clear to remove the current one')
        if (label !== undefined && !label.trim())
          throw new Error('A label cannot be empty; use --clear to remove the current one')
        const result = await apiPatch<WorkStreamAssetAttachment>(path(id, `/${encodeURIComponent(attachmentId)}`), {
          label: options.clear ? null : label,
        })
        output(result, result.label ? `Labelled ${describe(result)}` : `Cleared the label of ${describe(result)}`)
      } catch (error) {
        outputError(error as Error)
      }
    })

  attachment
    .command('get <id> <attachmentId>')
    .alias('download')
    .description("Download one of the work stream's attachments (a stored reference or a handoff file)")
    .option('-o, --out <filepath>', 'Save to this file instead of writing to stdout')
    .action(async (id: string, attachmentId: string, options: { out?: string }) => {
      try {
        const response = await download(id, attachmentId)
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as { error?: string } | null
          throw new Error(body?.error ?? `Download failed (${response.status})`)
        }
        const bytes = Buffer.from(await response.arrayBuffer())
        if (options.out) {
          writeFileSync(options.out, bytes)
          output(
            { id: attachmentId, size: bytes.length, out: options.out },
            `Saved ${bytes.length} bytes to ${options.out}`
          )
        } else if (isJsonMode()) {
          output({ id: attachmentId, size: bytes.length, contentType: response.headers.get('content-type') })
        } else {
          process.stdout.write(bytes)
        }
      } catch (error) {
        outputError(error as Error)
      }
    })

  attachment
    .command('remove <id> <attachmentId>')
    .alias('rm')
    .description(
      'Stop sharing a stored input (or a reference on your own open attempt). It cannot erase copies already downloaded'
    )
    .action(async (id: string, attachmentId: string) => {
      try {
        await apiDelete(path(id, `/${encodeURIComponent(attachmentId)}`))
        output({ removed: attachmentId }, `Removed ${attachmentId}`)
      } catch (error) {
        outputError(error as Error)
      }
    })
}
