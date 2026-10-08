import { useEffect } from 'react'
import { IMAGE_ATTACHMENT_MIME_TYPES } from '@ficus/shared'
import { dropScopeOf, isFileDrag, isTextEntry } from '../lib/dropScope'
import { useStableRef } from './useStableRef'

function isImageFile(file: File | null | undefined): file is File {
  return Boolean(file && (IMAGE_ATTACHMENT_MIME_TYPES as readonly string[]).includes(file.type))
}

/**
 * Window-level drop and paste of an image outside every drop scope (`lib/dropScope.ts`) and text field.
 * Capture-phase listeners see drags even where a chat stops propagation; the overlay itself takes no
 * pointer input, so the element under the pointer stays the drag target. Only file drags count.
 *
 * Paste rule: a paste belongs to where focus is. In a text field it is text; with focus anywhere in
 * a drop scope (a chat focuses its surface when its messages are clicked) the scope handles it, so
 * an image pasted there attaches to that chat; only with focus outside every scope does an image
 * paste file a screenshot.
 */
export function useGlobalImageDrop(options: {
  enabled: boolean
  onImage: (file: File) => void
  onDraggingChange: (dragging: boolean) => void
}) {
  const onImage = useStableRef(options.onImage)
  const onDraggingChange = useStableRef(options.onDraggingChange)
  useEffect(() => {
    if (!options.enabled) return
    let dragging = false
    const show = (next: boolean) => {
      if (dragging === next) return
      dragging = next
      onDraggingChange.current(next)
    }
    const over = (event: DragEvent) => {
      if (!isFileDrag(event)) return
      if (dropScopeOf(event.target)) return show(false)
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
      show(true)
    }
    // Entering the next element fires before leaving the last, so the count only reaches zero when
    // the drag leaves the window.
    let depth = 0
    const enter = (event: DragEvent) => {
      if (!isFileDrag(event)) return
      depth++
      over(event)
    }
    const leave = (event: DragEvent) => {
      if (!isFileDrag(event)) return
      depth = Math.max(0, depth - 1)
      if (depth === 0) show(false)
    }
    const drop = (event: DragEvent) => {
      depth = 0
      show(false)
      if (!isFileDrag(event) || dropScopeOf(event.target)) return
      event.preventDefault()
      const image = Array.from(event.dataTransfer?.files ?? []).find(isImageFile)
      if (image) onImage.current(image)
    }
    const end = () => {
      depth = 0
      show(false)
    }
    const paste = (event: ClipboardEvent) => {
      if (
        event.defaultPrevented ||
        isTextEntry(document.activeElement) ||
        isTextEntry(event.target as Element) ||
        dropScopeOf(document.activeElement) ||
        dropScopeOf(event.target)
      )
        return
      const item = Array.from(event.clipboardData?.items ?? []).find(
        (entry) => entry.kind === 'file' && (IMAGE_ATTACHMENT_MIME_TYPES as readonly string[]).includes(entry.type)
      )
      const image = item?.getAsFile()
      if (!isImageFile(image)) return
      event.preventDefault()
      onImage.current(image)
    }
    window.addEventListener('dragenter', enter, true)
    window.addEventListener('dragover', over, true)
    window.addEventListener('dragleave', leave, true)
    window.addEventListener('drop', drop, true)
    window.addEventListener('dragend', end, true)
    window.addEventListener('paste', paste)
    return () => {
      window.removeEventListener('dragenter', enter, true)
      window.removeEventListener('dragover', over, true)
      window.removeEventListener('dragleave', leave, true)
      window.removeEventListener('drop', drop, true)
      window.removeEventListener('dragend', end, true)
      window.removeEventListener('paste', paste)
      show(false)
    }
  }, [options.enabled, onImage, onDraggingChange])
}
