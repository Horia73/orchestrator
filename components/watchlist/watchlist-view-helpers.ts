export function formatPrice(
  value: number | null | undefined,
  currency?: string | null
) {
  if (value == null || !Number.isFinite(value)) return "—"
  const abs = Math.abs(value)
  const digits = abs >= 100 ? 2 : abs >= 1 ? 3 : 6
  try {
    if (currency && /^[A-Z]{3}$/.test(currency)) {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency,
        maximumFractionDigits: digits,
      }).format(value)
    }
  } catch {
    // Fall through to plain numeric formatting for unusual currency codes.
  }
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: digits,
  }).format(value)
}

export function formatCompact(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "—"
  return new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value)
}

export function formatSigned(value: number | null | undefined, suffix = "") {
  if (value == null || !Number.isFinite(value)) return "—"
  const sign = value > 0 ? "+" : ""
  return `${sign}${value.toFixed(2)}${suffix}`
}

export function formatTime(value: number | null | undefined) {
  if (!value) return "Never"
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(value)
}

export async function responseError(res: Response): Promise<string> {
  try {
    const data = await res.json()
    return typeof data.error === "string"
      ? data.error
      : `Request failed (${res.status})`
  } catch {
    return `Request failed (${res.status})`
  }
}

export function changeTone(value: number | null | undefined) {
  if (value == null || value === 0) return "text-foreground/55"
  return value > 0
    ? "text-emerald-600 dark:text-emerald-400"
    : "text-[#802020] dark:text-red-300"
}
