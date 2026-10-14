/**
 * Surfaces that handle their own drops mark their whole area with `data-drop-scope`, so the
 * page-wide screenshot drop (and paste) leaves them alone:
 * - `chat`: an agent chat (`ChatView`: messages and composer). Files dropped anywhere on it attach.
 * - `upload`: a workspace file upload area.
 * - `reorder`: a list that reorders by dragging its rows.
 */
export const DROP_SCOPE_ATTRIBUTE = 'data-drop-scope'
export type DropScope = 'chat' | 'upload' | 'reorder'

/** The drop scope an event target sits in, if any. */
export function dropScopeOf(target: EventTarget | null): DropScope | null {
  if (!(target instanceof Element)) return null
  return (target.closest(`[${DROP_SCOPE_ATTRIBUTE}]`)?.getAttribute(DROP_SCOPE_ATTRIBUTE) as DropScope | null) ?? null
}

/** Whether a drag carries files from outside the page (not a text selection or a dragged element). */
export function isFileDrag(event: { dataTransfer?: DataTransfer | null }): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files')
}

const NON_TEXT_INPUTS = new Set(['button', 'checkbox', 'color', 'file', 'image', 'radio', 'range', 'reset', 'submit'])

/** Whether a paste there goes into text: a text field, a text area, or editable content. */
export function isTextEntry(element: Element | null): boolean {
  if (!element) return false
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) return true
  if (element instanceof HTMLInputElement) return !NON_TEXT_INPUTS.has(element.type)
  return element instanceof HTMLElement && (element.isContentEditable || element.closest('[contenteditable]') !== null)
}
