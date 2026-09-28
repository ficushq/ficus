### Managing Slot Coordination

When a shared resource needs cooperative capacity admission, register a squad pool with `ficus slot register <key> --capacity <n> --timeout <duration> --squad <id>`. Choose a positive capacity that matches the real safe concurrency and a bounded timeout long enough for normal work. Use `ficus slot update` when either changes and unregister an empty pool with `ficus slot unregister`.

Add one short, actionable squad-context rule naming the protected resource and pool. Remove that rule when the pool is unregistered. Use approval-free platform slot admission instead of approval messages, manual tokens, nonces, or lane-claim ledgers.
