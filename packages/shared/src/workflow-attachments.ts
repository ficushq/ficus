/** A file an agent attached to its flow attempt's handoff, snapshotted when it was uploaded. */
export interface WorkflowAttemptAttachment {
  id: string
  attemptId: number
  filename: string
  /** The workspace path as the agent gave it; for display only. */
  path: string
  /** Derived from the filename by {@link workflowAttachmentContentType}, never from the uploader. */
  contentType: string
  byteSize: number
  createdAt: string
  /** The attempt's result revision this file was uploaded for; absent or 1 for the original completion. */
  revision?: number
}

/** The most files one attempt may attach to its handoff. */
export const WORKFLOW_ATTEMPT_ATTACHMENT_LIMIT = 10

const SOURCE_EXTENSIONS = [
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'py',
  'rb',
  'go',
  'rs',
  'java',
  'kt',
  'swift',
  'c',
  'h',
  'cpp',
  'hpp',
  'cs',
  'php',
  'sh',
  'bash',
  'zsh',
  'sql',
  'css',
  'scss',
  'toml',
  'ini',
  'diff',
  'patch',
  'txt',
  'log',
]

const CONTENT_TYPES: Record<string, string> = {
  ...Object.fromEntries(SOURCE_EXTENSIONS.map((extension) => [extension, 'text/plain'])),
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
}

/**
 * The content type a workflow attachment is stored and served with, from its filename extension only.
 * Anything unlisted (including HTML, SVG and XML, which a browser could execute) is
 * `application/octet-stream`; source code is plain text.
 */
export function workflowAttachmentContentType(filename: string): string {
  const dot = filename.lastIndexOf('.')
  const extension = dot > 0 ? filename.slice(dot + 1).toLowerCase() : ''
  return Object.hasOwn(CONTENT_TYPES, extension) ? CONTENT_TYPES[extension]! : 'application/octet-stream'
}
