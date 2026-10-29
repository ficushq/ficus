# Requirements-first reviewer diagnostic

The extra requirements-only stage **did not detect the original row-number defect**. Both the fresh one-pass review and the staged review missed it; both respected the explicit amendment permitting header-excluding data-record ordinals. The requirements-only session itself called header counting ambiguous before seeing product files. This weakens the explanation that copying the architect's interpretation is necessary for this particular miss. It does not establish the cause of the earlier full-squad failure.

All six native sessions completed without retries, candidate repairs, timeouts or new missing receipts. Total cost was **$1.217251**, across **56** receipted calls. No original benchmark score changes. The extra stage is not supported as a production fix by this result; PR753 remains a separate, unproven prompt intervention.

## Protocol and validity

Protocol [requirements-first-v1-plan.json](requirements-first-v1-plan.json) and [readiness manifest](requirements-first-v1-ready.json) were committed at `7fe6ea44` before paid inference. The matched procedure uses the unchanged longitudinal-v1 Ficus increment-2 artifact, patch SHA256 `7e8d52b0d88e007fae02c66e30d38cc59245dc5bd01c2267a1e1921d6c9c8fcc`, reconstructed at `1a201988ad0709489a95282b9e523a26cb609d8f` from the pinned empty base. Implementation, design, tests and repository notes were preserved.

All sessions used the same pre-PR753 reviewer YAML, common frozen runtime, `gpt-6.1-sol`, medium reasoning and 8192-token output limit. Thus this tests a procedure change, not that prompt addition or their combination. Order: original one-pass, original expectations, original staged review, amended expectations, amended staged review, amended one-pass. Each is a fresh native reviewer session, with model calls serialized.

The expectations stages began with an empty product tree, clean status and only the pinned empty base in all-ref history. No product implementation, design, tests or patch was uploaded. Their visible tools read the assigned work stream/inbox, checked the empty repository, wrote and structurally validated the expectation JSON, then completed. No product-file reads were observed. This is product isolation; the native Ficus runtime and installed dependencies remained available.

The staged reviewer received the exact unedited record automatically after structural validation. Its **first tool call** read that record in both cases: messages `c8f4fafa-a750-44e8-8470-5b077f148fcd` and `a625ff01-cafa-4b0c-ba97-345e673f2add`. Input, original output and post-review bytes match. The original record hash is `64089d7ad5493a3d4dad72b344a4e48deb4b9ad2924f94ad07b688250c2b23d4`; the amended record hash is `dbc29b6b0d2a29292699f99d9c835a01b5b64d6006c939e9cec2f45f555efa25`.

Every session used only native reviewer execution and completed its Solo work stream. Prompt sync audits passed, all repository states remained unchanged, structured outputs validated, and all processes stopped. There was no semantic selection of expectation records, feedback, hint, repair or paid retry. Validation was read-only after completion.

## Target outcome

The frozen original criterion is the first data record's **source-file row number 2**, following the header on line 1. The saved implementation returns 1. The amendment explicitly replaces that rule with the stored data-record ordinal, excluding the header and counting multiline records once. The amended behavior is not a new upstream benchmark score.

| Condition | Requirements-only interpretation | Final review target result | Other blocking findings reported |
| --- | --- | --- | --- |
| Original, one-pass | Not applicable | Missed; no target ambiguity observation | CSV header, malformed redirect, unknown-route OPTIONS |
| Original, staged | Ambiguous; permits header-excluding numbering | Missed; treats numbering as a nonblocking implementation choice | CSV header, malformed redirect |
| Amended, one-pass | Not applicable | Correctly no blocking target finding | CSV header |
| Amended, staged | Correct; explicit amendment governs | Correctly no blocking target finding | CSV header, malformed redirect |

The original expectations record says: “A plausible interpretation numbers data rows starting at 1” and “whether the header counts is not explicit.” It separately lists header and multiline counting as ambiguous. Classification is **ambiguous**, with an offered interpretation that fails the frozen ordinary-single-line criterion, rather than omission or correct detection. The staged review then explicitly treats “data-record-based rowid numbering” as a documented choice rather than a new mandatory requirement.

