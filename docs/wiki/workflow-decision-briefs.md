# Human decision briefs and queued reviews

A decision brief is the producing agent's round-specific explanation for a person making a decision. It does not replace `evidence`, grant permissions, clear sequencing holds, or change the gate's instructions. Managers keep instructions about the **kind** of gate; durable constraints belong in the stream description.

## Completion contract

`ficus workstream advance` accepts `decisionBrief` on `action: complete`, alongside the independent `evidence` string. The object is required for an **agent-produced** completion whose effective chosen route enters human approval, including return/resume overrides, immediate parallel destinations, early arrivals at a human join, and queued gate starts. It is optional otherwise. Producer kind comes from the pinned step, not the caller's identity. An operator completing an agent step has the same obligation.

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

Shape/length/prose errors are HTTP 400 issues at `command.decisionBrief.<field>`. The field messages name readable prose, `1–<limit> characters`, or the one/two-sentence decision requirement. Conditional failures are HTTP 409:

- `A decisionBrief is required for outcome '<outcome>' because it sends this agent's result to human approval '<gate-id>'.`
- `decisionBrief.changesSinceLastReview is required because human approval '<gate-id>' has an earlier decision (attempt <id>).`

All effective target gates are checked, not just the first or an obsolete definition. Validation rejects before persistent state, waits, receipts, participants or dispatch writes. CLI contextual preflight also runs before attachment uploads; exact closed-attempt request-ID retries still reach the server receipt. Existing identity, version, permission and wait authorization remain authoritative.

## History, provenance and non-agent arrivals

The completing source attempt stores `decisionBrief: { value, submittedVersion, contexts }` in existing run JSONB. Contexts retain the target gate ID, previous decision attempt, return IDs, revision versions and bounded interruption facts. The destination round stores an immutable `reviewBrief` reference: authored source IDs, one carried-forward source ID, or explicit `none`. Queued starts preserve the binding. No migration or backfill rewrites existing gates, evidence, instructions or decisions.

Flow inspection includes `reviewContexts`, keyed by active producer attempt ID: target outcomes, previous decision notes, causal return feedback, revision reasons and exactly attributed failed/stopped execution facts. Producers receive this context on both inbox and inline assignments and must refresh `workstream flow` immediately before submission to see same-attempt retries. Raw errors, logs, transcripts and unrelated executions are not included. An application-level safe abort in a successfully completed execution remains described by its evidence, not invented as a failed execution.

Human-to-human and automatic-model routing have **no new authoring requirement**. For their human gate destination, the most recent eligible brief is displayed read-only with **Carried forward from an earlier step** and **Prepared for an earlier step; this is not a new decision brief for this gate.** Original source step/attempt and scope remain visible. If none exists, the screen says **No decision brief for this gate** with the gate's own message.

The runtime has no separate global multi-step flow-attempt ID: the boundary is the current causal producing-attempt lineage inside the authorized stream's run. Selection walks backward from actual source IDs through completed non-agent steps and stops at the nearest agent on each path. A newer agent without a brief does not borrow an older agent's brief. Reopen epoch boundaries, canceled/returned sources, and fresh-session non-agent restarts do not donate older briefs. A fresh agent return-to-human submission explicitly bound to that round can be carried through subsequent non-agent steps, without walking beyond it. Joined non-agent arrivals select the eligible source with greatest submission version, then attempt ID. Historical bound rounds retain their recorded provenance after reopening; they cannot lend it to the new pass. No stream-wide latest-brief query or cross-stream search is used.

## Review screen

A brief-present review starts with **Human approval · <gate-kind summary>**, then **Decision brief**, **Prepared by <step> · Attempt <n>**, and these fields in order:

1. **Decision**
2. **Recommendation**
3. **What approval allows**
4. **Risks and tradeoffs**
5. **What changed since your last review**, when supplied

The gate-kind subtitle uses the first plain-text sentence, clamped at a word boundary to 160 characters with an ellipsis. Full instructions, separate evidence and attachment tabs remain accessible in the initially closed **Evidence and attachments** disclosure. Selecting an attachment never replaces the leading brief. Actual contributing join briefs retain their individual provenance. **Earlier decisions (<n>)** preserves previous notes and round-bound briefs. All brief fields are read-only.

An older agent-origin gate with no brief retains its existing instructions, handoff and attachment layout. Missing older source links also retain legacy rendering rather than guessing provenance. Known non-agent arrivals use the explicit carry-forward/none behavior above. Reads never mutate an existing gate.

## Blocked review eligibility

A canonical human gate is actionable only when no other applicable wait blocks its decision. Only that exact gate wait is exempt; another workflow-owned wait on the same attempt remains a blocker. Stream-wide waits and waits pinned to this gate apply; sibling-attempt waits do not. The backend still makes the final authorization decision.

Blocked gates remain readable. They are omitted as actionable reviews from Feed **Needs you**, not hidden from the stream. Status presents the actual blocker, including **Waiting on Owner** or **Waiting on Manager**, with quiet secondary **Review queued** text. Other actionable questions, human input and sibling gates remain visible. The callout opens **Read review** instead of **Review and decide**. Decision controls are disabled and explain, before the buttons:

> This review is queued. You can read it now, but you cannot decide until the following blockers are cleared.

Each applicable wait shows its message under **Waiting on owner:**, **Waiting on manager:**, **Waiting for an answer:**, **Waiting on a dependency:**, **Waiting on input:**, or **Waiting on another review:**. Missing messages say **No details were provided.** Permission restrictions remain separate. Once blockers clear, normal invalidation makes the same unchanged gate actionable again; no gate rewrite or artificial approval is needed. Terminal/pause precedence and legacy delivery behavior remain unchanged.

## Focused verification

Shared schema/runtime/history/wait tests, Core transaction/API/action tests, CLI preflight tests and web DOM tests cover this contract. The isolated synthetic browser runner uses the real modal and styles without a backend:

```sh
cd apps/web
CHROMIUM_PATH=/path/to/chromium SCREENSHOT_DIR=/path/outside/repository bun scripts/check-workflow-review-brief.ts
```

It checks first/repeat/blocked/carry-forward/none/legacy cases at narrow/wide sizes in both appearances, attachment access, long-ID wrapping, disabled controls and clearance. It closes its browser and server in `finally`. Do not use private live gates or customer content for fixtures.
