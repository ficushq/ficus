import {
  createContext,
  useContext,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type RefObject,
  type SetStateAction,
} from 'react'
import { useHoverOpen, type HoverOpenState } from './popover'

/** The inbox popup's panel id: the nav trigger's `aria-controls`, and how a hover-close finds focus inside it. */
export const INBOX_POPUP_ID = 'inbox-popup'

export interface InboxPopupControl {
  open: boolean
  setOpen: Dispatch<SetStateAction<boolean>>
  /** The desktop nav's Inbox button. */
  triggerRef: RefObject<HTMLButtonElement | null>
  /** Hover-to-open from the nav button, as the squad switcher: spread `triggerProps` on it, `popoverProps` on the panel. */
  hover: HoverOpenState
}

const InboxPopupContext = createContext<InboxPopupControl | null>(null)

/**
 * The inbox popup's open state, shared by its trigger in the top nav (`AppHeader`) and the popup itself
 * (`InboxPopup`, mounted elsewhere in the shell). A mouse hovering the trigger opens it; leaving both the trigger
 * and the panel closes it again unless a click pinned it (`useHoverOpen`). Opening never moves focus.
 */
export function InboxPopupProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const target = useMemo(
    () => ({ open, setOpen, toggle: () => setOpen(!open), triggerRef, id: INBOX_POPUP_ID }),
    [open]
  )
  const hover = useHoverOpen(target, { enabled: true, initialFocus: 'none' })
  return (
    <InboxPopupContext.Provider value={{ open, setOpen, triggerRef, hover }}>{children}</InboxPopupContext.Provider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export function useInboxPopup(): InboxPopupControl {
  const control = useContext(InboxPopupContext)
  if (!control) throw new Error('useInboxPopup must be used inside an InboxPopupProvider')
  return control
}
