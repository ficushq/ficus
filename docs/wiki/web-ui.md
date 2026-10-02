# Ficus webapp visual design guide

Approved direction, September 5, 2026. This guide covers `apps/web`; the coverage ledger distinguishes source changes from browser verification.

## Direction

Ficus is a focused workspace with flat content, frosted framing, softly rounded controls, restrained leaf-green accents, and quiet supporting information. Keep useful density for work, settings, and diagnostics. Give conversations and page sections room to breathe. Information should be grouped by headings, spacing, and occasional separators rather than stacks of raised cards.

Local layout improvements are authorized. Broader navigation changes require a concrete proposal; the approved changes are recorded in information architecture.

## Surfaces

| Role                      | Treatment                                        | Use                                                                      |
| ------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------ |
| Canvas                    | Quiet, opaque light or dark background           | Page content                                                             |
| Section (`ficus-section`) | Transparent, no border or shadow                 | Settings groups, ordinary page sections                                  |
| Panel (`ficus-panel`)     | Thin boundary, 12px corners, no shadow           | Conversation workspace, navigation sidebar, distinct interactive regions |
| Inset (`ficus-inset`)     | Subtle tonal fill, 8px corners, no shadow        | An open editor or a locally grouped control                              |
| Overlay (`ficus-overlay`) | Opaque reading surface, thin border, soft shadow | Menus, dialogs, floating tools                                           |

Ordinary tables and lists sit on the page. Avoid gray header bars over white rows, outlined cards around every setting, and double dividers between adjacent groups. Rows use a subtle hover fill; selection uses a restrained accent wash. A status or attention callout can retain a semantic fill when it conveys information.

Glass belongs on app framing and sidebars. Use an approximately 88% surface fill and 16px backdrop blur, with opaque fallbacks for unsupported filtering or reduced transparency. Do not blur every row, nest blur boundaries, or animate blur strength. Reading surfaces, inputs, code, and terminal content remain sufficiently opaque.

## Tokens and implementation

Colors are theme tokens. `packages/shared/src/theme-schema.ts` lists them; `src/index.css` and `src/theme/builtins.css` define them for every built-in theme and appearance; `tailwind.config.js` exposes them to components; `src/design-system.css` contains explicit shared component roles. Add or change a token before introducing a color; palette utilities and literal colors fail `src/no-raw-colors.test.ts`. See [web themes](theme/README.md).

In the default Ficus theme the light canvas is linen (`#f1e9db`), with a lighter linen reading surface (`#f5f0e6`) and leaf-tinted secondary fills. Dark mode uses a soil canvas (`#1c1a17`), a warmer soil surface (`#2f2a24`), and leaf-tinted control fills. Leaf green (`#3f6b4f`, sage `#9fb57f` in dark mode) is Ficus's primary action and selection color, with terracotta and moss as its secondary and tertiary swatch colors. Iris keeps the original purple; other themes supply their own. Use the light accent token for foreground links in dark mode; filled controls use `text-on-accent`. A link's hover color is `text-link-hover` (`--color-link-hover`), which gains contrast in both appearances; `accent-hover` is a button fill that darkens in dark themes, so never use it for text.

Use `ficus-field`, `ficus-button`, `ficus-button-primary`, `ficus-nav-item`, and `ficus-table` for their corresponding roles. These classes define appearance; layout utilities remain local. Ordinary `shadow-theme` is disabled. Reserve elevation for overlays and transient drag affordances.

## Hierarchy and spacing

- Page titles: approximately 22px, semibold, slight negative tracking.
- Section headings: 12–14px, medium or semibold, sentence case, secondary color where appropriate.
- Body: readable proportional type; 13–14px for operational rows and metadata. Keep monospaced type for code, identifiers, and logs that benefit from alignment.
- Use one consistent content gutter within each page. Status dots, disclosure arrows, and titles have deliberate fixed-width slots.
- Prefer 16–24px between related groups and 24–32px between major sections. Avoid both excessive padding inside former cards and uninterrupted expanses of unrelated text.
- Primary content such as squad Home stays aligned with the full page width. Settings forms retain a readable column.

## Controls and rows

Give all actionable buttons, links, pills, navigation items, menu choices, and clickable rows pointer cursors. Disabled controls use a default cursor and remain visibly disabled. Static badges are not actionable and should not acquire a pointer cursor merely because they look like pills.

Use quiet hover and visible keyboard focus states. Keep status colors meaningful: blue for working, amber for attention, red for failure/destruction, green for success, neutral for idle. Pair colors with labels or accessible context.

