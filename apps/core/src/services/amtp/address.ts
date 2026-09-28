// The canonicalizer + amtp:// parse/format live in @ficus/shared (the CLI cannot import apps/core).
// Re-exported here so existing apps/core importers keep their local import path.
export { parseAmtpAddress, formatAmtpAddress } from '@ficus/shared'
