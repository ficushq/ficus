# Structured recovery waits and bounded retry policy

Status: **approved for implementation on 2026-10-28, with the binding constraints below**.

The restart-attribution prerequisite is implemented in
[Restart interruption context](../../wiki/restart-recovery.md). This document
defines the approved server/CLI/UI implementation contract. Deployment is a separate authorized operation.

## Goals and boundaries

- A worker cannot turn an unexplained tool/execution failure into an unstructured
  request for operator diagnostics. Failure recovery is investigated in its own
  authorized sandbox, bounded, persisted, and manager-first.
- Questions a person can actually answer (a product/design choice or a specific
  task file/value) remain possible before running anything. These are not failed
  recovery attempts and do not require manufactured failures.
- Existing authorization, human approval, flow scope, dependencies, pauses,
  provider holds, resource slots and unsafe-side-effect protections remain gates.
  Continue is not approval or permission to repeat an unknown external effect.

## Input schema

New worker-openable manual waits use a strict versioned discriminated union.
The server rejects unknown fields and the legacy free-prose `message`-only form for workers. Authenticated people and managers retain ordinary prose task waits; recovery decisions always use the runtime ledger.
Caller attribution and scope come from authenticated identity and the active flow
attempt, never from a claimed role in the payload.

```ts
type ManualInputRequest = {
  schemaVersion: 1
  scope?: 'attempt' | 'stream' // current scope/authorization rules still apply
  flowAttemptId?: number
} & (
  | {
      kind: 'continue'
      recoveryId: string
      expectedRecoveryVersion: number
    }
  | {
      kind: 'decide'
      actor?: 'human' | 'owner'
      purpose: 'task-decision'
      subject: string
      options: Array<{ id: string; label: string; consequence?: string }>
    }
  | {
      kind: 'provide'
      actor?: 'human' | 'owner'
      purpose: 'task-input'
      input: { type: 'file' | 'config-value' | 'product-choice'; name: string }
      use: string
    }
)
```

Subjects, names, labels and consequences are bounded plain-language fields, not
an arbitrary ask or executable instructions. Decisions require 2–8 unique option
ids. `provide` names only an exact task file, configuration value or product choice, not “send diagnostics”.
Credentials must use the existing integration/secret-input surfaces, not raw
secrets in an answer. Platform/host logs, invocation-registry exports, listener
identity and other tenant-inaccessible diagnostic targets are rejected; they are
not valid task inputs. The same validator that rejects untyped waits must reject any wording requesting logs, journal output, registry/host state or a human-run command, including requests disguised as a typed `provide` or `decide`. Tests must cover this binding rule. The question is generated from the kind and its fields.

`decide` and `provide` are for genuine task inputs, not alternative spellings for
an unresolved recovery problem. A recovery-linked request must use its persisted
recovery record and cannot bypass its budget/routing by changing the kind. Enforce
that relationship at the common service boundary and reject known diagnostic
request targets in all worker-facing entry points. This is not a claim that a
keyword filter can understand every possible natural-language request.

The response stores a typed request plus a **server-generated** summary:

```ts
{
  attempted: string,        // safe runtime operation label, or task-input subject
  attemptCount: number,    // authoritative ledger count; zero for a task input
  lastError: string | null,// safe one-line failure; never raw command/log output
  text: string             // generated presentation, not accepted as an ask
}
```

Example: “I tried to run the project tests 3 times. The last attempt stopped before
returning a result.” A task decision instead says “A choice is needed for …”, with
count zero and no error. Technical detail stays in authorized execution context;
it is not an evidence request to a person.

## Retry accounting and safe recovery

Add a durable recovery episode and append-only attempt ledger. An episode binds
the originating agent/execution, work stream/flow attempt when present, operation
identity, current version, state, next retry time and budget cycle. Attempts bind
actual tool invocations or execution startups and their recorded outcomes; the
worker cannot submit a count, fabricate a failure or claim a restart discount.
Record normalized labels and redacted bounded errors, not raw commands, tokens,
full tool outputs or private filesystem contents.

Default budget: **three unexplained failed attempts total**, including the first
failure (therefore two ordinary retries), with backoff of 1 second then 2 seconds.
Server timestamps govern admission; repeated delivery of one outcome is counted
once. Genuine repair/inspection attempts can be linked to the episode, but merely
claiming to have investigated does not spend a retry. Classify outcomes at the
runtime boundary; authorization denials and existing approval/provider gates
retain their separate handling, not an automatic retry loop.

A verified `core_restart` outcome with the durable restart correlation costs zero.
Each restart id grants at most one recovery replay for an interrupted operation;
duplicate events do not grant extra attempts. Wait for sandbox readiness and
inspect partial effects before retrying. Unknown loss is not eligible for this
exception. A new execution, worker restart, CLI retry or changed process identity
does not reset a recovery budget.

Automatically replay only operations the runtime already knows are safe (for
example bounded reads and deterministic overwrites with their existing fences).
Arbitrary Bash or externally mutating operations must not be blindly replayed.
Their consumer first reconciles affected state and issues an authorized safe retry
or a narrower investigation tied to the episode. If safe replay cannot be
established, bounded investigation/reconciliation attempts—not repeated unsafe
side effects—lead to the same Continue/Stop escalation. Human Continue authorizes
another recovery cycle, not the unknown external side effect.

