import { FileIcon } from './icons'

/**
 * Covers a chat while files are dragged over it. It takes no pointer input, so the drag keeps
 * targeting the chat beneath and nothing is clickable or scrollable through it only while dragging.
 * Unlike the page-wide screenshot overlay (a dashed card over a blurred page), it stays inside the
 * chat's own frame with a solid accent outline.
 */
export function ChatDropOverlay() {
  return (
    <div
      data-testid="chat-drop-overlay"
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center rounded-lg border-2 border-accent bg-surface/90"
    >
      <div className="flex flex-col items-center gap-2 px-6 text-center">
        <span className="flex h-11 w-11 items-center justify-center rounded-full bg-accent/10 text-accent">
          <FileIcon className="h-6 w-6" />
        </span>
        <p className="text-base font-semibold text-primary">Drop to attach to this chat</p>
        <p className="text-sm text-secondary">Images attach as images; other files as agent files.</p>
      </div>
    </div>
  )
}
