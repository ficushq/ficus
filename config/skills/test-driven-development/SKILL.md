---
name: test-driven-development
description: Use when implementing any feature or bugfix, before writing implementation code
---

# Test-Driven Development

Write the test first, run it and watch it fail for the reason you expect, then
write the smallest change that makes it pass, and refactor while it stays green.
A test you never saw fail does not prove it tests the behavior you changed.

## In a Ficus work stream

- **Red evidence belongs in the handoff.** Record the failing run (the command and
  the failure line) and the passing run after the change. Reviewers read this as
  proof that the test exercises the fix; "tests pass" alone is not.
- **Test behavior, not mocks.** Prefer real code paths and the repository's own
  test helpers. Mock only what is slow, external or nondeterministic, and never
  assert on the mock itself.
- **Run focused tests.** Run the files that cover your change, not the whole
  suite, in the shared squad box. Claim the slot pool your squad names for
  database-backed or memory-heavy tests before starting them, and tear down any
  test database you started before you release the claim.
- **Do not weaken a test to finish.** If an existing test fails, decide whether
  your change broke it, whether it pins behavior the requirements change, or
  whether it is unrelated. Fix the first, update the second and say why in the
  handoff, and report the third rather than editing it to pass.
- **Exceptions.** Generated code, configuration-only changes and throwaway
  prototypes may skip test-first. When a requirement makes test-first
  impractical, say so in the handoff rather than skipping silently.
