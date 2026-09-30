---
name: frontend-visual-review
description: Use when previewing a UI, capturing screenshots, or iterating visually on frontend work. Covers hosting a dev server in the sandbox, opening it with the browser tools, and reading console/console-error output.
---

# Frontend Visual Review

## When to use

- Building or changing any UI (HTML/CSS/JS, React, Vue, etc.) that benefits from being _seen_.
- Validating a bugfix that has a visible symptom (layout, color, missing element, broken click).
- Producing screenshots for review or design discussion.

**Do not** use this skill for headless logic/unit tests — keep those in your test runner.

## Prerequisites

- The `browser_*` tools (`browser_open`, `browser_click`, `browser_type`, `browser_scroll`, `browser_screenshot`, `browser_read`, `browser_console`) are available in your agent type.
- The instance has a browser-reachable `APP_URL` configured for path-based local apps (hosted app URLs already have their own origin).
- A working dev server command (e.g. `bun run dev`, `npm run dev`, `python3 -m http.server`).

## Command runtime

Run every command in this skill with `squad_bash` from the project worktree. Start the server, localhost probe, `ficus deploy local` commands, and diagnostics in that same shared runtime: a local deployment cannot reach a server started in private `bash`. If `squad_bash` is unavailable, **do not** start or attach a local app from private `bash`: delegate the shared-runtime server/deployment operation to an agent that has it. Use an available shell only for operations its Workspace & Sandbox prompt says can reach the required project/runtime.

## The 5-step loop

1. **Start the dev server** bound to `0.0.0.0` so the sandbox's local-deployment proxy can reach it.
2. **Register it as a private Ficus local app** so Ficus can authorize the browser handoff.
3. **Open it** with `browser_open`.
4. **Screenshot / read / interact** with the other `browser_*` tools.
5. **Iterate** — edit code, the dev server hot-reloads, repeat steps 3–4.

## Steps 1–2: Start a managed Ficus local app

Use the project's server command, but let Ficus supervise it and assign `$PORT`. The command must bind to `0.0.0.0` and honor `$FICUS_APP_BASE_PATH`. Use a unique `RUN_NAME` per project.

```bash
SQUAD_ID=<your-squad-id> # from `ficus workstream get <id> --json`
RUN_NAME=<unique-project-name>

# Vite/React example (run through squad_bash)
ficus deploy local start "$SQUAD_ID" \
  --name "$RUN_NAME" \
  --cwd "$PWD" \
  --command 'bun run dev -- --host 0.0.0.0 --port $PORT --base $FICUS_APP_BASE_PATH' \
  --json | jq '{id, name, status, port}'

# Find an existing run without printing its credential URL.
ficus deploy local list "$SQUAD_ID" --json | \
  jq --arg name "$RUN_NAME" '.[] | select(.name == $name) | {id, name, status, port}'
```

For other frameworks, adapt only `--command`; keep the managed launch, bind address, assigned `$PORT`, and base-path support. Managed local apps are supervised and restartable conveniences, not a durability mechanism for one-shot builds, migrations, tests, or generation jobs.

Verify app health directly in the shared runtime, without putting a launch credential in a shell command or log:

```bash
DEPLOYMENT_ID=<full-id-from-the-output-above>
APP_PORT=$(ficus deploy local get "$DEPLOYMENT_ID" --json | jq -r '.port')
curl -sS -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:$APP_PORT/"
# Use the app's own health route/base path if it does not serve /.
```

A loopback success proves the app is listening, not that proxy/browser access works. Verify that separately with the next step.

## Step 3: Open it with `browser_open`

Pass the **full deployment UUID**, not its credential URL:

```json
{ "localDeploymentId": "<full-deployment-uuid>" }
```

Ficus checks the calling agent's current `deployments:read` permission for that squad and the deployment's current state, resolves the issued URL internally, and passes it directly to the browser backend. Both hosted app origins and path-based proxy URLs are supported. The result includes a screenshot without echoing the launch URL or page title. The proxy's existing token/cookie authentication remains in force; subsequent asset requests use its app-scoped cookie.

Never print, copy into tool arguments, or post `urlPathOrHost`/`_ficus_token` values. Redaction is intentional, not something to work around. Ordinary non-credential URLs still use `browser_open({ "url": "https://example.com" })`; provide exactly one of `url` or `localDeploymentId`. On an older instance without the ID option, ask for an upgrade rather than copying a redacted credential.

If opening fails, check the deployment status and your access, then the instance's `APP_URL` and browser-to-proxy connectivity. A `403` from an edge provider (for example Cloudflare error `1010`, even on unsigned requests) is not evidence that Ficus rejected the launch credential. Report that separately to the operator; do not weaken authentication or change edge settings. Screenshots and page content can contain app-owned sensitive data: use synthetic fixtures and inspect before sharing.

## Step 4: Capture / inspect / interact

- `browser_screenshot` — capture the current viewport. Useful before _and_ after a change so you can compare.
- `browser_read` (optional `selector`) — extract visible text; good for asserting expected copy without parsing the screenshot.
- `browser_console` — returns the most recent ~50 console entries (`log`, `info`, `warn`, `error`). **Always check this when something looks off** — bundler errors and React warnings show up here.
- `browser_click({ selector | x, y })`, `browser_type({ text, selector? })`, `browser_scroll({ direction, amount? })` — drive simple interactions for multi-screen flows.

## Step 5: Iterate

Most dev servers (Vite, Next.js, Remix, etc.) hot-reload on file change. After editing, re-run `browser_open` (or `browser_screenshot` on the same page) and compare. If the change didn't take effect, re-call `browser_open` with the same `localDeploymentId` — the browser session is reused per agent run, so this re-navigates the existing page using the current authorized URL.

## Saving screenshots for handoff

`browser_screenshot` already attaches the image to your tool response, which is what reviewers and humans see. If you want a persistent copy you can reference later:

```bash
# After a screenshot call, the image is part of your tool result. To save one
# explicitly, take it with Playwright via a short script if needed. For most
# review handoffs, attaching the tool response is enough — do not over-engineer.
```

To put a saved screenshot on a PR or issue, use `gh pr comment <n> --attach ./shot.png`
(repeat `--attach` for several files; alt text follows the path after `#`).

## Cleanup

When you're done iterating, archive the local app so the Apps tab stays clean:

```bash
ficus deploy local archive <deployment-id>
```

## Troubleshooting

| Symptom                                           | Cause / fix                                                                                                                                                                      |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local preview cannot be opened.                   | Use the full `localDeploymentId`; check caller access, active deployment state, configured `APP_URL`, and browser connectivity. Do not guess a proxy origin or copy credentials. |
| Page loads but is blank/white.                    | Check `browser_console` for JS errors and bundler messages first. Then verify the dev server actually serves index.html at `/` (some frameworks need a base path).               |
| App-owned login redirect after the preview opens. | The app's login is separate from Ficus preview access. Use its supported login flow with authorized synthetic test accounts; do not bypass either authentication layer.          |
| Old screenshot is reused.                         | Browser session is per-run. Call `browser_open` with the same deployment ID to navigate again, or scroll to top with `browser_scroll`.                                           |
| Squad has hit the local-deployment limit.         | `ficus deploy local list --include-archived` then archive stale ones with `ficus deploy local archive <id>`.                                                                     |

## See also

- `deploy-app` — broader app deployment skill (covers external providers).
- `apps/core/src/tools/browser.ts` — source of truth for `browser_*` tool parameter shapes.
