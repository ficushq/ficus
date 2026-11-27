/**
 * Resolves after the window's next two animation frames, so work a component scheduled for the next
 * frame (LiveListMotion's measuring and animating) has run, whatever order Happy DOM runs callbacks in.
 */
export function afterAnimationFrames(window: { requestAnimationFrame: (callback: () => void) => unknown }) {
  return new Promise<void>((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)))
}
