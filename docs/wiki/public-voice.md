# Public voice

How agents write text that people outside Ficus read: commit messages, pull request titles and bodies, review replies, issue comments, and channel messages (Slack, Discord, Telegram). Handoff evidence, decision briefs and questions to a person are not public text; the readable-text rule governs them.

Public text has two parts:

1. **Fixed rules** in the `public-text` shared prompt (`config/agent-types/shared/public-text.md`): speak as Ficus in the first person, no Ficus internals or sandbox paths, no secrets, never describe a skipped or bypassed check as passed, no Ficus link syntax. They are not configurable through the voice.
2. **The voice**: configuration, resolved per squad and rendered into a generated `### Voice` section at the end of `public-text`, through the `{{squad.publicVoice}}` token.

## Profiles and the three layers

Voices are **named, instance-level profiles** in the `public_voices` table, synced from `config/public-voices/*.yaml` by `PublicVoiceSync` (template snapshot, field overrides, disable and revert, like model tiers). Each profile has a `base` voice and optional entries for five surfaces: `commits`, `pullRequests`, `reviewReplies`, `issueComments`, `channels`. Each entry is either an **addition** (`add`: appended to the base for that surface) or an **override** (`override`: replaces the base for that surface).

The shipped profile `default` is the **instance default**. Admins can edit it (recorded as field overrides, revertable) or disable it; it cannot be deleted.

