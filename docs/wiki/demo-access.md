# Demo reviewer access

App-store reviewers need to pair fresh phones with a Ficus instance: no passkey,
no mailbox to verify, nobody on hand to approve a device. A **designated demo
instance** opts into a `/demo` page where a private reviewer access code yields
an ordinary device pairing code for a shared, limited demo account. Everything
downstream is the normal pairing flow.

## What it is not

- Not a login: the browser is never signed in. The page only mints a
  [pairing code](mobile-app.md) (90 seconds, single use), the same one the
  Devices page mints for an ordinary user.
- Not a bypass: the paired device gets an ordinary per-device token for a user
  holding the `demo-reviewer` role (viewer permissions plus chat, answering
  questions, and resolving review requests). Rotating the secret or disabling
  the demo user fails every device it ever paired.
- Not present unless configured: without `FICUS_DEMO_REVIEWER_ACCESS` the route
  answers 404, the page redirects home, and `/api/demo/*` does not exist.

## Enable it on the demo instance

| Setting                      | Where                                                   | Purpose                                                                                                                                |
| ---------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `FICUS_DEMO_REVIEWER_ACCESS` | server environment (`1`, `true`, `yes`)                 | Serves the `/demo` page, `POST /api/auth/demo/pair`, and the admin `/api/demo/*` routes. Off by default.                               |
| `DEMO_REVIEWER_SECRET`       | secret store (env at first boot, or Settings → Secrets) | The reviewer access code. At least 16 characters. Rotate or delete it to stop new pairings; existing devices need `ficus demo revoke`. |

Then seed the world the reviewer will see, as an admin of that instance:

```bash
ficus demo seed      # idempotent: creates what is missing, keeps what you curated
ficus demo revoke    # sign every reviewer device out
```

`ficus demo seed` creates the `demo-reviewer@demo.invalid` account (RFC 2606
reserved TLD: it can never receive mail) with the `demo-reviewer` role, two
squads with agents, work streams in several states including an open review
request, a manager conversation, open questions addressed to the reviewer, and
an inbox message. Every item carries a stable key, so re-running after an
upgrade or a partial failure only adds what is missing; edit `DEMO_CONTENT` in
`apps/core/src/services/demo/seed.ts` to change the story. The summary reports
whether a model provider is connected — without one, agents cannot answer.

## Endpoints

| Route                           | Auth                                  | Behaviour                                                                                                                                                                                                                            |
| ------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/auth/status`          | none                                  | `demoReviewerAccess: true` when the page is served; says nothing about the secret or the seed.                                                                                                                                       |
| `POST /api/auth/demo/pair`      | `{ secret }` in the body              | 404 when off; 429 after 5 attempts per address per minute (valid or not); 401 on a wrong code (timing-safe SHA-256 compare); 503 `demo_not_seeded` until the demo user exists and is enabled; else `{ code, serverUrl, expiresAt }`. |
| `POST /api/auth/pair/claim`     | the pairing code                      | Unchanged: single use, expires after 90 seconds, yields a device token for the demo user.                                                                                                                                            |
| `POST /api/demo/seed`           | `system:demo` (admins) + the env flag | Runs the seed; 409 with a message when a bundled role or preset is missing from the deployment.                                                                                                                                      |
| `POST /api/demo/revoke-devices` | `system:demo` + the env flag          | Revokes every live device token of the demo user (`{ revoked: n }`).                                                                                                                                                                 |

Code: `apps/core/src/services/demo/access.ts` (gate, secret, rate limit, code
minting), `apps/core/src/services/demo/seed.ts` (content and idempotent seed),
`apps/core/src/routes/demo.ts`, `apps/web/src/components/auth/DemoAccessPage.tsx`.

## App Store review notes (template)

Paste into the review notes, replacing the placeholders. Give the access code
through the reviewer-notes field, never in a public place.

> Ficus connects to a server you run; the app has no accounts of its own. To
> review it, use our hosted demo server:
>
> 1. On the phone, open `https://DEMO_HOST/demo` in Safari.
> 2. Enter the reviewer access code: `ACCESS_CODE`.
> 3. Tap **Open in the Ficus app** (or scan the QR from another device). The app
>    pairs in one step; no password or email is needed.
> 4. You are signed in as the shared "App Review" account. Try: the **Feed** and
>    squad pages, a chat with the _Product Engineering_ manager, answering the
>    open question under **Actions**, and approving the _Fix flaky payment
>    webhook retries_ review request.
>
> Each pairing code is single-use and expires after 90 seconds; return to the
> page and generate another for each device or reinstall. Sign-out from
> **Settings → Devices** removes the pairing.

## Test steps before submitting

1. `curl -X POST https://DEMO_HOST/api/auth/demo/pair` on an instance without
   the flag → 404. With the flag and a wrong code → 401; the sixth attempt in a
   minute → 429.
2. Pair one fresh phone through `/demo`; pair a second device with a new code;
   confirm the first code cannot be reused.
3. `ficus demo revoke` → both devices are signed out on their next request.
4. Rotate `DEMO_REVIEWER_SECRET` → the old code stops working immediately.
5. As the demo user, confirm Settings, Secrets, Integrations and user management
   are not reachable, and that squads cannot be created or deleted.
