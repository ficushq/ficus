# Popover: the one floating surface

Every popup in `apps/web` — a menu, a value picker, a panel, a hover card, an autocomplete list — renders
through this module. It owns everything that used to be hand-built per component and drifted: anchoring
and edge-aware placement, the portal, dismissal, the enter/exit animation, focus on open and return, Tab
order across the portal, the trigger's ARIA, and the z-index layer. Pick the variant that matches the
semantics; reach for the bare `Popover` only when none fits.

| Need                                                  | Use                                         |
| ----------------------------------------------------- | ------------------------------------------- |
| A menu of actions or in-app navigation from a button  | `Menu` + `MenuItem` (or `ActionPopup`)      |
| A "…" overflow of plain action buttons                | `OverflowMenu` (a `Menu` over your buttons) |
| A dropdown to pick one value                          | `Picker` (or `SelectionPopup`)              |
| Filters, a settings chooser, any non-modal panel      | `Panel`                                     |
| A preview card for a link or reference on hover/focus | `HoverCard` + `useHoverCard`                |
| Suggestions under/over a text field that keeps focus  | `ComboboxList`                              |

`SelectionPopup` and `ActionPopup` (`components/ThemedPopup.tsx`) are the ready-made trigger + `Picker` /
`Menu` pairs with the standard row look (`popoverRowClass`, `PopoverRowContent`).

## API

```tsx
const popover = usePopover({ kind: 'menu' }) // 'menu' | 'listbox' | 'dialog' | 'disclosure'

<button {...popover.triggerProps} type="button" onClick={popover.toggle}>…</button>
<Menu {...popover.popoverProps} label="Row actions" className="ficus-overlay w-44 p-1">
  <MenuItem onClick={rename}>Rename</MenuItem>
  <MenuItem opensDialog onClick={() => setConfirming(true)}>Delete…</MenuItem>
</Menu>
```

- `usePopover({ kind, open?, onOpenChange?, id? })` returns `open`, `setOpen`, `toggle`,
  `close({ returnFocus })`, `triggerRef`, `triggerProps` and `popoverProps`. `triggerProps` carries the
  ref and `aria-haspopup` (none for a `disclosure`), `aria-expanded` and `aria-controls`; menus and
  listboxes also open on ArrowDown/ArrowUp. Pass `open`/`onOpenChange` to control it.
