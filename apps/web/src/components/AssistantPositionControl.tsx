import type { AssistantCorner } from '../hooks/useAssistantPosition'
import { DragHandleIcon } from './icons'

export function AssistantPositionControl({
  corner,
  onChange,
}: {
  corner?: AssistantCorner
  onChange: (corner: AssistantCorner) => void
}) {
  return (
    <label
      title="Move assistant"
      className="relative flex h-8 w-6 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface-hover focus-within:outline-solid focus-within:outline-2 focus-within:outline-accent"
    >
      <DragHandleIcon className="h-4 w-4" />
      <select
        aria-label="Assistant position"
        className="absolute inset-0 w-full cursor-pointer opacity-0"
        value={corner ?? ''}
        onChange={(event) => onChange(event.target.value as AssistantCorner)}
      >
        <option value="" disabled>
          Move assistant
        </option>
        <option value="center">Upper center</option>
        <option value="top-left">Top left</option>
        <option value="top-center">Top center</option>
        <option value="top-right">Top right</option>
        <option value="bottom-left">Bottom left</option>
        <option value="bottom-center">Bottom center</option>
        <option value="bottom-right">Bottom right</option>
      </select>
    </label>
  )
}
