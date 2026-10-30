# Human decision briefs and queued reviews

A decision brief is the producing agent's round-specific explanation for a person making a decision. It does not replace `evidence`, grant permissions, clear sequencing holds, or change the gate's instructions. Managers keep instructions about the **kind** of gate; durable constraints belong in the stream description.

## Completion contract

`ficus workstream advance` accepts `decisionBrief` on `action: complete` alongside the independent `evidence` string, and on `action: return` alongside the independent `feedback` string. The object is required for an **agent-produced** completion whose effective chosen route enters human approval, including authorized explicit returns, completion return/resume overrides, immediate parallel destinations, early arrivals at a human join, and queued gate starts. It is optional otherwise. Producer kind comes from the pinned step, not the caller's identity. An operator completing or returning an agent step has the same obligation. Explicit returns retain their existing declared/flexible path authorization and `resumeAt` semantics; neither human/model returns nor agent-to-agent returns gain a mandatory brief. `--attach` is available on `complete` and `amend`.

```json
{
  "action": "complete",
  "expectedVersion": 3,
  "attemptId": 4,
  "outcome": "ready",
  "evidence": "The design and fallback verification are attached in staging-design.md.",
  "decisionBrief": {
    "decision": "Approve the staging migration design.",
    "recommendation": "Approve because the tested fallback preserves existing readers.",
    "approvalEffect": "Approval permits implementation for `cache-stage-example` only, not production deployment or deletion. Sequencing holds must still clear before execution.",
    "risks": "Two temporary read paths increase maintenance work.",
    "changesSinceLastReview": "The earlier review requested a retained staging reader. This revision preserves it during rollback; production scope is unchanged."
  }
}
```

| Field                    | Maximum characters | Meaning                                                                                                                                                |
| ------------------------ | -----------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `decision`               |                500 | One or two plain, history-independent sentences stating the person's choice.                                                                           |
| `recommendation`         |              1,000 | What the agent recommends and why.                                                                                                                     |
| `approvalEffect`         |              2,400 | What approval permits, exact resource IDs, what remains forbidden, and remaining conditions.                                                           |
| `risks`                  |              1,600 | Principal risks, costs and tradeoffs being accepted.                                                                                                   |
| `changesSinceLastReview` |              2,000 | Last decision, why work returned or an execution failed/stopped, and what changed. Required after an earlier decision on the same gate in this stream. |

All values are strings, trimmed only at their outer edges, with at least one character. Limits use JavaScript UTF-16 length after trimming. Nulls, arrays, scalar coercion, empty optional fields and unknown keys are rejected. Omit `changesSinceLastReview` on a first review if it is not relevant. A supplied optional brief is validated too.

An earlier decision includes an empty-note approval and a human return for rework. Canceled gates, model decisions and merely opening/clearing a wait do not count. Historical pinned step kind and the exact gate step ID determine identity, not today's title. Earlier decisions remain relevant after reopening the stream. New decisions store their settlement version; legacy ordering can use stored transition receipts without rewriting history.

### Readable prose

Write every text field in normal, readable prose with normal spacing and complete words. Never remove spaces, run words together, invent abbreviations, or use telegraphic shorthand to save tokens or length. When material is long, use headings, bullets, or a linked file instead of compressing it. Preserve exact identifiers, code, URLs, paths, and quoted source material; the rule governs authored prose, not literal data.

The deterministic linter applies **only to these new fields**, not every existing write. It masks code, link destinations, URLs, paths, UUIDs, hashes and explicitly quoted source spans. It requires explanatory prose (at least three Unicode word segments for `decision`, two for other fields), rejects control characters other than tab/newline/CR and the invisible separators U+200B/U+2060/U+FEFF, and rejects high-confidence compression outside literals:

- Sentence punctuation followed immediately by a Latin word without spacing (normal abbreviations and decimal/version numbers are preserved).
- An ASCII alphabetic run longer than 32 characters, or a lower/camel-case token with at least three word boundaries, such as `approveTheExactRetryPacket`.
- The shorthand tokens `pls`, `plz`, `thx`, `apprv`, `reqd`, `rdy`, `b4`, `w/`, `w/o`, and `b/c`.

