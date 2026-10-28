# Reviewer contract diagnostic v1

The new guidance did **not** catch the target regression in this diagnostic. Both the baseline and candidate reviewers missed the header-excluding row-number interpretation under the original request. Both correctly avoided flagging it when an explicit user amendment permitted that interpretation. All four reviews requested changes for other ingestion issues, so the overall verdict alone would conceal the target miss.

This is a selected, known-artifact regression diagnostic with one fresh native review per cell. It is not a new benchmark score or evidence of a general prompt improvement. PR #753 should not be described as a validated fix for the observed row-number failure.

## Frozen comparison

[Plan](review-contract-v1-plan.json) and [ready manifest](review-contract-v1-ready.json) were committed as `f259556a` before inference. Each session reviewed the exact untouched Ficus increment-2 artifact from [longitudinal-v1](longitudinal-v1-results.md), including its plans, tests and documentation. No earlier conversation, external grade, reference solution or expected finding was supplied. The host-only amendment control changed the requirements, not the artifact.

The production baseline reviewer YAML is from `990b2230^`; the candidate is from `990b2230` (PR #753). Both overlay the same older frozen native runtime. The only difference between prompt conditions is the generic “Check Design Assumptions” section. Native configuration synchronization verified the entire requested prompt body before the reviewer ran. Model: `gpt-6.1-sol`, medium, 8,192 output-token limit; calls serialized.

| Case | Prompt | Target blocking finding | Amendment respected | Other blocking findings | Trial time | Settled cost |
| --- | --- | --- | --- | --- | --- | --- |
| Original requests | Baseline | Missed | N/A | 3 | 4m10s | $0.274422 |
| Original requests | Candidate | Missed | N/A | 2 | 3m10s | $0.218055 |
| Explicit amendment | Candidate | None, as required | Yes | 1 | 2m56s | $0.214095 |
| Explicit amendment | Baseline | None, as required | Yes | 2 | 2m43s | $0.172925 |

The order above is the frozen execution order. Times include individual trial setup/teardown and are not a speed comparison. Each cell completed normally, used only a native reviewer, produced a valid structured report and left repository state unchanged. All used artifact commit `1a201988ad0709489a95282b9e523a26cb609d8f`, reconstructed deterministically from the saved patch.

## What the visible evidence shows

For ordinary single-line CSV with one header, the original request's “1-based source-file row number” requires the first two data rows to be 2 and 3. The implementation returns 1 and 2. The explicit amendment deliberately authorizes one-based data-record ordinals excluding the header, including a rule for embedded newlines.

Neither original-request review reports this discrepancy as a blocking finding or even an ambiguity observation. Their scratch tests still encode the shared interpretation:

- Baseline tool message `0dd7f2d7-9fd6-498a-9e66-7befed9029c8` uses `enumerate(rows, 1)` to construct expected row IDs.
- Candidate tool message `3e1317e7-9458-400b-b20b-1812b1be9cd5` expects `rowid=i+1` for a zero-based data-record index.

Both wrote new scratch verification, but new test code did not produce an independent interpretation of this requirement. These are visible tool actions, not an inspection of hidden reasoning. They do not establish why the model made the choice or how frequently it would do so.

## Other findings: independently checked

The [offline reproduction](review-contract-v1-reproduce.py) ran after all paid reviews, in the frozen image with the exact saved artifact mounted read-only and external networking disabled. It does not repair or regrade the benchmark.

| Finding | Reported by | Independent adjudication |
| --- | --- | --- |
| Valid CSV angle-bracket header rejected as markup | All four | Reproduced: `<label>,value` is rejected while the equivalent quoted header is accepted; actual HTML remains rejected. Clear CSV-acceptance defect. |
| Illegal hostname characters accepted | Original baseline | Reproduced with injected fetched bytes: `http://bad\|host/data.csv` passes validation and returns 200. This isolates validation; no external DNS behavior is claimed. |
| Malformed remote redirect produces 500 | Original baseline | Reproduced using a real loopback HTTP redirect with malformed `Location`. Remote retrieval failure escapes the controlled error boundary. |
| Huge finite decimals become strings; very long integer rejected | Original candidate | Both behaviors reproduced, including lexical order opposite numeric order. Numeric bounds are unstated; this is a qualified contract-coverage concern, not proof that unlimited precision or “Critical” severity is required. |
| BOM-less UTF-32 not detected | Amended baseline | Both byte orders reproduce automatic failure and explicit-charset success. Detection coverage is not enumerated; scope and severity remain qualified. |

All reported behavioral categories reproduced. That is distinct from endorsing every proposed repair, severity label or unbounded interpretation. Other findings are not substitutes for detecting the frozen target, and differences in their counts are not an accuracy ranking.

## Integrity and accounting

All frozen file hashes, prompt installation audits, reviewer-only provenance, repository-unchanged audits, completion records and structured reports validated. The 41 native usage token tuples reconcile exactly with the scoped proxy's 41 settled receipts and rounded per-request charges. There is no unattributed usage and no new unresolved receipt.

- Diagnostic cost: **$0.879497**.
- Current phase confirmed: **$34.841867**.
- Historical call-1193 hold retained: **$5.50**.
- Conservative exposure: **$40.341867** of the unchanged **$50** cap.
- Conservative remaining headroom: **$9.658133**; the **$5.50** per-request reservation still applies.

No paid retries, cap changes, ledger resets, hold releases, candidate repairs or frozen-input changes occurred. Unpaid task-discovery preparation failures and a zero-call prelaunch manifest-generation failure remain recorded separately. The original longitudinal benchmark scores remain **50/50 → 119/122 → 171/174** for both harnesses.

[Machine-readable results](review-contract-v1-results.json) include per-cell costs, token reconciliation, evidence hashes and independent reproduction output. Raw sessions and private run data remain outside source control.

## Next decision

Keep PR #753 open as an unproven intervention rather than treating it as the fix. A useful next experiment would require a separate, persisted interpretation of observable requirements before the reviewer sees the plan or implementation, then evaluate that procedure on additional cases. This diagnostic does not justify another task-specific prompt rule, changing benchmark expectations, or claiming that independent tests alone solved the problem. No further paid experiment has been started.
