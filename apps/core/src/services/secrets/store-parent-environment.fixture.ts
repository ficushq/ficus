import { ContentSafetyRegistry } from '../security/content-safety-registry'
import { SecretStore } from './store'

const key = process.env.FICUS_TEST_PARENT_SENTINEL_KEY
if (!key) throw new Error('missing_generated_parent_sentinel_key')
const value = process.env[key]
if (!value) throw new Error('missing_generated_parent_sentinel_value')

const store = new SecretStore()
await store.initialize()
const registry = new ContentSafetyRegistry(store)
// The hermetic property is that THIS CHILD'S environment value must not enter
// the store, so assert it BY VALUE.
//
// `store.get(key) !== undefined` and "list() contains key" were proxies, and
// they are equivalent only when nothing else could have written that key. The
// store is backed by DATABASE_URL, which the parent passes straight through —
// so in the main sweep this child reads the SHARED test database, where other
// suites (store, groups, secrets-settings-rbac, onboarding) legitimately
// create a GITHUB_TOKEN secret. Either proxy then reports someone else's row
// as this child's environment leaking, which is the intermittent
// `expected 0, received 1` of catalogue entry 10
// (docs/history/design/ci-stability-and-flake-eradication.md).
//
// Not a weaker assertion: a real leak puts THIS value in the store and still
// fails. Under the sterile runner, where the database is isolated and key
// presence is meaningful, the stricter key-absence check is kept as well.
const isolated = process.env.SECRET_BOUNDARY_REQUIRE_ISOLATED_DB === '1'
const visible = store.get(key) === value
const migrated = isolated && (await store.list()).some((entry) => entry.key === key && entry.isSet)
const bound = registry.redact(value) !== value
registry.dispose()
store.stopPeriodicRefresh()

if (visible || migrated || bound) console.error(JSON.stringify({ visible, migrated, bound, isolated }))
process.exit(visible || migrated || bound ? 1 : 0)
