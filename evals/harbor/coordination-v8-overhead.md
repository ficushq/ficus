# V8 offline planning and context audit

Ficus's four architect executions cost $1.0525272 versus Pi's one $0.130052
architect assignment. The saved tools show substantive per-package design and
interface coordination, not four identical plans. They also reveal concrete
avoidable overhead. No new model calls or candidate changes were made.

| Ficus design           | Calls | Native cost | Output tokens | Returned tool text, characters |
| ---------------------- | ----: | ----------: | ------------: | -----------------------------: |
| Core parser/validation |     8 |  $0.2644236 |        14,968 |                         22,907 |
| CLI                    |    14 |  $0.2497579 |         8,113 |                         83,933 |
| Evaluation             |    10 |  $0.2755473 |         7,972 |                         90,022 |
| Integration            |     9 |  $0.2627984 |         7,994 |                        142,929 |

The core architect produced an oversized plan-write tool call. Its response hit
the frozen 8,192-output-token limit; the runtime correctly refused to execute the
potentially truncated arguments. The agent issued a smaller replacement. The
length-stopped response cost **$0.0856087** and produced no executed write. This
is confirmed effort on a rejected tool invocation, not an estimate of how much a
future intervention will save. Raising the output limit would change the frozen
budget assumptions and is not proposed here.

Successful plan-writing tool arguments total roughly 97,000 characters across the
four architects, including CLI's later contract addendum. The plans establish
real API signatures, error precedence, file ownership and integration checks.
However, they also repeat the original source, workflow boundaries and detailed
step-by-step test instructions. Integration alone reads 142,929 characters of
returned tool text while inspecting prior plans, flow histories, actual APIs and
implementation. Character counts are decoded text payload sizes, not token
counts; some commands combine several categories. They cannot be converted into
an additive savings estimate.

The evaluation architect initially used an incorrect CLI architect UUID for an
inbox message, then queried squad members and corrected it. That is a concrete
routing detour, not evidence that another coordinator is needed.

Across planning receipts, cache writes account for 213,320 tokens and cache reads
for 1,285,112; output accounts for 39,047. At the already-frozen proxy rates these
are approximately $0.5333, $0.1285 and $0.3905 respectively, with other input and
rounding making up the small remainder. Cache writes include new system/context,
requests and tool results; receipts do not isolate which portion is duplicated
setup. A causal claim that all repeated context is waste would be unsupported.

## Targeted recommendations

1. Keep original requests intact and accessible. Prefer targeted reads of flow
   status, current attempt and review evidence over repeatedly dumping the whole
   flow, plans and implementation in one tool result.
2. Keep plans focused on novel decisions, contracts, risks, ownership and
   validation. Reference stable source requirements and approved shared contracts;
   avoid copying them into every plan or spelling out every implementation step.
3. Split large file writes into complete bounded operations before reaching the
   model output limit. Preserve the runtime's refusal of truncated tool arguments.
4. Reuse verified recipient IDs from the assignment context or query the roster;
   do not reconstruct UUIDs.
5. Study whether incremental changes can reuse an existing approved design while
   retaining independent review. The current required workflow creates a fresh
   design stage for every stream, including integration; changing this is a
   workflow experiment, not a harmless optimization.

No broad production prompt change follows from one task. The next sustained-work
study retains the current role prompts, output limit and review gates, so its
first result establishes a baseline for sequential requests and persistent state.
A future concise-planning intervention should be frozen as a separate condition.

Reproduce with `planning_overhead_audit.py <private-agent-directory> <output>`.
The [JSON audit](coordination-v8-overhead.json) contains explicit tool-message
references, nonexclusive activity flags, payload sizes and usage attribution.
No hidden reasoning is inspected or published. Original v8 artifacts and the
unresolved $5.50 receipt hold remain unchanged.