Keep compact, useful filters visible: Feed status/squad pills and Work status pills do not need a separate Filters dropdown. Long filter sets can wrap; ensure they remain reachable on narrow screens.

The primary action sits at the trailing side of its heading/toolbar. Avoid competing filled actions. Secondary and overflow actions are quieter. Keep actions in a group aligned in height; the desktop chat search and activity toggle are both 26px high.

## Conversations and squad Home

Consultants are the main research, design, and brainstorming entry point. The manager coordinates ongoing squad work and remains available to inspect or talk to.

Home presents a conversation entry point, active work, recent chats, and a labeled **Squad coordinator** row. The coordinator description explains its role. Keep Active and Recent chats headings on the same title gutter. Recent consultant rows retain idle dots so they read as clickable agents, even in the flat presentation.

The Home active-work explorer is always a list inline; it has no list/kanban/graph toggle. Its header carries one graph icon (“Show work stream graph”) that opens a **Work Stream Graph** dialog showing only the dependency graph, with no view toggle in the dialog header. Selecting a node opens the work-stream detail; Escape closes the detail first, then the dialog, and focus returns to the icon. Only the Work tab persists a chosen view (`ficus.wsView.<squadId>`); Home stores no view preference.

The chat picker keeps the manager, search, and New chat action accessible. The pulse toggle starts disabled. When enabled, it limits the worker list to live/non-idle agents plus the currently viewed agent, retaining that agent’s category even if it becomes idle or completed and hiding other empty categories. Consultant recents remain available. Show **No active agents** when the filtered worker region is empty.

Squad Home and the Chats panel show up to five unarchived recent consultants, ordered by the last human message or creation time, without a fixed age cutoff. The Chats panel’s Recent chats section starts expanded and can collapse independently of workers and the open conversation; search reveals matching chats. Home has no recent-chat disclosure. Browsing/search gives access to older chats. Standalone chat page pickers retain ten recents.

Titles use `Manager (Name)`, `Purpose (Type • Name)`, or `Type (Name)` when there is no purpose. Display types in title case.

Initial agent-history loading uses message-shaped skeletons in the transcript, retaining the real header and composer. Do not replace existing messages with skeletons during background refresh. Empty-state copy appears only after loading resolves.

Transcript timestamps are quiet clock times (never relative), shown once per group in the muted meta line: above a human bubble (joined to the sender name when that label shows) or at the start of an agent reply. A group is consecutive messages from the same sender, each within five minutes of the previous one; system rows, automated deliveries, and unsaved items reset it. Every saved message carries its full date and time as a hover tooltip, and a centered Today / Yesterday / date divider marks each new local day. The helpers live in `apps/web/src/lib/chatTimestamps.ts`.

## Action Center

Needs you actions use a subtle neutral surface without colored frames or shadows. Keep semantic color on the small status icon; identify the squad and requester in a quiet subtitle. Use the primary accent for the primary action, a neutral outline for secondary choices, and quiet text for navigation or dismissal. Embedded question forms share the surrounding action's surface and padding.

A delegated Assistant task whose delegate reported `needs-input` is a Needs-you item (“Assistant task · needs your answer”), grouped with the other questions and visible only to the conversation owner. The card shows the question and an “Answer in Assistant” action that opens the conversation; the exact task answer form opens there so the reply stays correlated to the task, and the item clears once the task leaves `needs-input`. Unanswered task forms are independent of unread updates and remain visible after read/processed acknowledgments or update pagination. Ordinary `ask_human` questions use the shared pending-question form.

“Since your last visit” also lists conversations with unread Assistant updates as passive rows (title, latest preview, unread count, time) that open the Assistant on that conversation; they are never Needs-you actions and opening one marks nothing seen.

A single review, blocked-work item, or halted agent opens with its details visible and no redundant category heading. Question forms remain collapsed until opened so landing on the Feed does not trigger the keyboard. Keep approval confirmations, permissions, retry states, and dismissal behavior intact. Bare GitHub pull-request URLs in action messages may display as `PR #123`, preserving the destination and explicitly authored link labels.

## Settings

Use grouped navigation and explicit page/section headings. Keep forms flat, with quiet separators where needed. Do not wrap each checkbox or setting in a raised card.