After the third unexplained failed attempt, the runtime can open exactly one
`continue` wait for that episode/version. The same gate is checked when an agent
requests it explicitly. Early, foreign, fabricated, stale or already-resolved
recovery references fail closed with a typed error and do not create a wait.
Persist the exhausted transition and wait atomically. Known restart recovery
alone never opens a manual wait.

## Manager-first resolution

A worker's recovery `continue` is addressed to the **squad manager**, not simply the
work-stream owner. Set recipient provenance server-side; a worker cannot select
`actor: human` to bypass this. Existing `owner` semantics cannot be silently
redefined: add an explicit manager target for recovery, and update projections,
notification fallbacks and Action Center filtering together.

The manager may grant **at most one extra recovery cycle per normalized recovery scope, across successor attempts**. If that extra cycle also exhausts unexplained failures, the server automatically forwards the record to the owner—without manager prose or another manager decision. The Action Center renders only the generated attempted action, count and last error, with Continue/Stop buttons. The manager cannot reset this limit by re-opening or re-forwarding the record.

The manager can inspect its authorized environment, repair/re-plan, then resolve
with Continue or Stop, or explicitly forward the same generated plain question
to the requesting owner. Forwarding is audited and idempotent; it forwards no raw
logs or new forensic prose. The review clarification routes directly to an eligible owner when no eligible manager exists or the failing agent is the manager. One resolver governs notification, visibility and decision authorization: prefer the requesting user or agent owner, then enabled squad management-capability holders/admins with read and decision rights. When nobody resolves, retain the hold and a durable idempotent system diagnostic without granting authority.

- **Continue:** atomically close this recovery wait and authorize a new audited
  three-attempt recovery cycle. A manager can do this once per normalized recovery scope; after its exhaustion, only the owner may authorize another bounded cycle. Requeue only through normal admission; unrelated
  waits, pause, dependency and approval gates remain in force.
- **Stop:** stop further automatic retries and keep the affected scope held for
  the manager's existing re-plan/cancel path. Record the decision and remove the
  repeated human action request; do not silently complete/cancel the deliverable
  or stop independent sibling branches. Resumption needs an explicit authorized
  recovery decision; generic unblock must not bypass this gate.
- **Decide:** accept one declared option id, preserving its revision and scope.
- **Provide:** accept the named file/value through its existing safe input channel.

Typed resolution checks the wait's current version and recipient authority. A
stale button cannot clear another wait, reset a newer budget or approve a review.

## Server, CLI and UI integration

Current entry points to update include:

- `packages/shared/src/{schemas,types}.ts`: typed request, summary and resolution;
- Core `WorkStream.block`, `openWait`, typed wait resolve, generic unblock and
  wait-actor correction: one common validation/routing boundary, not route-only
  enforcement;
- tool/execution failure boundaries and recovery/watchdog producers: durable
  outcome recording and budget decisions, retaining existing startup semantics;
- `ask_human` / agent-question routes when used to open failure-recovery waits:
  normalize to the same policy rather than leaving a free-text escape hatch;
  genuine structured task questions still use their normal authorized audience;
- CLI `request-input`: explicit kind and structured JSON/stdin or flags; no raw
  `-m` ask for new worker manual waits. Emit actionable validation errors;
- web Action Center and work-stream details: Continue / Stop buttons, declared
  option buttons, or the exact named input; no free-text “clear this recovery”
  form. Manager-targeted waits are not owner actions before forwarding;
- update prompt/skill examples and generated CLI help to use the new contract.

Question-based waits, workflow-owned human approvals and system/provider recovery
holds are distinct typed pathways, not generic manual-wait bypasses. Inspect all
worker-callable writers and reject untyped worker manual waits at the shared
service boundary even if they bypass the public route.

## Compatibility, privacy and tests

Add nullable structured payload/summary/recipient fields to existing wait rows,
plus recovery episode/attempt tables and constrained identities/versioning. Old
rows retain their original text, actor and resolution history; render them as
legacy waits, never invent a three-attempt history. Existing historical displays
and authorized legacy resolution continue to work. No new worker-created legacy
waits are accepted. Update generated schema fixtures/expected database contracts.

Identity and existing scope checks remain authoritative. Only runtime code may
write counted attempt outcomes; tenant-controlled strings cannot mint restart
proof. Apply existing redaction before persistence/notifications and map unsafe
errors to a plain one-line category. Cross-squad ids and foreign flow attempts
must not leak summaries or count toward another operation's budget.

Required focused coverage:

1. Simulated restart mid-command: exact reason/correlation and resume notice,
   readiness/partial-effect inspection, safe retry, zero budget charge, no wait.
2. Three unexplained failures: durable counts and backoff, no early wait, then one
   manager-targeted Continue/Stop with the exact generated summary.
3. Free-text host-log ask rejected by server, including alternate worker writers;
   fabricated counts, restart claims, foreign ids and kind-switch bypass rejected.
4. Manager handling/forwarding, the one-extra-cycle limit and automatic owner
   escalation on its exhaustion (generated summary only); owner visibility and
   authorization; duplicate and
   stale decisions; Continue does not clear unrelated gates; Stop preserves scope.
5. Legitimate design/input requests before failure; exact file/value and option
   validation; legacy history display/resolution; CLI serialization and UI buttons.
6. Shared prompt doctrine for worker/engineer/reviewer/general/manager and absence
   of instructions to request platform forensics; regression checks for existing
   approval, pause, dependency, slot and provider behavior.

No production restart, deployment, infrastructure addition or permission change
is part of implementing or verifying this design. Policy approval permits the
structural implementation only; it is not deployment or merge authorization.
