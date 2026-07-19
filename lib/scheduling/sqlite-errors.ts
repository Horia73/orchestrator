const SQLITE_CONTENTION_MESSAGE =
  /\b(?:database(?: table| schema)? is locked|database is busy)\b/i

/**
 * SQLite writer contention is transient runtime pressure, not a broken
 * schedule. better-sqlite3 exposes the primary/extended result through
 * `code`, but keep the message fallback for wrapped or serialized errors.
 */
export function isTransientSqliteContentionError(error: unknown): boolean {
  if (error && typeof error === "object") {
    const code = (error as { code?: unknown }).code
    if (
      typeof code === "string" &&
      (code === "SQLITE_BUSY" ||
        code.startsWith("SQLITE_BUSY_") ||
        code === "SQLITE_LOCKED" ||
        code.startsWith("SQLITE_LOCKED_"))
    ) {
      return true
    }
  }

  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : ""
  return SQLITE_CONTENTION_MESSAGE.test(message)
}
