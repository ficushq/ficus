# Tool-result firewall

The decision-model firewall screens web/browser text and recognized shell fetches before they reach an agent. It runs **after stored-secret output redaction**. A clean verdict does not make content trusted instructions; it only leaves the tool result unchanged.

## Documentation is data

The classifier distinguishes attempts to redirect the **current reader** from instructions represented as data. CLI help, workflow configuration, agent-facing documentation, and quoted security examples are not suspicious merely because they address agents or use imperatives. Instructions to override the user's task, conceal actions, leak secrets, or change permissions remain attacks even when disguised as documentation or help.

No tool name, `--help` flag, local path, heading, or printed boundary marker grants trust or exempts a result from screening.

## Severity policy

For each screened part:

| Evidence                                                                             | Result                              |
| ------------------------------------------------------------------------------------ | ----------------------------------- |
| Malicious intent probability at least 0.7                                            | High: withhold                      |
| Malicious intent probability at least 0.5 but below 0.7                              | Medium: warn and fence as untrusted |
| Redirection probability at least 0.5, without benign intent probability at least 0.7 | Medium: warn and fence as untrusted |
| Otherwise                                                                            | Leave unchanged                     |

The chosen intent's own probability is used, not a provider's concentration-style confidence when probabilities are available. Agent-directed language alone cannot cause withholding. A high redirection answer paired with confidently benign intent passes; an ambiguous or missing intent can warn but cannot withhold. This deliberately avoids treating confidence that language addresses an agent as confidence that it is an attack. The `instructs_agent` answer and stored `instructsAgent` field retain their names for compatibility; warnings describe the score as redirection likelihood, **not attack probability**.

This policy relies on the classifier recognizing malicious intent. Deterministic tests exercise the policy and integration, not model accuracy; adversarial live evaluation is required when changing prompts or thresholds.

## Shell context and provenance

Recognized external fetches still cause the **entire combined output** to be screened, including local help or repository text in the same call. The source label reports _detected fetches_ and says output provenance is unverified. It does not attribute every byte to a particular command or attempt to reconstruct stdout boundaries.

The classifier also receives a bounded structural `commandContext` in request state. This is intentionally **not the raw shell command**: tool arguments have not passed through the output-secret redactor. Only fixed command/operation vocabulary and the presence of `--help` are retained. Arbitrary arguments, executable paths/names, credentials, URL queries, headers, request bodies, assignments, file paths, grep patterns and heredoc bodies are omitted. Unknown commands become `other command`. Nested shell parsing is bounded, as in fetch detection, and the summary retains at most 32 commands plus an omission notice.

This lossy summary is a hint about syntax, not a guarantee of what ran or where output originated. All request state is untrusted data, never classifier policy. The vocabulary filter protects privacy; it is not a command screening allowlist. Existing fetch-source hints are still derived separately by the fetch detector (for HTTP URLs, host/path without userinfo or query).

## Cache and existing limits

Verdicts are cached by the complete effective request (fixed questions, tool, source, structural command context, content and chunk position) plus decision purpose. Identical text under different classifier context is screened again.

Existing limits remain: 24,000-character chunks, at most eight screened parts, a three-second screening timeout, and fail-open behavior when screening is disabled, unavailable, or fails. Local-only reads and commands not recognized by the fetch detector remain outside this feature. Context does not expand or bypass detection. When a part is high severity, that part and unscreened parts are withheld; other parts remain fenced as untrusted.

## Validation

Focused deterministic tests (from `apps/core`):

```sh
bun run test src/services/decisions/tool-firewall.test.ts src/services/decisions/shell-fetch.test.ts src/services/decisions/evals/replay.test.ts src/entities/AgentSession.test.ts
bun run test:db:down
```

Live classifier evaluation (from the repository root, with authorized enabled providers and the worker's temporary `decisions:evaluate` permission):

```sh
bun run decisions:eval tool-firewall --from worker --repeat 2 --record --max-cost 1
```

Worker mode uses only the injected worker identity, not provider credentials or a human login. See [Decision evaluation access](decision-evaluations.md) for authorization, provider selection, rate limits and revocation. Revoke temporary evaluation permission when live calls finish.

With two providers, 17 cases repeated twice require 68 calls, exceeding the endpoint's 60-call/minute limit if they complete in one window. If rate-limited, retain the failure evidence and run each provider separately with `--provider <kind>` (34 calls), leaving a full rate-limit window between runs. Recording merges provider results into the same snapshot. Inspect every repeat, not just the snapshot's first answered attempt. `--max-cost` is a soft per-run budget, not a hard quota; account for all runs and do not retry indefinitely.

Operators may explicitly select `--from env`, `--from local`, or an authorized `--from backend:<label>` as described in the access guide. Workers must not fall back to a human backend or read provider credentials. Do not put credentials in commands, logs, or committed fixtures.

Inspect all mandatory cases, margins and repeat flips, then commit the generated `apps/core/src/services/decisions/__decision-snapshots__/tool-firewall.json`. Offline replay flags old prompt snapshots as stale; successful replay of stale entries is **not** evidence for the new classifier. The eval includes the reported mixed-help/status/grep example, standalone agent documentation, quoted attacks, real redirects, forged boundaries, and attacks disguised as or mixed with help.
