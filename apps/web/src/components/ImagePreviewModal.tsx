import { useEffect } from 'react'
import { ChevronRightIcon } from './icons'
import { Modal } from './Modal'

export interface PreviewImage {
  id: string
  src: string
}

/**
 * The tallest the image may be: the dialog's own cap (`VIEWPORT_MODAL_HEIGHT`) less room for its header,
 * so the picture scales down to fit instead of scrolling. If the header wraps, the dialog body scrolls.
 */
const IMAGE_MAX_HEIGHT =
  'calc(var(--modal-viewport-height, 100dvh) - 6rem - env(safe-area-inset-top) - env(safe-area-inset-bottom))'

const STEP_BUTTON = 'ficus-button ficus-button-ghost p-1.5 rounded-md transition-colors shrink-0'

/**
 * Shows chat image attachments in place, over the page. It deliberately offers no link to the image URL:
 * the desktop shell has no tabs and loads a same-origin link in the app window, replacing the app.
 */
export function ImagePreviewModal({
  images,
  index,
  isOpen,
  onIndexChange,
  onClose,
}: {
  images: PreviewImage[]
  /** The image on show; kept while closed so the picture survives the exit animation. */
  index: number
  isOpen: boolean
  onIndexChange: (index: number) => void
  onClose: () => void
}) {
  const count = images.length
  const current = images[index]
  const canStep = count > 1

  useEffect(() => {
    if (!isOpen || !canStep) return
    const onKeyDown = (event: KeyboardEvent) => {
      // With a modifier the arrows belong to the browser and the desktop shell (history navigation).
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
      const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
      if (step === 0) return
      event.preventDefault()
      onIndexChange((index + step + count) % count)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isOpen, canStep, index, count, onIndexChange])

  const position = `${index + 1} of ${count}`

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Image preview"
      size="content"
      noChildPadding
      closeOnEscape
      headerExtra={
        canStep && (
          <span data-image-position aria-live="polite" className="text-xs text-muted tabular-nums">
            {position}
          </span>
        )
      }
      headerActions={
        canStep && (
          <>
            <button
              type="button"
              onClick={() => onIndexChange((index - 1 + count) % count)}
              className={STEP_BUTTON}
              aria-label="Previous image"
              title="Previous image (Left arrow)"
            >
              <ChevronRightIcon className="w-4 h-4 rotate-180" />
            </button>
            <button
              type="button"
              onClick={() => onIndexChange((index + 1) % count)}
              className={STEP_BUTTON}
              aria-label="Next image"
              title="Next image (Right arrow)"
            >
              <ChevronRightIcon className="w-4 h-4" />
            </button>
          </>
        )
      }
    >
      {current && (
        <img
          key={current.id}
          src={current.src}
          alt={canStep ? `Attached image ${position}` : 'Attached image'}
          style={{ maxHeight: IMAGE_MAX_HEIGHT }}
          className="m-auto block h-auto w-auto max-w-full object-contain"
        />
      )}
    </Modal>
  )
}
