/**
 * Copy for the `host` sandbox runtime, where there is no sandbox at all:
 * agents run directly on this machine as the Ficus process user, and the
 * in-memory "sandbox" record the server keeps is not something a user can
 * start or stop. Every surface gates on the server-driven
 * `SandboxStatus.runtime` field — never on a client guess.
 */

/**
 * One-line explanation used where controls/settings would otherwise appear.
 *
 * Deliberately cites no repository path: this is read by people using Ficus, who
 * have no checkout to open `docs/…` in.
 */
export const HOST_RUNTIME_NOTE =
  'Agents run directly on this machine as the Ficus process user. There is no sandbox to start or stop; see the host runtime documentation.'