`decision` additionally rejects headings, lists and fenced blocks, and uses Unicode sentence segmentation to reject more than two sentences. Terminal punctuation is optional. Technical acronyms such as API, SQL, CI, PR, GB and GiB are allowed. Delimit exact identifiers with backticks if they resemble compressed prose. Literal bytes are never repaired or rewritten. This conservative linter is not a grammar, factual-accuracy or authorization judge; the full prose rule still governs authoring and review.

Literal detection deliberately tolerates ambiguous lowercase dotted words: `Approve the retry.proceed with staging now.` and `Approve the change.then deploy it to staging.` still pass. Private hostnames and resource suffixes need not be public TLDs. A capitalized continuation followed by an imperative in `Approve the change to main.ts.Then deploy it now.` is flagged, while explicit file/host/resource contexts, paths, URLs, emails and inline code remain literal. For short prose such as `Approve this.then deploy.`, the existing minimum-word refusal names the likely run-on token; genuinely short ordinary prose still asks for an explanatory sentence. This is a contextual backstop, not a domain allowlist or a suffix blacklist.

Shape/length/prose errors are HTTP 400 issues at `command.decisionBrief.<field>`. The field messages name readable prose, `1–<limit> characters`, or the one/two-sentence decision requirement. Conditional failures are HTTP 409:

- `A decisionBrief is required for outcome '<outcome>' because it sends this agent's result to human approval '<gate-id>'.`
- `A decisionBrief is required for return to '<gate-id>' because it sends this agent's result to human approval '<gate-id>'.`
- `decisionBrief.changesSinceLastReview is required because human approval '<gate-id>' has an earlier decision (attempt <id>).`

All effective target gates are checked, not just the first or an obsolete definition. Validation rejects before persistent state, waits, receipts, participants or dispatch writes. CLI contextual preflight checks both complete and explicit return commands before posting, and runs before completion attachment uploads; exact closed-attempt request-ID retries still reach the server receipt. Existing identity, version, permission and wait authorization remain authoritative.

## History, provenance and non-agent arrivals

The producing source attempt stores `decisionBrief: { value, submittedVersion, contexts }` in existing run JSONB. Contexts retain the target gate ID, previous decision attempt, return IDs, revision versions and bounded interruption facts. The destination round stores an immutable `reviewBrief` reference: gate-specific authored source IDs with optional separate `carriedSourceAttemptIds`, one carried-forward source ID, explicit `none`, or a legacy marker. Context target IDs classify join sources independently of branch arrival order. Queued starts preserve the binding; pre-deploy queued targets without one retain legacy rendering when admitted. When an agent settled before briefs existed and a human branch closes its join afterward, the new gate also retains legacy presentation if no eligible authored or carried brief exists. This uses the absence of both brief and settlement-version metadata on the nearest completed agent, within the same causal/epoch/restart boundaries; it does not search unrelated sources. No migration or backfill rewrites existing gates, evidence, instructions or decisions.

Flow inspection includes `reviewContexts`, keyed by active producer attempt ID: target outcomes, optional `viaReturn: true` for an authorized explicit return target, previous decision notes, causal return feedback, revision reasons and exactly attributed failed/stopped execution facts. Producers receive this context on both inbox and inline assignments and must refresh `workstream flow` immediately before submission to see same-attempt retries. Receipt timestamps bound the interruption interval after the latest decision, even when a parallel producer started earlier; return history uses settlement versions rather than creation order when available. Execution reads use the existing agent/status/start-time index, the exact stream ID and the flow creation time as a lower bound, returning at most 200 newest failed/stopped executions from causal agents. Only the structural `failureClass` is exposed; `failureReason`, raw errors, logs, transcripts and unrelated executions are not included. An application-level safe abort in a successfully completed execution remains described by its evidence, not invented as a failed execution.

Human-to-human and automatic-model routing have **no new authoring requirement**. For their human gate destination, the most recent eligible brief is displayed read-only with **Carried forward from an earlier step** and **Prepared for an earlier step; this is not a new decision brief for this gate.** Original source step/attempt and scope remain visible. If none exists, the screen says **No decision brief for this gate** with the gate's own message.

