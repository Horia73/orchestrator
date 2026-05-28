const PREVIEW_BASE_PATH_RE = /^\/dev-preview\/[^/?#]+/
const PREVIEW_BASE_PATH_GLOBAL = "__orchestratorPreviewBasePathPatched"

type QueryValue = string | number | boolean | null | undefined

export function appPath(value: string): string {
  const basePath = currentPreviewBasePath()
  if (!basePath || !shouldPrefixAppPath(value, basePath)) return value
  return `${basePath}${value}`
}

export function appApiPath(
  pathname: string,
  query?: Record<string, QueryValue> | URLSearchParams
): string {
  const params =
    query instanceof URLSearchParams
      ? new URLSearchParams(query)
      : new URLSearchParams()

  if (query && !(query instanceof URLSearchParams)) {
    for (const [key, value] of Object.entries(query)) {
      if (value == null) continue
      params.set(key, String(value))
    }
  }

  const search = params.toString()
  return appPath(`${pathname}${search ? `?${search}` : ""}`)
}

export function currentPreviewBasePath(): string {
  const browserBasePath = browserPreviewBasePath()
  if (browserBasePath) return browserBasePath
  return normalizePreviewBasePath(
    typeof process === "undefined"
      ? undefined
      : process.env.ORCHESTRATOR_PREVIEW_BASE_PATH
  )
}

export function prefixWithPreviewBasePath(value: string, basePath: string): string {
  const normalized = normalizePreviewBasePath(basePath)
  if (!normalized || !shouldPrefixAppPath(value, normalized)) return value
  return `${normalized}${value}`
}

function browserPreviewBasePath(): string {
  if (typeof window === "undefined") return ""

  const globalValue = (window as typeof window & Record<string, unknown>)[
    PREVIEW_BASE_PATH_GLOBAL
  ]
  const fromGlobal =
    typeof globalValue === "string" ? normalizePreviewBasePath(globalValue) : ""
  if (fromGlobal) return fromGlobal

  return normalizePreviewBasePath(
    window.location.pathname.match(PREVIEW_BASE_PATH_RE)?.[0]
  )
}

function normalizePreviewBasePath(value: string | undefined): string {
  const clean = value?.trim().replace(/\/+$/, "") ?? ""
  return PREVIEW_BASE_PATH_RE.test(clean) ? clean : ""
}

function shouldPrefixAppPath(value: string, basePath: string): boolean {
  return (
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !PREVIEW_BASE_PATH_RE.test(value) &&
    value !== basePath &&
    !value.startsWith(`${basePath}/`) &&
    !value.startsWith(`${basePath}?`) &&
    !value.startsWith(`${basePath}#`)
  )
}
