/**
 * Dot notation names non-empty JSON object keys; dots are separators, not escapes.
 * Quotes, whitespace, Unicode and SQL-looking text are valid literal key data.
 * NUL cannot be represented by PostgreSQL text parameters.
 */
export function isValidMetadataPath(path: string): boolean {
  return !path.includes('\0') && path.split('.').every((part) => part.length > 0)
}
