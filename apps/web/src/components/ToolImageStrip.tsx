import clsx from 'clsx'
import { useMemo, useRef, useState } from 'react'
import type { ToolResultImage } from '../lib/tool-result-images'
import { ImagePreviewModal } from './ImagePreviewModal'

/**
 * Thumbnails of the images tool calls returned, side by side in one row that scrolls sideways when it overflows.
 * Clicking one opens the shared image preview, which steps through every image in the strip.
 * A thumbnail whose data fails to decode is dropped quietly instead of showing a broken image.
 */
export function ToolImageStrip({
  images,
  underRow,
}: {
  images: ToolResultImage[]
  /** Shown under a collapsed tool row or group: lined up with the row's label, past its icon or chevron. */
  underRow?: boolean
}) {
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set())
  const visible = useMemo(() => images.filter((image) => !failed.has(image.id)), [images, failed])
  const [preview, setPreview] = useState({ isOpen: false, index: 0 })
  const thumbnails = useRef<Array<HTMLButtonElement | null>>([])
  const openedFrom = useRef(0)

  if (visible.length === 0) return null

  const openPreview = (index: number) => {
    openedFrom.current = index
    setPreview({ isOpen: true, index })
  }
  const closePreview = () => {
    setPreview((current) => ({ ...current, isOpen: false }))
    // Back to the thumbnail that opened it, without moving the transcript.
    thumbnails.current[openedFrom.current]?.focus({ preventScroll: true })
  }
  const markFailed = (id: string) => setFailed((current) => new Set(current).add(id))

  return (
    <>
      <div
        data-tool-image-strip
        className={clsx('flex max-w-full gap-1.5 overflow-x-auto pb-1', underRow && 'mt-1 ml-[1.125rem]')}
      >
        {visible.map((image, index) => (
          // A button, never a link: the desktop shell has no tabs, so a link would replace the app.
          <button
            key={image.id}
            ref={(element) => {
              thumbnails.current[index] = element
            }}
            type="button"
            onClick={(event) => {
              // Strips sit inside collapsible tool rows; opening a picture must not also toggle the row.
              event.stopPropagation()
              openPreview(index)
            }}
            aria-label={`Preview ${image.alt}`}
            title={image.alt}
            className="ficus-button ficus-button-ghost block shrink-0 rounded-md p-0"
          >
            <img
              src={image.src}
              alt={image.alt}
              loading="lazy"
              decoding="async"
              onError={() => markFailed(image.id)}
              className="block h-20 w-auto max-w-[12rem] rounded-md border border-th-border bg-surface-secondary object-cover transition-colors hover:border-accent-light"
            />
          </button>
        ))}
      </div>
      <ImagePreviewModal
        images={visible}
        index={Math.min(preview.index, visible.length - 1)}
        isOpen={preview.isOpen}
        onIndexChange={(index) => setPreview((current) => ({ ...current, index }))}
        onClose={closePreview}
      />
    </>
  )
}
