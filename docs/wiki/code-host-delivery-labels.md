# Code-host delivery labels

`WorkStreamDeliveryPresentation.explanation.codeHostReason` is an optional,
server-owned, presentation-only field. It describes the canonical winning
designated pull request, not necessarily the primary PR. It changes no delivery
policy, state ordering, attention aggregate, approval requirement or merge authority.

| Kind     | Reason            | Row label                                                         |
| -------- | ----------------- | ----------------------------------------------------------------- |
| external | ci-pending        | Awaiting CI                                                       |
| external | draft             | PR is draft                                                       |
| external | awaiting-merge    | Awaiting merge                                                    |
| external | merged            | PR merged — finalizing delivery (PRs for multiple designated PRs) |
| failure  | ci-failed         | CI failed                                                         |
| failure  | merge-conflict    | Resolve merge conflicts                                           |
| failure  | changes-requested | Changes requested                                                 |
| failure  | closed            | PR closed without merging                                         |

Review and human merge keep their existing kind labels: **Review Pull Request**
and **Merge Pull Request**. A required review outranks pending CI; actual failures
outrank review and draft. Failure reasons follow conflict, CI, changes-requested
order when more than one negative fact survives the classifier's supersession rules.

Consumers first select the presentation state (including wait/pause/terminal
precedence), then use `codeHostDeliveryLabel` only for selected external/failure
states. Unknown/future reasons, incompatible kind/reason pairs and omitted reasons
return null: keep the existing generic label. Do not reconstruct a reason from raw
`gates`, PR existence or metadata. Older clients may ignore this additive field;
older servers keep the client's generic fallback. Widget aggregate labels/counts
and rankings must not change; only individual row labels consume the reason.

Core only asserts CI-pending/awaiting-merge with current-head, unexpired evidence;
a clean provider aggregate is the readiness proof, not an open PR. Generic
`blocked` is not proof of conflict and has no specific reason. Standing same-head
review requirements and valid negative facts retain the classifier's existing
rules. All designated PRs must be classified merged for finalization.
Serialization uses batched local evidence, never provider calls or new polling.

The portable fixture matrix is `CODE_HOST_DELIVERY_PRESENTATION_CASES` in
`@ficus/shared/test-fixtures/work-stream-presentation`. It specifies wire facts,
label, state, role, attention and aggregate bucket, including old/unknown payloads,
review plus CI, branch-protection ambiguity and wait precedence. Core's
`delivery-state.test.ts` exercises actual event classification, expiry, head
changes and multi-PR selection; clients should consume these facts, not replay
that classifier.