- `Popover` (and every variant) takes `open`, `onDismiss(reason)`, `trigger`, plus:
  - `anchor` — what it is placed against when that is not the trigger (a header row, a text field);
  - `side` (`below`), `align` (`end` = right edges; `start` = left edges), `gap` (6), `alignOffset`;
  - `width` — `content` (default: the surface's own CSS width, capped at the viewport), a number, or
    `anchor` (as wide as the anchor); `maxHeight` — a number or `(viewport) => number`; `boundary` — a
    region it must also stay inside;
  - `initialFocus` — `first` (default), `selected`, `none`, or `(surface) => element`;
  - `tabOut` — `continue` (default), `close` (menus/listboxes) or `none`;
  - `dismissible`, `escape`, `focusOut`, `restoreFocus`, `returnFocus`, `inside` — dismissal options;
  - `portal` (default true; `false` renders in place, still `position: fixed`), `layer`, `scroll`.
- Dismiss reasons: `pointer`, `escape`, `focus` (from `usePopupDismiss`), `anchor` (the anchor stopped
  rendering, or for a hover card scrolled out of view), `tab` (Tab out of a menu) and `select` (a menu
  item or option ran).

### Variants

- **`Menu`** (`role="menu"`): items are `MenuItem`s (`menuitem`, `menuitemradio`, `menuitemcheckbox`
  with `checked`), or the caller's plain buttons via `itemSelector` (they get `role="menuitem"`).
  Arrows (looping), Home and End move focus, skipping disabled items; pointer hover moves focus too.
  Enter, Space or a click runs the item's own `onClick`, then closes and returns focus to the trigger —
  unless the action moved focus on purpose (a dialog) or the item has `opensDialog`. An item that calls
  `event.preventDefault()` keeps the menu open. Tab closes it and continues from the trigger.
  `initialFocus`: `first` (default), `selected` (the checked/current item) or `none`.
- **`Picker`** (`role="listbox"`, trigger `role="combobox"`): the selected option gets focus; arrows,
  Home and End move focus only and never change the value; Enter, Space or a click commits, closes and
  returns focus. Options take `label`, `description`, `ariaLabel`, `icon`, `disabled`.
- **`Panel`** (`role="dialog"` by default; `region`/`group` for a disclosure): arbitrary content. Focus
  moves to its first control on open (or per `initialFocus`) and is trapped loosely: Tab on the open
  trigger enters the panel, Tab past its last control continues the page after the trigger, Shift+Tab
  before its first control returns to the trigger. It closes on an outside press, Escape or keyboard
  focus leaving (unless `focusOut={false}`, as for the voice companion).
- **`HoverCard`** + **`useHoverCard({ openDelay: 250, closeDelay: 150 })`**: spread
  `hover.anchorHandlers` on the anchor. Hover opens after `openDelay`; keyboard focus (`:focus-visible`)
  opens at once; leaving both the anchor and the card closes after `closeDelay`, so the pointer can cross
  the gap. It never takes focus on open; Tab on the anchor enters it; Escape closes it and returns focus
  to the anchor only when focus was inside; it closes when the anchor scrolls out of view.
- **`ComboboxList`**: anchored to a text field (`input`), above it by default. The field keeps focus the
  whole time (option presses `preventDefault` their mousedown) and gets `aria-expanded`,
  `aria-controls` and `aria-activedescendant` while it is open. The caller's key handler owns the arrows,
  Enter/Tab and Escape; only an outside press — the field included, since the caret moves — dismisses it.

## Placement

The geometry is the pure `placePopup` in `lib/popupPosition.ts`, generalised from `ThemedPopup`'s (and
before it `EntityReferencePreview`'s), with no positioning dependency:

- It opens on `side` (below by default) with its `align` edge on the anchor's, `gap` px away.
- It flips to the other side when the content does not fit and there is more room there.
- Both axes shift to keep an **8px margin** inside the **visual viewport** (the mobile keyboard and
  pinch-zoom shrink it), intersected with `boundary` when given. Width and scroll height shrink to fit.
- `usePopoverPosition` re-places it on open, on any ancestor scroll, window or visual-viewport resize
  or pan, anchor or content size change (`ResizeObserver`), and **once per frame** while open whenever
  the anchor's rect changed without an event (layout shifts). Unchanged placements do not re-render.
- A trigger hidden by a breakpoint closes its popover (`anchor`), except a non-dismissible one, which
  stays at its last placement.

## Portal, layers and animation

- It portals out of clipping (`overflow: hidden`) and stacking ancestors: into the enclosing
  `aria-modal` dialog when there is one (so assistive technology keeps it reachable), else
  `document.body`. `position: fixed` with the placement above.
- `POPOVER_LAYERS`: `popover` = z-90 (above modals and the assistant window, both z-60), `companion` =
  z-50 (a persistent floating panel that lives under modals: the voice companion). A popover opened
  from inside another adds its nesting depth, so nested popovers always stack above their parent.
- It renders through `Presence`: the shared `ficus-presence` enter animation, and on close it stays
  mounted, `inert` and `aria-hidden`, for its 120ms exit animation (`data-state="closed"`). Tests that
  assert a popover is gone should ignore `[data-state="closed"]` surfaces.

## Dismissal

Dismissal is `usePopupDismiss` (`hooks/usePopupDismiss.ts`), with the portaled surface as the popup
region and the trigger (plus any `inside` regions) inside. It is mandatory for any floating UI, and the
WebKit rule it documents applies to every popover: in Safari and every iOS browser a tapped button never
takes focus — WebKit focuses its nearest focusable ancestor or blurs to nothing before the click — so a
popover never closes on its own blur. Escape is consumed by the most recently opened popup.

## Guards

- `components/popover.guard.test.ts` fails the build when a component outside this module renders its
  own `Presence`, calls `createPortal`, or positions a floating surface itself (`absolute`/`fixed` with
  `ficus-overlay`, `top-full`/`bottom-full`, or a floating `role="menu"`/`"listbox"`). Its allowlist is
  tiny and says why each entry is not an anchored popup.
- `components/popupDismissal.guard.test.ts` fails on a popup closing from its own blur/focusout handler,
  reading `relatedTarget`, or adding its own outside-press listener.

## Testing

- Tap tests use `webkitTap` (`test/webkitTap.ts`), which delivers a tap the way WebKit does (no focus on
  the pressed button; focus to the nearest focusable ancestor, or nowhere; `touch: true` for iOS's
  touch order). Put the popover inside a `<section tabIndex={-1}>` or a focusable dialog, as real pages
  do, and assert the tapped item ran.
- Content is portaled, so query `document`, not the render container.
- `src/components/popover/*.test.tsx` cover the core and every variant; `src/lib/popupPosition.test.ts`
  covers the geometry at every viewport edge.

```sh
bun test src/components/popover src/lib/popupPosition.test.ts src/components/popover.guard.test.ts \
  src/components/popupDismissal.guard.test.ts src/components/popupDismissal.webkit.test.tsx
```

Physical iOS/Android keyboards, Safari and screen readers are not exercised by these tests.
