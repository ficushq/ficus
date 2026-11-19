---
name: ficus-reviewer
description: Use when running an agent session as a standing reviewer for Ficus squads — blocking on `ficus watch` for attention changes, acting on each event with the `ficus` CLI, and watching the squad's GitHub PRs with a `gh` sidecar. Requires the `ficus` skill.
---

# Reviewing Ficus squads (`ficus watch`)

You are a standing reviewer: a long-lived session that wakes only when a
Ficus squad needs a human-shaped decision, handles it with the `ficus` CLI, and
goes back to waiting. This skill covers the waiting and the triage. The
verbs you act with — `ws flow`, `ws advance`, `ws finish`, `ws resolve-input`,
`ws unblock`, `aq answer`, `inbox send` — and the doctrine behind them live in
the `ficus` skill, which you must have installed and read first. Nothing here
overrides it.

## Prerequisites

```bash
ficus skill install ficus --agent <agent>            # the operator skill (read it)
ficus skill install ficus-reviewer --agent <agent>   # this skill
ficus auth status                                # a paired backend for the instance
ficus watch --timeout 5 --json                   # must print {"events": []} and a cursor
```

`ficus watch` is NOT `ficus ws watch <id>`. The latter adds you to one stream's
notification list. `ficus watch` blocks your process until anything on your
attention surface changes.

## What `ficus watch` reports

It compares snapshots of three read-only surfaces — your pending actions,
your unread inbox messages (from agents, the system, remote peers, or people), and the active/queued work streams you
can see — and prints only what changed. It never reports pre-existing state
and never writes anything.

```bash
ficus watch --json                    # block until a change, print it, exit 0
ficus watch --json --cursor "$CURSOR" # baseline = an earlier result: exact chaining
ficus watch --json --follow           # never exit; one JSON line per change batch
ficus watch -q <squadId>              # one squad only
ficus watch --timeout 900             # one-shot: {"events": []} after 15 min of quiet
ficus watch --poll 60                 # fallback re-check; WebSocket hints are the fast path
```

Every result is `{ at, cursor, events[] }`. Carry `cursor` into the next
call or you will miss anything that happened while you were acting. Every
event has a content-addressed `key`: the same condition never fires twice,
and if a batch is replayed after a crash you dedupe on `key`.

| kind                             | meaning                                                                                                                                                  | do                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workstream.wait`                | a stream opened or changed an open wait (`waitType` manual/question/dependency, or review on a stream without a flow; `message` is the resume condition) | Read `message`, find the wait in `openWaits[]` of `ficus ws get <id> --json`, and handle it as [Waits on a flow stream](#waits-on-a-flow-stream) says. A flow's approval gates arrive as `manual` waits, so never unblock on `waitType` alone. Question and dependency waits resolve themselves — do nothing.                                                                                                                                                                                                                                                                    |
| `action.pending`                 | a pending action needs a response (`type` agent-question, squad-question, agent-error, assistant-needs-input; `canRespond`)                              | `ficus action list`, then `ficus aq answer <id> "<precise answer>"` for questions; for `agent-error`, check machine health through the manager before touching code. `assistant-needs-input` is a task from the owner's private Assistant conversation waiting on the owner's own answer (`data.question`, `data.conversationTitle`), not squad work: leave it for the human unless they told you to answer for them, then reply in that conversation (`ficus search "<title>" --kind assistant_conversation --json` gives its `agentId`; `ficus chat -a <agentId> "<answer>"`). |
| `inbox.message`                  | a message reached your inbox (`senderType` agent/system/remote/user, `senderId`, `subject`)                                                              | `ficus inbox list --json`, read it, `ficus inbox read <id>`. System notices (fleet alerts, stream lifecycle) are read-only context; reply to agents through the manager unless they asked you directly.                                                                                                                                                                                                                                                                                                                                                                          |
| `workstream.created`             | a new active/queued stream appeared                                                                                                                      | Usually nothing; note it for context.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `workstream.done` / `.canceled`  | a stream reached a terminal state                                                                                                                        | Nothing, unless you were tracking a PR for it (see sidecar).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `workstream.idle`                | `--follow` only: active, no execution, no wait for 10 min                                                                                                | Ask the manager for execution state before concluding anything. Idle is the one alarming display, but managers sequence work deliberately.                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `health.degraded` / `.recovered` | three consecutive snapshot failures / first success after                                                                                                | Infrastructure check (`ficus auth status`, instance reachability), not a code problem. Keep the cursor; do not re-baseline.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

## Waits on a flow stream

Every new work stream runs a flow, and its reviews and approvals are steps of
that flow. A flow stream has no review waits: `approve` and `send-back` find
nothing to resolve there and the server refuses them. Read the wait's fields in
`openWaits[]` and check them in this order:

| Wait                                             | What it is                                                                                   | What you do                                                                                                                                                                                                                                                           |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workflowHumanGate: true`                        | A human approval or decision step of the flow                                                | A person decides it. Bring it to your human (below).                                                                                                                                                                                                                  |
| `workflowAttemptLimit: true`                     | The flow paused at its attempts-per-step limit                                               | Only when your human or the manager decides more attempts are worth it: `ficus ws raise-limit <id> --max-step-attempts <n> -m "<why>"`, or `--remove`.                                                                                                                |
| `resolutionHandler: "workflow"` and neither flag | Final delivery approval: the work is complete and the delivery policy needs a person         | Your human approves by finishing, `ficus ws finish <id> --version <v>`, or asks for changes with a `rework` (below). Never on your own judgment.                                                                                                                      |
| `structured` present                             | A typed input: a file, a configuration value, an owner decision, or a recovery Continue/Stop | When you hold what it asks for: `ficus ws resolve-input <id> <waitId>` with the action the request names and its `expectedVersion` (the `ficus` skill has the shape). Leave recovery Continue/Stop holds to the squad manager unless one was forwarded to your human. |
| any other `manual`                               | A prose hold opened by a person or the manager                                               | When you can meet its resume condition: `ficus ws unblock <id> -m "<what changed and what to do now>"`, with `--wait <waitId>` if several are open.                                                                                                                   |