The amended record gives explicit examples with the first stored record numbered 1, including multiline CSV and retained identity through sorting/pagination. Both amended reviews accepted that behavior without a blocking rowid finding. All four reviews requested changes for other issues; a generic changes-requested verdict is not target detection.

These visible outputs show that a permissive interpretation arose without product exposure and survived the handoff. They do not reveal hidden reasoning, prove that the staged record caused the final judgment, or establish that all wording ambiguity claims are valid. The frozen original score remains unchanged.

## Other findings, independently checked

[Offline reproduction](requirements-first-v1-reproduce.py) ran in the frozen image with the exact saved artifact mounted read-only, networking disabled except container loopback, and no inference. Its output and script hashes are in the [machine-readable results](requirements-first-v1-results.json).

- **CSV header rejection:** all four reviews reported this. An unquoted `<name>` CSV header returns 400 while the equivalent quoted header succeeds; genuine HTML still returns 400. This reproduces an acceptance defect for structurally valid CSV.
- **Malformed redirects:** both original reviews and the amended staged review reported a malformed IPv6 redirect returning 500 instead of a controlled fetch failure. The original staged review also reported a redirected invalid hostname label causing a Unicode error; both variants were independently reproduced through real loopback HTTP responses.
- **Unknown-route OPTIONS:** only the original one-pass review reported this. `OPTIONS /unknown` returns 200 while `GET /unknown` returns 404. The behavior is reproduced, but its blocking status is qualified: unconditional unknown-route wording conflicts with a broad preflight handler, while the interface describes GET routes and requires CORS. This is a method-scope concern, not an unquestioned mandatory fix.

The reviewers' “Critical”/“Important” labels are not independently established severity ratings. Counts of other findings are not a calibrated quality score. The common target mismatch was also reproduced offline: IDs `[1, 2]` and sorted IDs `[2, 1]`, versus original expected `[2, 3]` and amended expected `[1, 2]`.

## Cost and timing

| Native session | Calls | Settled USD | Trial seconds |
| --- | ---: | ---: | ---: |
| Original one-pass | 10 | 0.265358 | 258.52 |
| Original expectations | 6 | 0.118989 | 152.55 |
| Original staged review | 11 | 0.245492 | 219.02 |
| Amended expectations | 7 | 0.121366 | 156.91 |
| Amended staged review | 12 | 0.254904 | 230.38 |
| Amended one-pass | 10 | 0.211142 | 187.67 |

Including its requirements stage, the original staged procedure cost **$0.364481** versus **$0.265358** one-pass, and took **371.57** versus **258.52** summed sequential trial seconds. The amended staged procedure cost **$0.376270** versus **$0.211142**, and took **387.29** versus **187.67** seconds. Trial timing includes setup; the two-stage procedure starts two environments. These are serial samples, not parallel-speedup or human-time-saved measurements.

All 56 native usage records match the proxy token multiset; response IDs are unique, per-call charges reconstruct exactly, and unattributed cost is zero. The phase now has **$36.059118 confirmed**, plus the unchanged historical **$5.50 call-1193 hold**, for **$41.559118 conservative exposure** against the **$50 cap**. Conservative remaining headroom is **$8.440882**; the unchanged $5.50 next-request reservation still applies. No ledger reset or hold release occurred.

## Decision and limits

Do not add an extra production reviewer stage on the strength of this diagnostic. The unchanged baseline one-pass review already found other issues, and the extra procedure did not improve the selected target at greater total cost. PR753 is not tested in combination here and remains unproven by its earlier matched prompt diagnostic.

This is one selected known artifact and one sample per cell, following several inspections of the same failure. It is not held-out accuracy, a full-squad comparison, a general harness ranking or strong causal evidence. Further prompt tuning against this one row-number case risks overfitting. The useful next evaluation would declare a broader, independently adjudicated set of requirement-interpretation cases before running candidates, including clear requirements and genuine ambiguities. No such paid run has been started.