Search includes page titles, section names, field labels, and aliases. Results show a breadcrumb and set a stable `setting` URL parameter. Destination anchors scroll, focus, and briefly highlight the target. Delayed query-backed content is observed until available. An explicitly marked local editor may open to reveal the field, without saving anything. If a field depends on enabling a feature or creating an entity, link to its explanatory group; never enable it or create an entity as a search side effect.

Search only indexes available pages; permission and runtime gates remain authoritative. Do not index secret values or generate a result for an arbitrary user/provider record.

## Responsive web behavior

This is a responsive webapp, including installed web experiences. Preserve browser navigation, deep links, safe areas, draft state, and keyboard behavior.

At narrow widths, use a section chooser for settings and More for secondary squad destinations. Keep important content and actions reachable. Use full viewport chat layouts on phones, accounting for the visual viewport when the software keyboard opens. Inputs should avoid accidental mobile browser zoom. Tapping a chat composer below 768px expands it to the shared fullscreen chat and focuses the input in the same gesture, preserving drafts and attachments. Programmatic focus does not expand chats; composers already inside a fullscreen mobile dialog stay there. Assistant conversations and agent chats inside the command-bar modal also stay inline when tapped: that modal owns their layout and caps its height to the visual viewport in every pinned position, including during dragging. It grows back when the keyboard closes; bottom pins must not retain the smaller measured height as their cap. Embedded chats expand locally without changing their parent route, and the close/minimize control returns to the original surface. When a squad or standalone chat container owns the identity header and tabs, composer taps expand that same container as the fullscreen button. Keep the conversation mounted across expansion so drafts, attachments, and in-flight work survive.

The app shell is a fixed, scroll-locked 100% box, so the layout viewport does not shrink when iOS shows the keyboard; left alone, Safari scrolls the visual viewport over the fixed page to reveal the focused composer and drags the whole shell upward. `useVisualViewportShell` therefore pins the shell's height to the visual viewport while the keyboard is open (`data-keyboard="open"` on the shell, which also hides the mobile dock) and resets that scroll, so the composer sits directly above the keyboard and the transcript scrolls inside. Do not add per-surface keyboard padding or `scrollIntoView` workarounds on top of this. Shared modals are portaled outside the shell, so `Modal` separately follows the visual viewport's height and offset for every size, not just full-screen chat. The dialog body scrolls to keep focused fields visible; its header and footer remain within that viewport. Scroll only the dialog content, never the fixed page.

Workspace panes share the available height; a default terminal size must not consume the entire file browser. Dense tables can scroll inside their region rather than causing page overflow.

Below 768px a base rule gives every `a` and `button` a 24px minimum height for touch targets. A link inside a text-sized metadata row (feed work cards, inbox rows) therefore gets a taller box than its neighbors; make such links `inline-flex items-center` so their text stays on the row's centerline next to separators and timestamps instead of pinning to the top of the box.

## Motion and accessibility

Hover/color transitions take approximately 120–160ms. Overlay entrances use a 160ms fade with at most 4px translation and 1% scale. Exit transitions take approximately 120ms. Avoid springs, bounce, repeated decorative movement, and layout shifts.

`Presence` retains a mounted surface briefly for exit, immediately sets it inert and hides it from assistive technology, and cleans up on animation completion with a bounded timeout fallback. Reopening cancels the pending exit. Shared menus and controlled dialogs use it. A dialog whose parent immediately unmounts the whole subtree cannot retain an exit; use controlled presence when adding or refactoring such a caller. Never delay a destructive action to animate its button.

Respect `prefers-reduced-motion` and `prefers-reduced-transparency`. Skeleton pulses are motion-safe. Preserve meaningful progress indicators. Shared focus-visible outlines remain visible; local focus rings may replace them when equally clear.

Target WCAG 2.2 AA, without treating this guide as a compliance certification. Normal text requires 4.5:1 contrast and qualifying large text 3:1; check the composited result for glass. See [W3C contrast guidance](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html). Keep focus visible and aim for comfortable touch targets; WCAG's [minimum target size criterion](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html) is 24 CSS pixels subject to its exceptions, while 44px is a useful product target for primary phone controls.

## Work stream details