### Bringing a gate to your human

A gate is where the flow asks a person to review, so the merge limits below
apply to it in full. Read it with `ficus ws flow <id> --json`: the flow
`version`, the gate's entry in `activeOutcomes` (its `attemptId` and the
outcomes it declares), the step instructions, and the decision brief and
attachments of the work it reviews. Give your human the decision, your reading
of the work and its CI, and the declared outcomes. Do not choose for them.

When your human tells you their decision, record exactly that decision:

```bash
ficus ws advance <id> --stdin <<'FICUS_COMMAND'
{
  "expectedVersion": <version>,
  "attemptId": <gate attemptId>,
  "action": "complete",
  "outcome": "<an outcome this gate declares>",
  "evidence": "<the person's decision and notes>"
}
FICUS_COMMAND
```

Use only an outcome listed for that attempt in `activeOutcomes`. An outcome
that sends work back needs notes the next agent can act on. Your human can
also decide in the web app, and must when the reviewed work was amended (a
source attempt with `resultRevision` above 1): the flow then requires the
decision to name the revision reviewed, which the web app does. A decision on
an older revision is refused; read the latest one and ask again.

At final delivery approval, a change request is a `rework` instead:
`{"action": "rework", "expectedVersion": <version>, "attemptId": <id>, "feedback": "<what to change>"}`.
`attemptId` is the latest completed agent attempt (or the latest one of the
step named in `completion.changeEventsTo`, when the flow sets it); the refusal
names the right attempt if you pick the wrong one.

## The loop

**One-shot, cursor-carried** — for a harness that runs one tool call per
turn. Give `--timeout` a value shorter than the harness's tool timeout, or
the call is killed and the cursor is lost.

```bash
CURSOR=""
while :; do
  OUT=$(ficus watch --json --timeout 600 ${CURSOR:+--cursor "$CURSOR"}) || break
  CURSOR=$(printf '%s' "$OUT" | jq -r .cursor)
  printf '%s' "$OUT" | jq -c '.events[]'        # act on each; empty means quiet
done
```

**Follow** — for a harness that can stream a background process into the
session. Each line is one batch; persist the last `cursor` so a restart
resumes exactly.

```bash
ficus watch --json --follow | while IFS= read -r line; do
  printf '%s' "$line" | jq -r .cursor > ~/.ficus/reviewer.cursor
  printf '%s' "$line" | jq -c '.events[]'
done
```

Restart with `--cursor "$(cat ~/.ficus/reviewer.cursor)"` after a crash.

## GitHub sidecar

PR activity is not in Ficus. Poll it beside `ficus watch` with `gh` using the
filters below — they exist because CI counters, bot chatter, and your own
comments woke reviewers dozens of times a day for nothing.

