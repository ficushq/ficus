# The farm UI

`apps/farm` is a game-style alternative UI for Ficus: each squad is a fenced
yard, work streams grow as plants, and agents are robots that tend them. It is
fully functional (answer questions, review, unblock, chat with agents) and uses
the same client packages as the web app (`@ficus/client-core`,
`@ficus/client-react`). Core serves the built farm at `/farm`, only
when it serves the web UI (`FICUS_FARM_DIST` pointing at a missing build logs a
warning); see [development](development.md#the-farm-ui) for building and
running it, and [reverse-proxy](reverse-proxy.md) for serving it statically.

## Home-screen app

The farm installs as its own app, beside Ficus: `apps/farm/pwa.ts` emits
`manifest.webmanifest` at the farm's base with relative `id`, `start_url` and
`scope` (`./`, i.e. `<APP_BASE_PATH>/farm/`), so "Add to Home Screen" or
"Install" on the farm makes a "Ficus Farm" app that opens straight into it. Its icons are the farm set,
`brand/generated/farm/` (the Ficus mark standing in the meadow under the farm's
sky), which is also the farm's Vite public dir. Their URLs in the manifest and
`index.html` carry a content hash (`?v=`): a CDN in front of Core (Cloudflare
caches images for hours) and iOS's home-screen icon cache key on the URL, so a
changed icon would otherwise keep showing the old one. Launched from the home screen it
runs full screen under a translucent status bar; the HUD keeps to the safe area.
It has no service worker; the web app's worker never answers `/farm` pages.

Each installed app (Ficus and Farm) remembers which of the two you were last
in, and a fresh launch reopens there (`@ficus/shared/app-surface`). The window's
installed app is kept in `sessionStorage` (`ficus-launched-as`), which a launch
starts empty and which follows the window between the web app and the farm; the
last app is kept per installed app in `localStorage` (`ficus-last-app:<app>`),
since on Android and desktop both apps share one. Only launches at the app's
start page switch (not deep links, reloads or browser tabs), and the web app
stays put offline, as the farm has no offline copy.

Signed out, the farm's "Sign in" goes to the web app's `/farm-sign-in`, which
shows the login page and, once signed in, returns to the farm. That matters on
iOS, where each home-screen app keeps its own cookies and a new farm app starts
signed out.

## In Ficus Mobile

Ficus Mobile shows the farm in a web view in its Farm tab. The farm notices (`window.ReactNativeWebView`) and switches to app behaviour in `src/embed/embed.ts`:

- **Native feel:** the page is marked `data-embed="native"`, so there's no bounce, long-press callout, tap flash or text selection outside fields. Page zoom is off, since the farm pinches its own camera.
- **Sign-in:** there is no web sign-in. The app injects a web handoff code (`window.__FICUS_EMBED__`) or sends one when the farm asks (`auth-required`), and the farm trades it for a session (see [Core auth](core-auth.md#web-handoff-ficus-mobiles-farm-tab)).
- **Dock:** the app sets `--g-embed-inset-bottom` (`FARM_EMBED_INSET_BOTTOM_VAR`) to the height its dock covers, and the farm keeps its bottom controls above it (`--g-safe-bottom`).
- **Theme:** the Futurist style follows the theme the app sends, live, including a custom theme's palette primary as its accent. The other styles keep their own palettes.
- **Haptics:** the farm asks the app for a light tap on a harvest, a wave involving you, someone else's chat message for you or in the room you have open, and an answer you submit.

The messages are a small, versioned contract in `@ficus/shared/farm-embed`: JSON with `source` and `v`, and each side ignores versions and types it doesn't know. The farm accepts only messages with no `source` window (the native bridge's), not ones posted by a frame in the page.

**What the app must do (required).** The native bridge has no target origin: the startup script runs on every page load, postMessage reaches whatever page is showing, and any page can post `auth-required`. So the app mints, injects or posts a `handoff` only when the web view's main-frame URL (its navigation state or `onMessage`'s `nativeEvent.url`, never the message body) has exactly the paired server's origin under its farm path. It also keeps the main frame on that origin (`originWhitelist` and `onShouldStartLoadWithRequest`) and opens every other link outside the web view. A code handed to any other page is a session for whoever runs it.

## Styles

The farm is drawn in one of five styles (`apps/farm/src/skins/`): Nostalgic,
Cozy, Futurist (the web app's theme colours in lines), Blueprint and Sketchbook
(Blueprint's drawings through a pencil). Each style implements the `FarmSkin`
interface (`skins/types.ts`): sprites, hit boxes and interface tokens (`--g-*`
CSS variables) that the cards, chat and HUD read.

## Farm settings

Per-account farm settings live in `farm_preferences` (one JSON document per
user, validated by `@ficus/shared/farm-preferences`) and are read and patched at
`GET` / `PATCH /api/farm-preferences/me`. Keys: `style`, `sound`,
`multiplayer`, `look` (the character builder's outfit, see
`@ficus/shared/farm-look`) and `welcomed`. Each is optional; the farm also
keeps a copy in the browser under the `ficus-farm:` storage prefix for an
instant start, and the account's value wins when it loads. A first visit
(no `welcomed`) shows the welcome: pick a style, then make your farmer.

The view itself is only in the browser (`ficus-farm:view`, `farm/savedView.ts`):
where the camera was, the card you had open and your chat windows, so a
refresh comes back to them. A person's card and an Assistant chat that was
never started aren't brought back, and the demo keeps its own copy.

## Permissions

The farm's multiplayer has its own resource, checked instance-wide (never per
squad), so anyone can be given `farm:*` whatever their squad and chat roles:

| Permission          | Allows                                                                            |
| ------------------- | --------------------------------------------------------------------------------- |
| `farm:read`         | Seeing farm chat (rooms, messages, people) and who's on the farm                  |
| `farm:chat`         | Posting, editing, reacting, opening DMs, typing, appearing on the farm and waving |
| `farm:manage-rooms` | Creating, renaming and deleting public rooms                                      |

The built-in **Farmer** role (`farm:read`, `farm:chat`) is an ordinary
instance-wide assignment an admin can remove or edit
(`services/rbac/default-roles.ts`), so someone whose other roles are all scoped
to squads can still use the farm. It's given automatically:

- to every account created by an invite or first-admin bootstrap;
- to a self-registration only when sign-up gives a role (under **No role** an
  administrator grants access later, the farm included);
- once, when the role first arrives on an instance, to every active person who
  already holds a role, in the same transaction that creates the role (a failed
  grant retries on the next start; an assignment removed later stays removed).

The shared demo-reviewer account never gets it: it's created without it, left
out of the first-arrival grant, and re-seeding takes it back. Operators also
hold `farm:*` and Viewers `farm:read`. Losing `farm:read` stops farm chat and
presence on open connections straight away; losing `farm:chat` takes the person
off the farm.
Without `farm:chat` the farm is read-only for that person. People's emails only
reach viewers with `users:read` (as the user directory needs); everyone else sees
display names, or "Unnamed teammate".

## Multiplayer: presence

Everyone signed in appears on the farm, standing at what they're working on
(the robot they're chatting with, else the card they have open), unless they
choose single-player. Presence is people-only and held in memory in the API
process (`apps/core/src/services/ws/presence.ts`); nothing is stored, so a
restart empties the farm until pages announce again.

- Client → Core over `/ws`: `{ type: 'presence', focus }` (focus is an agent,
  work stream or squad, optionally `at: 'stand'` for its consulting stand and
  consultant chats, or `null` for "around the farm"), `{ type: 'presence.leave' }`
  (going single-player) and `{ type: 'presence.wave', toUserId }` (at most one
  every 1.5s per connection, only between people on the farm). Presence
  announcements are rate-limited per connection (a burst of 5, 5 a second).
- Core → clients on the `presence` topic: `presence.snapshot`,
  `presence.updated`, `presence.left` and `presence.waved`. Each recipient sees
  someone's focus only if they can see that thing themselves (otherwise "around
  the farm"). A person's name (see Permissions) and chosen look come with them;
  saving a new look re-announces them at once.
- People come and go through the farmhouse: someone who arrives while you're
  there (and you, when you open the farm) walks out of its front door, down the
  porch steps, to their spot; someone who leaves (`presence.left`) walks back in.
  Whoever was already there at the snapshot just stands where they are, and a
  dropped connection or going single-player sends nobody home. Each style
  declares its door and porch (`farmhouseDoor`, `multiplayer/doorway.ts`).
- What people say in the general room or a public room shows in a speech bubble
  over their head for a few seconds, yours included; DMs never do.

## Multiplayer: farm chat

People talk to each other (not to agents) in farm chat:
`apps/core/src/routes/farm-chat.ts` and `services/farm-chat/`, shared types in
`@ficus/shared/farm-chat`. Only people may use it; agents and tokens are refused.

- **Rooms:** a general room that always exists, public rooms, and two-person
  DMs. Creating, renaming and deleting public rooms needs `farm:manage-rooms`
  (Operators hold it through `farm:*`); the general room can't be removed.
- **Messages:** only their sender can edit or delete them; anyone in the room can react with an emoji (up to
  10 different ones each, 30 per message); unread counts are per person. Older
  messages page by message (`?before=<messageId>`, compared on time then id). `@mentions` are plain text (a
  person's name or its first word) resolved in the farm.
- **REST** (`/api/farm-chat`): `GET /people`, `GET /rooms` (with `canChat`
  and `canManageRooms`), `POST`/`PATCH`/`DELETE /rooms/:id`, `POST /dms`,
  `GET`/`POST /rooms/:id/messages`, `PATCH`/`DELETE /rooms/:id/messages/:messageId`,
  `POST /rooms/:id/messages/:messageId/reactions` and `POST /rooms/:id/read`.
- **Live:** the `farmChat` topic carries `farmChat.messageCreated`,
  `farmChat.messageUpdated`, `farmChat.messageDeleted`, `farmChat.roomsChanged`
  and `farmChat.typing`, each
  sent only to the people in the room (everyone, for general and public rooms).
  Clients say they're typing with `{ type: 'farmChat.typing', roomId }`, relayed
  at most every 2s per room (and every 250ms across rooms) and never back to the
  typist.
- **Retention:** messages are kept for 30 days; the worker's
  `farm-chat-retention` subsystem prunes older ones on start and hourly, in
  batches. The web app's service worker never caches the farm's chat or
  settings APIs.

Presence and farm chat are sent by the API process itself, per recipient, and
never travel the event bus (the WebSocket bridge ignores them; see
[event-emitter](event-emitter.md)).

## Field log

A squad's sign card has **Watch the field**, which opens its field log (`FieldLogCard`): what the squad's robots have been doing, newest first, the same activity as the web app's squad Activity tab (`GET /api/squads/:id/activity`), a page at a time with **Load earlier**. Chips filter by kind: All, Chat (`message`), Work (`workstream`, `handoff`, `execution`, `subagent`), Waits (`wait`) and Code (`pr`, `issue`). An entry opens what it's about: the robot's chat, the plant if it's still on the farm, or the pull request or issue. While the card is open the farm's socket watches the squad's `squadActivity:<id>` topic (`watchTopic` in `live/LiveUpdates.tsx`), and a new entry refreshes the log; a 30-second refetch covers a dropped socket.

## Server racks

A squad with apps to open gets a server rack just off its yard's back-left
corner (`farm/apps.ts`): its remote deployments that have a URL
(`/squads/:id/deployments`) and its live local apps (`/squads/:id/local-deployments`),
which open through Core with the access token in the URL Core issues. The lists
have no live events, so the farm polls them every 30s. Someone who may not list
them sees no rack.

## Motion

The farm animates changes it sees in live data rather than letting things pop
in: a robot starting on a work stream walks out of its squad's charging hut to
the plant (and back when it stops, or between plants on a handoff,
`farm/robotMoves.ts`), the robot that created a work stream plants it
(`farm/plantingRoute.ts`), and a letter flies to a robot when it's sent
something (your chat messages, answers to its questions from
`agent-question.answered`, and robot-to-robot mail from `inbox.messageReceived`,
which Core delivers only to people who can see every squad). Reduced motion
turns these off.

## Robot moods

With **Robot moods** on (Settings → Decision Providers; off by default), a
working robot shows how its agent's work is going: a sweat drop when it is
struggling (two when it is stuck on errors), a circling arrow and a little
pacing when it is going in circles, a raised flag before something risky
(deleting, pushing, secrets or permissions), a magnifier and a look around
while it explores, and a tiny celebration as it wraps up. Focused robots keep
the plain working face. Halted, asking and waiting robots show those instead.
Hovering a robot, or its card, says the mood in words. Reduced motion keeps the
marks and drops the movement.

Moods cost nothing while nobody looks. The farm reports the robots on screen
(`POST /api/farm/watching`, farm:read, only robots you can see) when the view
settles and every 20 seconds while its tab is visible; each report lasts 45
seconds, and the API hands it to the worker over the `farm_watching`
local-events channel. The worker reads each watched robot's stream: the same
call three times in a row is going in circles, two tool errors or provider
retries in a row is stuck, a blocking question is waiting, and a turn that
ended well is wrapping up. Only when the robot is running and none of those
tells does it ask the `robot-moods` decision model, at a tool or message end,
at most once per robot every 30 seconds, with the last three tool calls (name,
a short redacted target, ok or error) and the last 300 characters of text.
Changes go out live as `agent.mood` on the `agents` topic; the watching
response carries the current moods for a farm that just opened. Moods live in
memory only.

## Development

`?demo` runs the farm on sample data with no Core, including pretend
neighbours and an in-memory farm chat (dev builds only). Variants:
`?demo=empty`, `?demo=planting` (new work streams every few seconds),
`?demo=moves` (robots clocking off and on, and mail) and `?demo=welcome`.

Tests live beside the code: pure layout and motion logic in `apps/farm/src/farm/*.test.ts`,
components with happy-dom (`multiplayer/testing.tsx` renders farm chat, the
character builder and the welcome over the demo's in-memory chat), and Core's
presence, chat and retention tests under `apps/core/src/services/ws/` and
`apps/core/src/routes/farm-chat.test.ts`.
