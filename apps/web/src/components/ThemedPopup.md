# Themed browser popups

`SelectionPopup` is a select-only combobox/listbox: focus movement never changes the value. Options expose selected state and optional associated descriptions. `ActionPopup` is a button/menu for actions and in-app section navigation. These adapters are browser-only; they do not change agent delivery semantics or the separate user-assistant composer.

The shared foundation uses Floating UI React for collision handling, ancestor/layout updates, list navigation, outside dismissal, and nonmodal portal focus ordering. This adds a web dependency rather than maintaining custom geometry, scrolling, and keyboard algorithms. It deliberately does not migrate unrelated dropdowns.

- Fixed, body-portaled content escapes clipping/stacking contexts; the popup layer is above browser dialogs/drawers.
- Flip, two-axis shift, and size middleware keep an 8px viewport margin and a scrollable maximum height. Visual viewport events update positioning when a browser keyboard opens or pans. Hidden breakpoint triggers dismiss their portals on resize.
- Selected/active enabled rows get initial focus; otherwise the first enabled row does. Arrows/Home/End move focus only. Enter/Space activate once, never submit an enclosing form, and restore trigger focus.
- Escape is consumed by the latest open popup at window capture, before document-level app shortcuts. It restores trigger focus. Pointer/focus dismissal never steals outside focus.
- Portal Tab guards preserve logical order. Tab dismissal waits until native focus transfer finishes; this is not a modal focus trap. Known outside blur dismisses, but a touch blur during an inside pointer selection does not cancel its click.
- Set `opensDialog` on an action whose callback opens a dialog. That action suppresses trigger restoration so the dialog owns focus. Existing navigation here uses buttons; no links are converted to buttons by this API.
- Closed content unmounts immediately. The shared overlay entrance animation is retained; an exit animation is intentionally omitted to keep focus guards and dismissed rows out of the interaction tree.

## Focused verification

From `apps/web`:

```sh
bun test src/components/ThemedPopup.test.tsx src/components/AgentViewTabs.test.tsx src/components/ChatView.test.tsx src/components/squads/SquadNavigation.test.tsx src/components/squads/SquadChatActions.test.tsx
bun run test:popups:browser
```

The browser gate uses the repository's pinned `playwright-core` (from Core's package installation), a local Vite fixture, and Chromium; no API or database is started. Set `PLAYWRIGHT_BROWSERS_PATH` for the installed browser cache, and optionally `POPUP_SCREENSHOTS` to an absolute output directory. All owned processes close in `finally`. Browser scenarios exercise real native key/click defaults, narrow/tablet/desktop branches, corners, resizing, ancestor scrolling, anchor movement, dialog handoff, and simulated visual viewport keyboard events. Physical iOS/Android keyboards and screen-reader announcements still require device/assistive-technology verification.

Floating UI chooses its browser layout-effect implementation at import time. The web test preload initializes it under a temporary DOM, then removes that DOM; individual tests retain the existing isolated DOM ownership protocol. The DOM harness installs/restores `getComputedStyle` for the dependency's real focus and geometry helpers (none are mocked).
