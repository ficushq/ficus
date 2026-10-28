# Coordination v4: configuration service

Both Ficus and Pi completed autonomous implementation, integration, review, and
repair, delivering clean committed repositories. They received identical external
results: **25 passed, 5 failed, 46 skipped; neither accepted**. Those counts are
heavily affected by the benchmark's unspecified bootstrap convention, so they do
not establish a reliable implementation-quality winner.

| Observed outcome                       | Ficus       | Pi          |
| -------------------------------------- | ----------- | ----------- |
| Agent execution                        | 50m 20s     | 42m 58s     |
| Settled API cost                       | $5.871567   | $5.261944   |
| Model requests                         | 272         | 296         |
| External tests, pass / fail / skip     | 25 / 5 / 46 | 25 / 5 / 46 |
| Original request preserved byte-exact  | Yes         | Yes         |
| Clean committed final tree             | Yes         | Yes         |
| Native delivery completed before limit | Yes         | Yes         |

Costs exclude offline grading and infrastructure. Times use native agent start
and finish, excluding setup and verification; Ficus's original verifier timeout
is therefore not counted as agent time. Phase spending is **$11.133511 of $50**,
with **$38.866489 remaining**, no unresolved receipts and no provider failures.
Historical phases remain separate and unchanged.

## What the coordination evidence shows

Ficus completed four native work streams: configuration storage/resolution,
parsing/schema validation, approval workflows/diffs, and final integration/review.
Each used native architect, engineer and reviewer steps. Schema work went through
two review returns; integration went through one before approval. Its final tree
is `25f55b42acb7da62d3d0a3b61ab62e927dfb95d9`.

Pi made nine native subagent calls containing twelve assignments: two architect,
eight engineer, and two reviewer assignments. Three calls dispatched two engineers
in parallel with disjoint ownership on shared main. Every assignment referred to
the exact original request. Its first independent review rejected bundled schema
reference handling and HTML routing redirects. Engineers repaired both; an
architect resolved a reference-policy conflict against the original request;
engineer integration and independent re-review then completed. The final tree is
`a155b416e5e1e6a1cfb0625d2bfac03c38417ab8`; the last product change is
`c9b4dca4f926e289666eb8a6766531a7d949135f`, followed only by documentation.

Both preserved source requirements rather than relying solely on lossy plans.
Both demonstrated review rejection followed by engineer repair. This is evidence
that the intended coordination ran, not proof of improved quality attributable to
any single prompt change. Native reviewers reported 410 Ficus and 537 Pi project
tests passing; those suites were not independently rerun by the operator and their
sizes are not a quality comparison.

## Why the external grade is limited

The five failures are identical. Four depend on initial proposal/activation steps
that the suite skipped. Its helper explicitly treats the no-active-version
sentinel as unspecified; the reference returns integer version zero while both
candidates choose no-active/null bootstrap semantics. Later assertions still
assume activation and proposals exist. Forty-six tests are skipped, leaving much
of the intended workflow coverage unexercised.

The fifth test omits the earlier request's required rollback `to_version` but
expects the later request's `409 approval_required`. Both candidates return input
validation `400` first. This is an error-precedence tension, not a waived failure.
No assertion was changed or failure removed. Neither candidate meets the suite's
whole-product acceptance criterion, and these observations do not prove all
untested behavior correct.

Ficus's original verification attempt timed out after 300 seconds because the
fixture captured server logs into undrained pipes. That attempt is retained.
The user authorized a separate grader-only amendment: file-backed log capture,
with identical assertions and timeouts. The exact saved Ficus patch was regraded
offline without model calls or candidate edits. Pi then ran with the same amended
grader and no diagnostic hints. A noisy reference fails with the original fixture
and passes 76/76 with the amended fixture; ordinary and collision controls also
passed their expected outcomes. See `coordination-v4-io-amendment.json`.

## Interpretation and next study

Pi was about seven minutes faster and $0.61 cheaper on this one run. Both completed
the intended coordination without operator intervention, but the compromised test
coverage prevents a strong quality comparison. This is one adapted SCBench case,
not a leaderboard result or statistically supported harness ranking. Requests 1–3
were supplied together; official sequential evaluation differs. Model calls were
serialized by the budget proxy, so this also does not measure production
parallel-throughput gains or human focus time returned.

Before another paid comparison, select a fresh public coordination task and freeze
its inputs. Then audit its grading for unspecified conventions, skipped dependent
tests, noisy servers, and reference/collision behavior. Require usable coverage
before spending on either arm. Keep this case and its flaws in the record; do not
repair candidates against revealed tests or quietly rewrite acceptance criteria.
No further paid run has been started or budget reset requested.

Machine-readable evidence, timestamps, token totals, native dispatch records and
artifact hashes are in `coordination-v4-results.json`. Original timeout evidence is
in `coordination-v4-ficus-interrupted.json`. Private artifacts and every historical
ledger remain preserved.