Workflow previews start collapsed. The disclosure visibly says **Workflow · actual name**
(including custom inline names); missing names show **Workflow**, not a guessed preset.
Expanding exposes the interactive graph and grouped steps. Step usage, handoff history and
management tools are secondary disclosures inside that section, not loose text below the
collapsed summary. Overall usage stays in the enclosing detail view without a duplicate
workflow total. Critical waits, human decisions and delivery checks remain in the leading
attention callouts; checking delivery does not claim a merge or review has completed.
Refreshes preserve expansion; switching streams or reopening details resets it.
Descriptions wrap long paths, URLs and inline code within the modal; wide tables and code
blocks retain contained scrolling. The focused, DB-free browser regression can be run from
`apps/web` with `CHROMIUM_PATH=/path/to/chromium bun scripts/check-work-stream-detail-layout.ts`.
Set `SCREENSHOT_DIR` to save narrow/wide screenshots and measurements. This uses synthetic
query data and the real modal, markdown renderer and styles, without contacting a backend.

## Specialized content

Terminal themes, ANSI colors, syntax highlighting, code/diff meaning, graph canvases, voice visualization, and user-authored artifacts retain functional conventions. Their application framing, menus, and buttons use the shared language. Do not rewrite embedded user content or recolor semantic outputs merely to match the canvas.

## Verification

Run formatting, typechecking, the web build, and the web package's completion-checked test gate. Verify routing, query state, permissions, focus, and loading behavior alongside screenshots. Review representative light/dark and narrow/wide layouts, including long content, overflow, menus, and reduced-height windows. Record actual observations and limits in the coverage ledger rather than claiming every state was visually tested.

Active navigation and settings pages use a tinted background and accent text, without a selected border or inset shadow. Keep keyboard focus outlines distinct from selection. The mobile settings chooser stays open when switching Personal and Administration; choosing a page dismisses it.

## Loading and stable layouts

Render known navigation, headings, filters, and toolbars immediately. Keep the real layout mounted and use `LoadingContent` around only the data-dependent region. Skeletons share the content's gutters, row heights, typography line boxes, and responsive structure; use inline `SkeletonText` for unknown values inside headings or labels. Avoid separate page-shaped early returns that drift from the real layout.

Treat independently fetched regions independently. Active and completed work may resolve at different times; neither an empty response from one nor a disabled query means the whole list is empty. Preserve cached content during background refresh, and show empty-state copy only after the relevant initial requests settle.

Feed begins with its title and a persistent compact Needs you status line; keep the label and its status adjacent. Pending actions expand below it; an empty inbox reads “You’re all caught up.” Loading changes the status value, without inserting a temporary action card above the page title.

## Workspace and Assistant

Workspace and Memory use quiet file rows with consistent line icons, restrained selection, and separated panes. Keep file navigation, refresh, search, and upload controls mounted while data loads. Code previews share a continuous background. Terminal framing follows the app palette while ANSI output retains its meaning.

Assistant opens as a centered command bar from the navigation sparkles or Cmd/Ctrl+K. Search accessible squads, work streams, recent consultant conversations, pending action items, pages, and settings. Do not index individual worker agents; expose their conversations within the relevant work preview. Squad previews pin the Manager conversation row above their content. It supports arrow-key navigation and appears in scoped search. The input and its Start action create consultant chats; there is no separate New conversation row. Keep root search global and scope the input to conversations/work when a squad preview is selected, with an icon-only Ask/Start button inline beside the input. Enter opens the first matching result by default; with no results it starts a chat. Squad and work previews expand in place, with lightweight conversations and a route back to the prior preview or search. Preserve search query, selection, scroll, and chat drafts when moving between these views. Keep the search query and ordered navigation identifiers in the URL, without prompts or message contents; Back and Escape remove the current level. Resolve restored conversation purposes from agent data and keep the full-conversation link in the same breadcrumb row. The first result is the default highlighted Enter target, including when results arrive after loading. Changing the query resets selection to the first result. With no results, the enabled Ask/Start action is highlighted instead. Up from the first result selects the action target; Down returns to the first result. Arrow navigation stops at both ends without wrapping. Enter opens an explicitly selected result; Escape steps back before closing.

Work results reuse the Feed status pills. Balance title relevance with lifecycle and recency: similar unfinished work ranks ahead of completed work, recent completions remain competitive, and exact titles stay first. The landing list includes unfinished work followed by completions from the last week. Inline work and conversation regions use content-shaped skeletons only for initial loads; retain cached content during refreshes.

Assistant message receipts show a conversation row that opens the recipient inside the command bar. Back returns to the Assistant with its transcript, scroll position, and unsent draft intact. Suggested conversations are links; explicit requests to open a conversation use the same nested navigation immediately, while explicit page navigation still changes pages. Opening an agent chat does not transfer live voice: speech still addresses Assistant, while the selected agent’s composer sends directly to that agent. The header identifies both recipients when voice remains active.

