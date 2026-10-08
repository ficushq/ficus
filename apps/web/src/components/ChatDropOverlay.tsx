import { FileIcon } from './icons'

/**
 * Covers a chat while files are dragged over it. It takes no pointer input, so the drag keeps
 * targeting the chat beneath, and it exists only during a file drag, so it never blocks clicks or
 * scrolling.
 * The chat behind it is dimmed by a mostly opaque, blurred page-colored backdrop so nothing shows
 * through the card. Unlike the page-wide screenshot overlay (a dashed card over the whole window),
 * it stays inside the chat's own frame with a solid accent outline.
 */
export function ChatDropOverlay() {
  return (
    <div
      data-testid="chat-drop-overlay"
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center rounded-lg border-2 border-accent bg-page/90 p-4 backdrop-blur-sm"
    >
      <div className="flex max-w-sm flex-col items-center gap-2 rounded-xl border border-th-border bg-surface px-8 py-6 text-center">
        <span className="flex h-11 w-11 items-center justify-center rounded-full bg-accent/10 text-accent">
          <FileIcon className="h-6 w-6" />
        </span>
        <p className="text-base font-semibold text-primary">Drop to attach to this chat</p>
        <p className="text-sm text-secondary">Images attach as images; other files as agent files.</p>
      </div>
    </div>
  )
}
