const DEFAULT_TIMEZONE = "UTC"

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date(0))
    return true
  } catch {
    return false
  }
}

export function systemTimezone(): string {
  try {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
    return timezone && isValidTimezone(timezone) ? timezone : DEFAULT_TIMEZONE
  } catch {
    return DEFAULT_TIMEZONE
  }
}

export function normalizeTimezone(value: unknown, fallback = DEFAULT_TIMEZONE): string {
  const candidate = typeof value === "string" ? value.trim() : ""
  if (candidate && isValidTimezone(candidate)) return candidate
  return isValidTimezone(fallback) ? fallback : DEFAULT_TIMEZONE
}

export function dateStampInTimezone(
  date: Date | number = new Date(),
  timezone = DEFAULT_TIMEZONE
): string {
  const d = typeof date === "number" ? new Date(date) : date
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: normalizeTimezone(timezone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d)
  const get = (type: string) => parts.find((part) => part.type === type)?.value
  const year = get("year")
  const month = get("month")
  const day = get("day")
  if (!year || !month || !day) return d.toISOString().slice(0, 10)
  return `${year}-${month}-${day}`
}

export function formatDateTimeInTimezone(
  date: Date | number = new Date(),
  timezone = DEFAULT_TIMEZONE
): string {
  const d = typeof date === "number" ? new Date(date) : date
  const tz = normalizeTimezone(timezone)
  const local = new Intl.DateTimeFormat("sv-SE", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(d)
  const offset =
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "2-digit",
      hourCycle: "h23",
      timeZoneName: "shortOffset",
    })
      .formatToParts(d)
      .find((part) => part.type === "timeZoneName")?.value ?? ""
  return offset ? `${local} ${offset}` : local
}