Ordinary navigation to another app page keeps an open Assistant and its navigation stack visible. Derive the carried URL parameters before rendering the destination, then replace its URL without adding a history entry; repairing the URL in a layout effect alone can briefly commit a closed panel and clear the visible conversation. Explicit closing jumps and destination Assistant parameters take precedence, and same-page query changes retain their existing behavior. DOM regression coverage checks every committed visibility state, draft identity, focus and selection, plus Back/Forward history; these checks do not substitute for browser paint or mobile-device verification.

General Assistant conversations use one durable agent and the same chat engine as ordinary agent conversations. Text works independently of Realtime. Voice is a speech channel: transcribed utterances enter the same agent conversation, and confirmed replies are spoken once using message and response-group identity. A queued send or closed transport is not a completed reply. Compact voice mode keeps that conversation mounted; interrupting speech does not cancel background work. Quick tools run in Core, while longer work uses permission-checked general workers or squad consultants. Suggestions remain visible while the initial binding loads. Legacy transcripts stay available under Earlier conversation without replaying them as instructions. Page editors use their own conversation kind and only the server-bound draft tools; their conversations never appear in app-wide discovery. Draft-only legacy shells may be deleted on close, but bound agent histories remain intact.

Guides size to their content. Phone conversations use the available visual viewport; keep controls reachable above the software keyboard. Long paths, URLs, inline code, and other unbroken text must wrap without widening the conversation; code blocks and tables may scroll within their own bounds. Search has one continuous focus indicator. Mobile dock destinations include Settings directly when it is the only secondary destination.

The live voice control stays visible; disable it with an explanatory tooltip until configuration and permission are confirmed. On insecure or unsupported browsers, explain why starting is unavailable. Show connection progress on the control. A connected call automatically compacts into a small strip: the mic toggles mute, a status label explains the current phase, and icon controls end the call or expand the transcript. Listening means the microphone is ready; a soft mic halo pulses when speech is detected, respecting reduced motion. Connection and error state belong inside Assistant. Keep motion restrained and respect reduced motion.

Inbox rows use plain sender text, wrapping subjects, quieter previews and timestamps, and light separators. Expanded details and attachments remain accessible without outlined cards around each message.

Agent models use safe catalog metadata from the runtime registry when available, retaining custom IDs as a fallback. Model tier editors allow registry selection and custom entry. Agent type editing uses a dialog for long prompts and skill selection; integration-specific controls require the corresponding enabled feature.

Assistant starts horizontally centered in the upper third, with that position available in its positioning control. Its search viewport has a stable height; filtering scrolls results without repositioning the search field. Previews and conversations expand downward from the same anchor, bounded by the visual viewport. The last position selected from the pin control or by dragging is saved in local storage and restored whenever Assistant opens, including live voice. The header drags expanded views; the compact voice strip background drags without intercepting its controls. Six edge docking positions cover top/bottom left, center, and right, alongside the upper-center command anchor. Voice navigation instructions derive from the same squad tabs and settings definitions as the app.

Conversation rows show the shared agent activity indicator for non-idle states. Dormant and terminated agents are excluded from general command-bar conversation lists and Realtime search. Work previews omit owner-only conversations and show assigned agents, followed by the originating consultant under “Started here.” This origin is deduplicated from assigned rows, may be dormant or terminated, and always opens read-only; preserve that mode in URL navigation. Full-conversation links open the squad's Chats tab with the agent selected, using the squad slug mapping.

Squad command previews keep completed work in a default-collapsed “Recently completed” section. Offer 7-day (default) and 30-day windows based on completion date, newest first. Preserve the disclosure and period when opening work and returning to the squad.

Keep the command search field fixed above squad previews. In a squad, it filters that squad’s conversations and work (including completed work); Enter with no selected result or the inline action starts a consultant conversation using the entered text. Do not add a separate squad prompt form. Preserve each squad’s query and selection when returning. Work and conversation previews omit search; arrow keys focus work-preview conversation rows and native Enter opens them. From an empty squad search, arrows enter the preview rows and Up from the first row returns to the input.

The shared command footer stays visible in search, squad, work stream, and action previews, with hints matching the active view. It is one compact row with a subtle top divider, keyboard hints on the left, and Assistant conversations on the right. Quick-chat presets appear as a single horizontally scrollable row of pills below the empty global input. They immediately start a chat, disappear while searching or in nested previews, and stay separate from the results and footer. Single-action command previews stay expanded without a disclosure control; their related work stream opens as a nested preview row, not another modal. Feed action cards retain their existing disclosure and modal navigation.