A squad has two columns: `squads.public_voice_id` (the assigned profile; null means the instance default) and `squads.public_voice` (the squad's own layer: an optional custom `base` and per-surface entries). Resolution (`resolvePublicVoice` in `packages/shared/src/public-voice.ts`, shared by Core, CLI and web):

- The base comes from exactly one place: the squad's custom base, else the assigned profile, else `default`. Setting a custom base clears the assignment and assigning a profile clears the custom base; a request with both is refused.
- A squad with a custom base ignores every profile, so its voice is entirely its own.
- Per surface, the squad's entry shadows the profile's entry for that surface only.
- A disabled or deleted assigned profile falls back to `default`; the squad's voice reports `fallback: assigned_disabled | assigned_missing`. Deleting a profile sets its squads' assignment to null through the foreign key.
- Nothing anywhere (for example `default` disabled and nothing assigned) renders no section; only the fixed rules apply.

The rendered section is the base once, then only the surfaces with an effective entry, in fixed order. Overrides are marked "(instead of the voice above)". The profile's name never appears in the prompt.

## Size cap

The rendered voice section is capped at **2,000 UTF-8 bytes** (`PUBLIC_VOICE_MAX_BYTES`). The shipped default renders to about 940 bytes; with the fixed rules it costs about 1,610 bytes per turn, against 853 bytes for the old "Public communication" section it replaces.

- Saving a profile checks the profile rendered by itself; the response says how many assigned squads are now over the cap with their own entries (`overCapSquadCount`). YAML sync checks each profile too, and revert validates the stored template before restoring it.
- Saving a squad's voice checks the would-be result with its effective profile and refuses with `400 public_voice_too_long` (with `bytes` and `maxBytes`).
- At prompt assembly, a voice that is still over the cap (a profile edited after a squad saved) drops surface entries from the end of the fixed order (channels first) until it fits, logs a warning once per squad per process, and the squad's Voice page shows what was dropped.

## Which agents receive it

`public-text` is in the includes of every built-in type that can post publicly: architect, engineer, reviewer, general, sysops, security-auditor, manager, consultant (including Slack, Discord and Telegram channel consultants), system-manager and assistant-worker. Runners resolve the token at prompt assembly (`lib/prompts/public-voice-prompt.ts`): squad workers and managers with their squad's voice; system-manager and assistant-worker with the instance default. Custom types whose prompt lacks the token get the section appended once, while `public-text` is enabled. The Settings preview of an agent type's composed prompt shows the instance default voice.

Not included: `assistant` (no tools), `artifact-builder-default` (publishes artifacts) and `subagent`. Subagent guidance (`shared/subagents.md`) tells the parent to write commit messages and other public text itself, or rewrite a subagent's draft, because subagents do not carry the voice.

Existing custom types, and built-in types whose include list an admin overrode, gain `public-text` right after `squad-rules` once, on the shared-prompt sync that first stores `public-text` (`services/config-sync/public-text-include.ts`). An overridden `squad-rules` that still contains the old "Public communication" section is logged, not rewritten.

## Permissions

| Action                                                                                                    | Permission                                                              |
| --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| List and read profiles, template diff                                                                     | `agent-types:read`                                                      |
| Create, edit, delete, disable, enable, revert a profile                                                   | `agent-types:update`                                                    |
| Read a squad's voice, including its effective profile's full text and the names of profiles it may choose | `squads:read` in that squad                                             |
| Assign a profile, set or clear the squad's own voice and entries, preview                                 | `squads:update` in that squad                                           |
| Derive a draft through the squad's GitHub connection                                                      | User identity plus `squads:update` and `integrations:use` in that squad |

A squad can always see its own effective voice: `GET /api/squads/:id/voice` returns the effective profile's **full text** with `squads:read`, without requiring `agent-types:read`. A caller with `squads:update` can assign any available profile and read it as the squad's voice. `agent-types:read` is required for the instance-wide profile API, not these squad-scoped reads.

## API

Profiles, `routes/public-voices.ts` at `/api/public-voices`: `GET /`, `GET /:id`, `GET /:id/template-diff`, `POST /`, `PUT /:id`, `DELETE /:id` (`409 default_profile_cannot_be_deleted` for `default`; shipped profiles are disabled rather than deleted), `POST /:id/disable`, `/enable`, `/revert-to-template`.

Squad, `routes/squad-voice.ts` at `/api/squads/:id/voice`:

- `GET` returns the assignment, the squad layer, the effective profile, `fallback`, `availableVoices` (id, name and description only), the resolved voice with `baseSource`, `entrySources`, `perSurface`, `rendered`, `bytes`, `overCap`, `dropped`, and the caller's linked GitHub login (prefill only, not a derivation permission check).
- `PATCH { voiceId?, base?, surfaces? }` merges like `typeContext`: `null` deletes a surface entry. `400 unknown_voice` for a missing or disabled profile.
- `DELETE` clears the assignment and the squad layer.
- `POST /preview { surface, sample?, draft?, voiceId? }` rewrites a sample comment (a built-in pull request comment by default) in the resolved voice, including unsaved edits, with one Lite-tier completion recorded as `lite:public-voice-preview`. `502 preview_unavailable` when no model answers.
- `POST /derive` (below).

## CLI

```
ficus voice list | show <id>
ficus voice create <id> --name <name> (--text <voice> | --file <path> | --from-draft <draft.json>) [--description <d>] [--add <surface=text>]... [--override <surface=text>]...
ficus voice update <id> [same options] [--remove-surface <name>]...   # surface entries merge over the stored ones
ficus voice delete|disable|enable|revert <id>
ficus voice derive --squad <squadId> --github <login> [filters]

ficus squad voice show <squadId>
ficus squad voice use <squadId> <voiceId> | --instance-default
ficus squad voice set <squadId> (--text <voice> | --file <path>)
ficus squad voice set <squadId> --surface <name> (--add | --override) (--text <text> | --file <path>)
ficus squad voice clear <squadId> [--surface <name> | --all]
ficus squad voice preview <squadId> [--surface <name>] [--sample <text>] [--voice <voiceId>]
ficus squad voice derive <squadId> --github <login> [filters]
```

Surface names on the CLI: `commits`, `pull-requests`, `review-replies`, `issue-comments`, `channels`. Derivation filters: `--before <date>`, `--after <date>`, `--repo owner/name` and `--exclude-repo owner/name` (repeatable), `--surfaces pull-requests,issue-comments,reviews,commits`, `--include-tool-authored`, `--out <draft.json>`. There is no apply flag: a person saves the edited draft with `ficus voice create --from-draft` or `ficus squad voice set --file`.

## Web

- **Settings → Agent Types → Voices**: the profile list with size and assigned squads, an editor per profile (name, description, voice, five surface rows, byte meter, revert for shipped profiles), disable, delete for admin-created profiles, Add profile, and a Derive card that drafts through a chosen squad's GitHub connection and opens a new profile prefilled.
- **Squad settings → Voice** (`components/squads/SquadVoiceSettings.tsx`): pick Instance default, a profile, or Custom for this squad; per-surface rows (Inherit, Add to the voice, Replace the voice) with the inherited entry shown greyed; a byte meter computed with the shared renderer; Preview; and a Derive card whose draft fills the custom voice unsaved ("Save as new profile" with `agent-types:update`). Without `squads:update` the page shows the resolved voice read-only.

## Deriving a voice from GitHub

`POST /api/squads/:id/voice/derive { login, filters? }` (`services/public-voice/`):

1. **Whose voice.** Derivation requires a user identity; agent callers receive `403 derivation_requires_person`, even with manager permissions. Any login visible through the squad's GitHub connection can be sampled immediately; no linked-account comparison or other-person confirmation is required. The draft describes a style; agents never sign as or claim to be that person, posts still come from the Ficus identity, and the fixed rules win over any derived habit.
2. **Sampling** (`github-activity.ts`) through the squad's default GitHub connection with GraphQL: one request for the user's pull requests (titles and bodies), issue comments, review bodies and inline comments (one-year contributions window) and the repositories committed to; up to three more pages each for pull requests and comments when the date filters need them; one aliased request for default-branch commit messages in up to eight repositories. If a repository filter exceeds eight eligible entries, `commitRepositoriesNotSampled` lists the entries whose commits were not read. Partial responses are kept: a repository that does not exist or is not visible comes back null, is reported in the summary as unavailable, and the other samples are kept. Two to eight requests, roughly 10 to 40 points of the 5,000-point hourly GraphQL budget. REST search was rejected (30 requests per minute, one call per item for bodies).
3. **Filters** (`DerivationFilters`): `before` (for example when Ficus started posting from the account, since Ficus adds no marker to what it posts), `after`, `repositories`, `excludeRepositories`, `surfaces`, `excludeToolAuthored` (default on). The tool-authored filter is a heuristic: assistant `Co-authored-by` trailers, "Generated with/by", the robot emoji and similar markers. Dates and repositories are the reliable filters.
4. **Cleaning** (`samples.ts`): strip fenced code, quoted lines, HTML comments, template checklists and trailers; drop bot and template items and items under 20 characters; clean titles and commit headlines as well as bodies; redact emails, URLs and credential-shaped strings (GitHub tokens, AWS key ids, bearer tokens, long hex and base64 runs); truncate to 1,200 characters; interleave up to 120 items (30 pull requests, 40 comments, 30 reviews, 30 commits) within 40 KB. Fewer than 15 items is `422 derivation_too_few_samples` with the counts.
5. **One model call with no tools** (`derive.ts`): a session on the standard tier with no tools, recorded in the inference ledger as `public-voice-derive`, with a 90-second deadline. The system prompt frames the samples as untrusted data that may contain instructions to ignore, asks for the style rather than the person, and asks for JSON only.
6. **Validation**: a non-empty string base is required. Observations, surface notes and exemplars are validated independently: malformed or overlong items are dropped (160, 200 and 240 characters respectively); observations are capped at 12 and exemplars at six. Missing or wholly unusable optional items do not reject a usable base. Exemplars are kept only when they are verbatim substrings of a sample from a **public** repository; private repositories only inform paraphrased observations. Strings with Ficus links, sandbox paths, mentions, emails, URLs or credential-shaped strings are dropped. Base, observations and surface notes are checked for private-sample copying (30 consecutive characters or six consecutive words, case-insensitive); copied notes are dropped. If the base contains unsafe or overlapping text, whole failing sentences or lines are dropped, and the joined remainder is checked again. An empty or still-unsafe remainder is rejected; neither the patterns nor the private-overlap thresholds are relaxed. This can preserve a useful draft when a style description contains a mention, a domain, or an ordinary phrase that also appears in a private sample. No extra model call is made. The draft is trimmed to the cap by dropping exemplars, then observations.
7. **Result**: the draft, observations, exemplars with their repositories, and a sampling summary (filters applied, counts by reason, per-surface date range, public and private repositories, whether paging was capped, repositories that were not found or not visible). Repository names, including private ones and those reported as unavailable, are intentionally visible in this summary to the requesting user. Nothing is written; one derivation runs per squad at a time (`429 derivation_in_progress`).

All structured derivation application failures use **HTTP 422**, including `derivation_github_unavailable`, `derivation_login_not_visible`, `derivation_too_few_samples`, `derivation_invalid_output`, and `derivation_model_unavailable`. This keeps application failures out of the gateway/proxy outage path. Authentication and permission failures remain 401/403; concurrency remains 429. Genuine gateway and network failures are not relabeled.

The CLI displays the code plus a shared plain-language explanation; the page shows the explanation first and the code in expandable details, including validated sample counts and a safe explanation of invalid-output reasons. The route logs only the squad id, code and an allowlisted reason token (including bounded numeric GitHub HTTP statuses); absent reasons are `unspecified` and unknown values are `unknown`. It never includes samples, model output, drafts, request bodies or unrelated metadata in that diagnostic. Old servers' structured 502 responses are still explained when their bodies reach the client.

The synthetic validation cohort in `services/public-voice/derive.test.ts` measures the old output schema and base-rejection predicate against optional-item and sentence salvage. It is deliberately enriched for unsafe content and is not a model-backed or production failure-rate estimate. Earlier unlogged failures cannot be attributed to a particular validator retroactively.

### Live derivation progress

Web and CLI request the same POST with `Accept: text/event-stream`. Ordinary JSON clients keep the existing result and HTTP error contract. New clients also accept an older server's JSON result from that same request; they never repeat the POST to fall back.

The request owns the work; there is no persistent job, replay, reconnect or resume token. Each `event: derivation` frame contains strict JSON with `version: 1`, an opaque `runId`, an increasing `seq`, and one of:

- `started`, then `phase` (`collecting`, `sampling`, `drafting`, `validating`).
- `repositories`, with validated owner/name strings and activity transitions. User-level activity pages report repositories already read; commit queries report their repositories before reading. Names may include private repositories, as in the finished sampling summary.
- `counts`, with `provisional`, `totals`, `bySurface` and `pagingCapped`. Every row has `seen`, `kept` and `dropped` by `date`, `repository`, `tool_authored`, `template_or_short`, `surface_limit`, `sample_limit` and `input_byte_limit`. Seen equals kept plus dropped. Counts measure candidate writing units, not all contributions on GitHub: each nonempty review body and inline comment counts separately, including when filtered out. This corrects the older filtered-review group count without changing selected prose. Collection snapshots are provisional because later candidates can displace earlier samples. Disabled surfaces remain zero; unavailable repositories and paging limits are limitations, not fabricated dropped samples.
- `finding`, containing only an observation retained by complete draft validation and cap trimming. Findings arrive near completion, never as model tokens. No sample excerpt, private quote, credential or raw model output appears in progress. Public exemplars remain only in the validated final result, not finding events.
- Exactly one terminal `complete` with the ordinary unsaved result, or `error` with an allowlisted code, safe reason and optional counts/minimum. After streaming begins, HTTP is already 200; clients inspect the terminal event. EOF without a terminal is `derivation_stream_interrupted`, not success. Pre-admission permission, validation and concurrency errors remain ordinary HTTP errors. The final result optionally includes `sampling.breakdown` with the reconciled count snapshot.

Cancel, navigation, a squad change, CLI SIGINT/SIGTERM and observed disconnect abort local collection/model work and release the process-local per-squad lock immediately, without waiting for a provider to settle. Ownership tokens prevent an old cleanup from unlocking a new run. Remote provider cancellation is best-effort; late results are discarded. Physical network loss is detected through disconnects, heartbeats, blocked writes or deadlines, not instantaneously. GitHub retains its 15-second fetch timeout, the model phase has 90 seconds including session preparation, and the request has 210 seconds overall. A deadline sends `derivation_timed_out` only if an immediate best-effort terminal write is possible; otherwise clients report interruption. Heartbeats arrive every 10 seconds, a blocked write cancels after 15 seconds, and clients enforce 30 seconds without a frame and a 220-second outer deadline.

The stream is bounded to 512 data events, 64 KiB per frame, 2 MiB per run and eight queued frames; normal publishers await backpressure, and heartbeats do not queue behind it. Model output is capped at 64 KiB before parsing. Existing collection, input and draft limits remain unchanged. The web retains at most 100 recent activity lines, announces stages and throttled aggregate counts, and enables draft actions only after success. Nothing is saved automatically.

CLI progress is plain readable lines on **stderr**, including in `--json` mode. Final JSON on stdout and the `--out` document keep their shape; the file is written only after success. Add `--no-progress` to suppress progress, not errors. SIGINT and SIGTERM cancel with exit codes 130 and 143. The human-only API permission remains decisive.

Fixture-only browser verification (no account or backend) is available with `CHROMIUM_PATH=/path/to/chromium SCREENSHOT_DIR=/optional/output bun apps/web/scripts/check-voice-progress.ts` from the repository root.
