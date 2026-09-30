# Themed browser popups

`SelectionPopup` is a select-only combobox/listbox: focus movement never changes the value. Options expose selected state and optional associated descriptions. `ActionPopup` is a button/menu for actions and in-app section navigation. These adapters are browser-only; they do not change agent delivery semantics or the separate user-assistant composer.

## Why no positioning library

The foundation is in-repo, with no dependency. It builds on the pattern `EntityReferencePreview` already uses: a fixed-position portal, flip above/below, clamping to the visual viewport, and repositioning on scroll/resize/visual-viewport events plus `ResizeObserver`. The geometry is a pure function (`lib/popupPosition.ts`, unit-tested at every edge). An earlier revision used `@floating-ui/react`. It worked, but the imported modules cost about 22 KB gzip (63 KB minified) plus six lockfile packages. This component and its geometry are about 2.6 KB gzip. The behaviour needed here is a small subset of that library.

## Behaviour

- Portaled out of clipping/stacking ancestors (into the enclosing `aria-modal` dialog when there is one, so assistive technology keeps it reachable, else `document.body`), with `position: fixed` and `z-[90]`.
- Placement: opens below, end-aligned to the trigger. It flips above when the content does not fit and there is more room there. Both axes shift to keep an 8px margin in the visual viewport, and the width and scroll height shrink to fit. It repositions on any ancestor scroll, window/visual-viewport resize or pan (for example a mobile keyboard), and trigger or content size changes. While open, it also compares the trigger rect once per frame to follow layout shifts that fire no event. A trigger hidden by a breakpoint change closes its popup.
- Keyboard: Enter/Space/click open it; ArrowDown/ArrowUp on the trigger also open it. The selected/active enabled row gets initial focus, else the first enabled row. Arrows (looping), Home and End move focus only, skipping disabled rows; the focused row scrolls into view. Enter/Space activate once, never reach an enclosing form, composer or shortcut, and restore trigger focus.
- Escape is consumed by the most recently opened popup at window capture, before document-level app shortcuts, and restores trigger focus. Outside pointer presses and known outside focus moves close it without stealing focus. A touch blur during an inside tap does not cancel that tap.
- Nonmodal Tab: Tab continues the page order after the trigger, and Shift+Tab returns to the trigger. Both close the popup; there is no focus trap.
- Set `opensDialog` on an action whose callback opens a dialog. It suppresses trigger-focus restoration so the dialog owns focus. Closed content unmounts; the shared overlay entrance animation is kept.

## Verification

From `apps/web`:

```sh
bun test src/lib/popupPosition.test.ts src/components/ThemedPopup.test.tsx src/components/AgentViewTabs.test.tsx src/components/ChatView.test.tsx src/components/squads/SquadNavigation.test.tsx src/components/squads/SquadChatActions.test.tsx
```

These are the permanent regression tests: geometry at every viewport edge and in a visual viewport, keyboard behaviour, focus restoration, dialog handoff, permissions and breakpoint branches. Rendering and native key defaults were also checked once in headless Chromium for the change that introduced this component. Physical iOS/Android keyboards, Safari and screen readers were not device-tested.
