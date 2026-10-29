// Raw SQL/migration/pooler suites bypass db/index. Opt into the same readiness
// boundary before capturing DSNs or deciding whether an optional pooler exists.
import { ensureTestDatabase } from '../db/test-readiness'
await ensureTestDatabase()