The runtime has no separate global multi-step flow-attempt ID: the boundary is the current causal producing-attempt lineage inside the authorized stream's run. Selection walks backward from actual source IDs through completed non-agent steps and stops at the nearest agent on each path. A newer agent without a brief does not borrow an older agent's brief. Reopen epoch boundaries, canceled sources, ordinary returned agent boundaries, and fresh-session non-agent restarts do not donate older briefs. Returned non-agent steps remain lineage bridges. A fresh agent return-to-human submission explicitly bound to that round can be carried through subsequent non-agent steps, without walking beyond it. Joined non-agent arrivals select the eligible source with greatest submission version, then attempt ID. Historical bound rounds retain their recorded provenance after reopening; they cannot lend it to the new pass. A restarted human-approval destination itself also starts a fresh boundary: inherited source IDs never make its previous brief eligible. It records `none` and shows its new own message; the same read-only rule protects already-stored restarted gates without rewriting history. A restarted agent can still author a genuinely new brief for a later gate. No stream-wide latest-brief query or cross-stream search is used.

## Review screen

A brief-present review starts with **Human approval · <gate-kind summary>**, then **Decision brief**, **Prepared by <step> · Attempt <n>**, and these fields in order:

1. **Decision**
2. **Recommendation**
3. **What approval allows**
4. **Risks and tradeoffs**
5. **What changed since your last review**, when supplied

The gate-kind subtitle uses the first plain-text sentence, clamped at a word boundary to 160 characters with an ellipsis. The first and default document tab is **Decision brief**. Attachments are neighboring peer tabs and load only when selected; returning to the first tab restores the brief. Only the internal agent handoff is initially collapsed beneath the brief, labeled **Internal handoff**. Legacy reviews keep their handoff-first layout. Web and Farm show the same brief fields, separate carried-source labels, explicit missing-brief messages and blockers. Actual contributing join briefs retain their individual provenance; only submissions whose contexts name this gate and have not already fed a settled round are authored for it, while the most recent other eligible source is labeled carried forward. **Earlier decisions (<n>)** preserves previous notes and round-bound briefs. All brief fields are read-only. Outcome captions use effective completion routing, so an open return destination can override an ordinary finish edge.

An older agent-origin gate with no brief retains its existing instructions, handoff and attachment layout. Missing older source links also retain legacy rendering rather than guessing provenance. Known non-agent arrivals use the explicit carry-forward/none behavior above. Reads never mutate an existing gate.

## Chatting with the producing agent and amending while a gate is open

The review screen shows the conversation of the **producing agent**: the agent bound to each agent attempt that feeds the open gate (decision steps pass through, as for the brief). It is the same agent and session as **Open chat**; no agent is created, and the first message wakes a dormant agent in its existing session. A gate fed by several agents (a join) shows a picker. Gates with no producing agent keep the layout without chat.

- **Wide screens (1024 px and wider):** the document (brief and attachment tabs) on the left; on the right the work stream summary, the chat, and the decision controls pinned below the chat. The chat scrolls on its own and never pushes notes, **Approved** or **Changes requested** out of reach.
- **Narrower screens, including phones below 768 px:** a **Brief / Chat** switch above two panes that both stay mounted, so scroll position, drafts and in-flight sends survive switching. The decision sheet stays pinned below both panes.

A message sent from the review screen by a person who may decide the gate carries `reviewConsultation: { workStreamId, gateAttemptId }`. `POST /api/agents/:id/message` validates it (the gate is open, the sender may decide it, and the recipient is its producing agent) and stamps server-owned message metadata; otherwise it refuses with 409 `REVIEW_NOT_OPEN` (**This review is no longer open, so the message was not sent.**) or 403 `REVIEW_CONSULTATION_FORBIDDEN`, and nothing is sent. Only the model copy of a stamped message carries a bracketed context: the gate and attempt under review and their revision, that a person is deciding now, to answer and cite evidence, to use `amend` for refinements the person asks for, and to say plainly when a request is too big for a refinement (a new approach, a security change, a material change of scope) and recommend **Changes requested**. When amending is not possible for that gate, the context says why. Ordinary chats, inbox messages and readers without decision rights never carry it, and a client cannot set the stamp itself.

### The `amend` action

An agent may revise its own completed attempt while the human approval gate it feeds is open:

