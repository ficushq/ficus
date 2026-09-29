import type { ArtifactEntry, Presentation } from '@ficus/shared'
import { presentationSchema } from '@ficus/shared'
import clsx from 'clsx'
import { MarkdownContent } from '../MarkdownContent'
import { PresentationRenderer } from './PresentationRenderer'
import { VOICE_HOLD_KEYDOWN_MESSAGE, VOICE_HOLD_KEYUP_MESSAGE } from '@ficus/shared/browser-keys'

export interface ArtifactRendererProps {
  entry: ArtifactEntry
  content: unknown
  className?: string
  presentationChrome?: 'default' | 'none'
}

export function ArtifactRenderer({ entry, content, className, presentationChrome = 'default' }: ArtifactRendererProps) {
  const isContentHeightPresentation = entry.type === 'presentation' && presentationChrome === 'none'

  return (
    <div
      className={clsx(isContentHeightPresentation ? 'w-full' : 'h-full min-h-0 w-full', className)}
      data-artifact-type={entry.type}
    >
      {renderArtifact(entry, content, presentationChrome)}
    </div>
  )
}

function renderArtifact(
  entry: ArtifactEntry,
  content: unknown,
  presentationChrome: ArtifactRendererProps['presentationChrome']
) {
  switch (entry.type) {
    case 'presentation': {
      const parsed = presentationSchema.safeParse(content)
      if (!parsed.success) {
        return (
          <ArtifactError
            title="Unable to render presentation"
            detail="The artifact content does not match the presentation schema."
          />
        )
      }
      return <PresentationRenderer presentation={parsed.data as Presentation} chrome={presentationChrome} />
    }
    case 'markdown':
      return <MarkdownArtifact content={content} />
    case 'html':
      return <HtmlArtifact content={content} title={entry.path} />
    case 'sandbox_app':
      return <SandboxAppPlaceholder />
    default:
      return (
        <ArtifactError title="Unsupported artifact" detail="This artifact type is not supported by the web renderer." />
      )
  }
}

function MarkdownArtifact({ content }: { content: unknown }) {
  if (typeof content !== 'string') {
    return <ArtifactError title="Unable to render markdown" detail="Markdown artifact content must be text." />
  }

  return (
    <div className="p-5 text-primary">
      <MarkdownContent className="dark:prose-invert" variant="assistant">
        {content}
      </MarkdownContent>
    </div>
  )
}

const HTML_IFRAME_CSP =
  "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:; frame-src 'none'; object-src 'none'; connect-src * http: https: ws: wss:; script-src 'unsafe-inline'"

function HtmlArtifact({ content, title }: { content: unknown; title: string }) {
  if (typeof content !== 'string') {
    return <ArtifactError title="Unable to render HTML" detail="HTML artifact content must be text." />
  }

  return (
    <iframe
      title={`Artifact preview: ${title}`}
      sandbox="allow-scripts"
      srcDoc={withIframeCsp(content)}
      className="h-full min-h-[480px] w-full rounded-lg border border-panel-border bg-white"
    />
  )
}

const VOICE_HOLD_SHORTCUT_BRIDGE_SCRIPT = `
<script>
(() => {
  const isEditableTarget = (target) => {
    const tagName = target?.tagName?.toUpperCase?.()
    return Boolean(target?.isContentEditable || tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT' || tagName === 'BUTTON')
  }
  const isSpace = (event) => event.code === 'Space' || event.key === ' ' || event.key === 'Spacebar'
  window.addEventListener('keydown', (event) => {
    if (!isSpace(event) || event.repeat || isEditableTarget(event.target)) return
    event.preventDefault()
    window.parent?.postMessage({ type: ${JSON.stringify(VOICE_HOLD_KEYDOWN_MESSAGE)}, repeat: event.repeat }, '*')
  }, { capture: true })
  window.addEventListener('keyup', (event) => {
    if (!isSpace(event) || isEditableTarget(event.target)) return
    event.preventDefault()
    window.parent?.postMessage({ type: ${JSON.stringify(VOICE_HOLD_KEYUP_MESSAGE)} }, '*')
  }, { capture: true })
})()
</script>`

function withIframeCsp(content: string) {
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${HTML_IFRAME_CSP}">${VOICE_HOLD_SHORTCUT_BRIDGE_SCRIPT}</head><body>${content}</body></html>`
}

function SandboxAppPlaceholder() {
  return (
    <div className="rounded-xl border border-dashed border-th-border bg-surface-secondary p-6 text-sm text-secondary">
      <p className="font-medium text-primary">Sandbox apps are not available yet.</p>
      <p className="mt-1">
        This artifact type requires an isolated app runtime that has not been implemented in the web renderer.
      </p>
    </div>
  )
}

function ArtifactError({ title, detail }: { title: string; detail: string }) {
  return (
    <div
      role="alert"
      className="rounded-xl border border-status-danger-200 bg-status-danger-50 p-4 text-sm text-status-danger-800 dark:border-status-danger-900/60 dark:bg-status-danger-950/40 dark:text-status-danger-200"
    >
      <p className="font-semibold">{title}</p>
      <p className="mt-1">{detail}</p>
    </div>
  )
}