Dragging into the horizontal center lane can snap to the upper-center command anchor as well as top/bottom center, using the nearest vertical anchor. On live-voice compaction, measure the final panel dimensions before paint and animate only its position; do not animate dimensions while recalculating a right/bottom dock on each resize frame.

Assistant conversations show ongoing work in the transcript, independently of the expandable task details. Use brief activity labels while connecting, thinking, responding, or running delegated work. Delegated work runs as a background task on an agent the conversation owns: a general system-manager helper for instance-wide and personal tasks, and one consultant per squad (named “Assistant task”) for squad tasks, each reachable from its “View task” row. Questions and approvals return to the current Assistant conversation rather than opening a separate agent question form.

Delegated tasks and their updates are durable and independent of the browser (see [Assistant tasks](assistant-tasks.md)). The navigation sparkles carry a badge counting conversations with unread updates (`99+` past 99, exact count in the accessible label); it never counts executing tasks and is driven by an application-wide activity query that runs only while signed in with `chat:send`, refreshes on WebSocket activity events, focus, and reconnect, keeps its last good count on errors, and never opens a mailbox lease or Realtime session. At the command-bar root with an empty query, Assistant conversations with unread updates lead the landing list as ordinary chat rows (title, “N new updates” and the latest preview, unread dot, task summary, time); they use the ordinary arrow-key and Enter selection and open the saved conversation through the Assistant navigation stack. Saved conversation rows in Recent chats show the same unread state, preview, and summary. Inside a conversation, the updates a summary covers show inline under it as cards (task label, status, sender, time, full content). Viewing the conversation (visible and not compact) marks its updates seen through the latest sequence, which clears the badge and the unread rows. Core forwards updates durably to the conversational agent, with at most 12,000 report characters per delivery batch and a bounded tool for longer reports. Summaries link to original reports using confirmed consumption in the same execution and response group; processing an update never marks it seen, and seeing one never marks it processed.

## Field and container radii

Use the shared `ficus-field` role for text inputs, search inputs, selects, and textareas. All use an 8px radius; do not add rounding utilities per page. Checkboxes and radio buttons keep their native control shapes. Assistant and agent chat composers may use a more rounded outer surface, while fields inside them follow the same rule.

Buttons and inset controls use 8px; catalog cards (`ficus-panel` or equivalent) and modals (`ficus-overlay`) use 12px. Reserve pills for compact badges, chips, and avatars. Search fields are ordinary fields, not pills.

Configuration catalogs—Workflows, Agent Types, Squad Presets, and Skills—use a shared search field, individually bordered surface cards separated by a consistent gap, and explicit Edit/View actions opening a modal. This is an intentional exception to flat settings sections: each card represents an independently managed resource. Long forms use wide dialogs; the workflow co-editor uses the viewport with an interactive canvas and side conversation.

### Storage inspection

Settings → Storage sits beside Logs and uses `system:logs` authorization. It reports VM sandbox machine disk usage, largest-first squad totals, and expandable directory trees (including repository/worktree folders). Sizes are inclusive allocated-byte estimates, not deletion suggestions. Always retain timestamps and show partial or unavailable measurements explicitly. Scans run in the background with concurrency and time limits, persist their latest result and scan ownership in the database, and never provision or wake agents. Other runtimes show an explicit unsupported state. The worker scans every 12 hours by default without a viewer; Settings → Storage can set 1–168 hours or 0 to disable scheduled scans. Manual refresh queues work for the next one-minute worker check. Settings writers can change the ascending percentage thresholds (default 80,90,95) and system-inbox alert toggle. Permission-gated shell banners show the latest measured capacity, timestamp, and stale status. Alerts fire on escalation and rearm after a three-percentage-point drop; unavailable readings retain previous warnings as stale. Results survive restarts, overlapping workers share a fenced lease, and durable alert receipts prevent duplicate inbox messages.

Interrupted scans retain disjoint child measurements under partial parents, including when GNU `du` has not emitted the home total yet. Keep every known sandbox visible: a null byte count is “Not measured,” not zero. Show machine diagnostic reasons and returned/expected home totals, and preserve folder paths in the API/CLI. Missing home totals alone do not establish timeout or stale ownership. Hardlink attribution depends on traversal order and does not predict cleanup savings. Do not combine old and new scan measurements to fill gaps.