```sh
ficus workstream advance STREAM_ID --stdin --attach docs/design.md <<'FICUS_COMMAND'
{
  "action": "amend",
  "expectedVersion": 9,
  "attemptId": 12,
  "evidence": "Added the rollback note the reviewer asked for in commit 5d6e7f8.",
  "decisionBrief": { "decision": "…", "recommendation": "…", "approvalEffect": "…", "risks": "…" },
  "removeAttachmentPaths": ["docs/old-notes.md"]
}
FICUS_COMMAND
```

The command carries the complete revised `decisionBrief` and `evidence`, with the same schema, prose validation and `changesSinceLastReview` rule as completing the step. Code and file changes go on the stream's branch, and the evidence names them (for example the commit SHAs). Files attached with `--attach` add or replace files by path; `removeAttachmentPaths` drops files; every other file carries over unchanged. An attempt revision holds at most 10 files. Files are staged for the next revision as they are uploaded; if that amend is then refused, they stay staged and become part of the next successful amend unless it replaces them by path or names them in `removeAttachmentPaths`.

`amend` is refused, before anything is written, when:

| Condition                                                                                | Response                                                                                                               |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| The caller is not the agent bound to that attempt (another agent, a person, an operator) | 403 `Only the agent that completed attempt <n> can amend it.`                                                          |
| The version is stale                                                                     | 409 `Stale flow version`                                                                                               |
| The attempt is not a completed agent attempt                                             | 409 `Only a completed attempt can be amended; attempt <n> is <status>.`                                                |
| The gate it fed has been decided                                                         | 409 `Human approval '<gate>' is no longer open, so attempt <n> can no longer be amended.`                              |
| It feeds no open gate (nothing, a queued start or an open join)                          | 409 `Attempt <n> does not feed an open human approval gate.`                                                           |
| Another step already used the result (an agent, an automatic decision)                   | 409 `Attempt <n>'s result was already used by '<step>' (attempt <m>); …`                                               |
| The gate did not open with this attempt's own brief (legacy, carried forward, restarted) | 409 `… did not open with this attempt's decision brief, so it cannot be amended; recommend Changes requested instead.` |
| The attempt already has 20 revisions                                                     | 409 `Attempt <n> has reached 20 revisions; recommend Changes requested instead.`                                       |

Pause, queued and terminal streams refuse as for any advance. Waits on the gate do not block an amend: they block decisions, not the refinement the reviewer asked for.

Each amendment is a new **result revision** of the same attempt. Revision 1 is the original completion; amendments are 2, 3 and so on. The attempt's `evidence`, `decisionBrief` and `attachmentIds` always hold the latest revision, so every existing reader shows it; superseded revisions move unchanged to `earlierResults` (`revision`, `version`, `recordedAt`, `evidence`, `decisionBrief`, `attachmentIds`). Attempts that predate this read as revision 1. Attachment rows carry the revision they were uploaded for, and files staged for an amend never replace or delete a recorded revision's file; an unchanged re-upload keeps the current file's ID. Flow inspection returns `attachments` (each attempt's current files) and `earlierAttachments` (files only an earlier revision used); every file stays downloadable by ID.

An amend bumps the run version and records a transition receipt (request-ID retries return it), and changes nothing else: the gate stays open with its wait, no attempt starts or settles, and joins, returns, queued starts, definition revisions and earlier decisions are untouched. It is not a review round, so a later amend after an earlier decision still needs `changesSinceLastReview`. Parallel siblings simply see the new version and re-read. Because only a result waiting at an open gate can be amended and every decision is fenced to the latest revision, a brief carried forward after the decision is always the revision that was decided.

### Decisions follow revisions

The review screen always shows the latest revision. A revision that arrives after the reviewer opened the review (or after the revision they last looked at, remembered for the browser session) is marked on the source line (**Revision 2 · Revised 2 min ago**) and a **What changed since you last looked** section lists each changed brief field as **Before** and **Now**, the unchanged fields, whether the internal handoff changed, and the files **Added**, **Removed** and **Changed**. Until the reviewer presses **Mark as reviewed**, the decision controls stay visible but disabled, with **This was revised since you opened it. Review the latest revision.**

Human `complete` and `return` commands on a gate accept `reviewedRevisions: [{ attemptId, revision }]`, the source revisions the person reviewed. Core checks them before the version: if any is no longer current it refuses with 409, code `WORKFLOW_REVIEW_REVISED` and the exact message above, and nothing is decided (no wait closes, no receipt is written, and the notes stay in the browser). A client that sends no revisions is refused the same way when an amendment landed after its `expectedVersion`. Every human decision records the server-computed `reviewedRevisions` on its gate attempt, and the next step's incoming results name it, even without notes, for example `approval (attempt 13): Approved revision 3 of design attempt 12. Notes: …` or `Changes requested on revision 2 of design attempt 12. No decision notes.` A human approval's first forward outcome reads as `Approved`; any other forward choice reads as `Chose '<outcome>' on revision …`. When the notes are also the reworked step's rework request, the line says `The notes are the rework request above.` instead of repeating them. Earlier decisions in the review screen show the same sentence. Farm sends the reviewed revisions, shows the marker and the change list, and keeps its **Open chat** link instead of an inline chat.

## Blocked review eligibility

A canonical human gate is actionable only when no other applicable wait blocks its decision. Only that exact gate wait is exempt; another workflow-owned wait on the same attempt remains a blocker. Stream-wide waits and waits pinned to this gate apply; sibling-attempt waits do not. The backend still makes the final authorization decision.

Blocked gates remain readable. They are omitted as actionable reviews from Feed **Needs you**, not hidden from the stream. Status presents the actual blocker, including **Waiting on Owner** or **Waiting on Manager**, with quiet secondary **Review queued** text. Other actionable questions, human input and sibling gates remain visible. Farm keeps a question badge for independently actionable questions even when a failure or sequencing state controls the plant; badge classification does not clear or reinterpret review blockers. The callout opens **Read review** instead of **Review and decide**. Decision controls are disabled and explain, before the buttons:

> This review is queued. You can read it now, but you cannot decide until the following blockers are cleared.

Each applicable wait shows its message under **Waiting on owner:**, **Waiting on manager:**, **Waiting for an answer:**, **Waiting on a dependency:**, **Waiting on input:**, or **Waiting on another review:**. Missing messages say **No details were provided.** Permission restrictions remain separate. Once blockers clear, normal invalidation makes the same unchanged gate actionable again; no gate rewrite or artificial approval is needed. Terminal/pause precedence and legacy delivery behavior remain unchanged.

## Focused verification

Shared schema/runtime/history/wait tests, Core transaction/API/action tests, CLI preflight tests and web DOM tests cover this contract. The isolated synthetic browser runner uses the real modal and styles without a backend:

```sh
cd apps/web
CHROMIUM_PATH=/path/to/chromium SCREENSHOT_DIR=/path/outside/repository bun scripts/check-workflow-review-brief.ts
```

It checks first/repeat/blocked/carry-forward/none/legacy, explicit agent return and restarted-human cases at narrow/wide sizes in both appearances, attachment access, long-ID wrapping, disabled controls and clearance. It closes its browser and server in `finally`. Do not use private live gates or customer content for fixtures.

`bun scripts/check-workflow-review-chat.ts` (same environment variables) checks the inline chat at 390 px and 1280 px in both appearances: the chat scrolls on its own while the notes, outcomes and composer stay on screen, review messages carry the consultation, the phone **Brief / Chat** switch, and an amendment's marker, change list and **Mark as reviewed**.

Human-waiting decision-model steps retain their existing routing and authoring contract. A voluntary eligible brief is displayed read-only as carried forward; otherwise they show **No decision brief for this gate** and their own message. Returned human steps remain lineage bridges, unlike returned agent boundaries. Missing-brief diagnostics explain the required JSON fields and their placement beside evidence or return feedback, including the conditional change summary, so already-running agents can correct their submission without a new prompt. Technical literals such as domains, file names, bare paths, email addresses, versions and inline code are preserved; compression diagnostics identify the offending token.

Attachment selection follows the same decision-transparent incoming sources as the handoff, unioned with authored and carried brief sources. An optional brief is never required to preserve an upstream file tab, including legacy reviews. The destination fresh-session boundary also applies to a restarted decision step when it falls back to a person: show **No decision brief for this gate** and its replacement message, not the previous session’s brief. Historical sources remain unchanged.