Configure: `FICUS_REVIEW_REPO` (`owner/name`), `FICUS_REVIEW_AUTHOR` (the
squad's GitHub login, e.g. the bot account agents push as),
`FICUS_REVIEW_SELF` (your own login; your comments are never events).

```bash
# Normalize open PRs to {number, head, state, draft, ready, failed{}, comments{}}
gh pr list --repo "$FICUS_REVIEW_REPO" --author "$FICUS_REVIEW_AUTHOR" --state open --limit 200 \
  --json number,headRefOid,state,isDraft,statusCheckRollup,comments,reviews |
jq --arg self "$FICUS_REVIEW_SELF" --arg author "$FICUS_REVIEW_AUTHOR" '
  def relevant: (.statusCheckRollup // [])
    | (map(.name // "") | any(startswith("test / "))) as $lanes
    | map(select(
        (($lanes and .name == "test") | not) and
        ((.name // "") | test("diagnostics|\\[code\\]smith|macOS portability suite") | not)));
  def outcome: (.conclusion // .state);
  def actor: (.author.login // .user.login // "");
  def human: actor as $a | $a != "" and $a != $self and
    ($a == $author or (($a | test("\\[bot\\]$") | not) and
      ($a | IN("blacksmith-sh", "codesmith") | not) and
      (.user.type != "Bot") and (.author.__typename != "Bot")));
  map({
    number, head: .headRefOid, state: (.state // "OPEN"), draft: (.isDraft // false),
    ready: ((relevant | length) > 0 and (relevant | all(outcome | IN("SUCCESS","SKIPPED","NEUTRAL")))),
    failed: (relevant | map(select(outcome | IN("FAILURE","TIMED_OUT","CANCELLED","ACTION_REQUIRED","ERROR")))
      | map({key: (.name // .context), value: (.detailsUrl // .targetUrl // outcome)}) | from_entries),
    comments: (((.comments // []) + (.reviews // [])) | map(select(human))
      | map({key: (.id | tostring), value: ((.body // "") + " " + (.state // ""))}) | from_entries)
  })'
```

Keep the previous normalized array; on each poll compare per PR and act on:
a PR you have not seen (new PR), `head` changed (re-review), `state`
changed (merged/closed — on a flow stream the delivery participant finishes
it; on a stream without a flow, resolve its merge-gate wait if the condition is
met), `draft` → not draft (ready for review), `ready` false → true (CI green),
a `failed` entry new or with a new URL (a check failed — a flow's delivery
participant receives CI results itself, so bring it to your human only when it
bears on an open gate; on a stream without a flow, send it back with the URL),
a `comments` entry new or changed (someone other
than you wrote or edited something — read it). Inline review comments
(`gh api repos/$FICUS_REVIEW_REPO/pulls/<n>/comments`) count as comments too.
A previously open PR missing from the list may have merged: `gh pr view <n>`
before deciding.

**A delivery gate is a merge gate, not an LGTM.** CI green is not merged,
and a passing review is not merge authority. You never merge, enable
auto-merge, or approve delivery because checks turned green. On a flow stream
the delivery policy decides when the stream may finish, and
`ficus ws finish` verifies the merge itself; a gate or final delivery approval
is your human's decision. Sending work back is always safe.

## Streams without a flow

Streams created before flows have no flow (`ficus ws flow <id>` returns none)
and use review waits (`waitType` review) instead of gates. The legacy verbs
below serve only such a stream:

- A review wait whose condition holds: `ficus ws approve <id> -m "<note>"`.
  A completing review wait is the merge gate: approve it only when the PR has
  actually merged, or the wait's stated condition is otherwise met.
- A review that needs another round: `ficus ws send-back <id> -m "<what to change>"`.
  It is always safe, and it also clears a review wait left open on a flow
  stream from before flows refused them.
- Pass `--wait <waitId>` when several review waits are open.

## Doctrine

1. **`ficus watch` has no write authority and neither does the sidecar.**
   Everything you do happens through the `ficus` verbs and GitHub, deliberately,
   one event at a time.
2. **Never drop the cursor casually.** Starting without `--cursor` baselines
   to "now" and silently forgets everything that happened while you were
   away. Re-baseline only when you have decided the backlog is not worth
   working.
3. **Dedupe on `key`.** A crash between reading a batch and acting on it can
   replay events; the key is stable, so a seen key is a handled event.
4. **Don't infer stalls from timestamps.** A `workstream.idle` event is a
   prompt to ask the manager, not a verdict. Parked-with-wait is the system
   working.
5. **`health.degraded` is an infrastructure signal.** Check reachability and
   auth first; do not "fix" agent code because polling failed.
6. **Precise resolutions.** Every gate decision, `rework`, `resolve-input`,
   `unblock` and `aq answer` note states what changed, what to do next, and
   any new constraint — the resumed agent reads it as its next instruction.
