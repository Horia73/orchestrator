/**
 * Schema for the `application/vnd.ant.dev-preview` artifact — a live, embedded
 * "mini-browser" pointed at a managed project-run dev server that is reverse-
 * proxied through the live app at `/dev-preview/<run-id>/`.
 *
 * The agent emits one of these after starting a managed preview (see the
 * self-development doctrine). The body is small and deterministic: it carries
 * the run id, the reverse-proxy base path, the preview token, and optional
 * public/LAN URLs. It does NOT carry the rendered site — that streams live from
 * the dev server through the proxy, so HMR keeps the iframe current as the
 * agent edits the project.
 *
 * Intentionally permissive (not in STRICT_ARTIFACT_TYPES): the renderer parses
 * defensively and shows a fallback card on malformed content, matching the
 * other sandboxed renderers.
 */

export interface DevPreviewArtifact {
    /** Project-run id; matches `.orchestrator/project-runs/<runId>`. */
    runId: string
    /** Optional display title; falls back to the artifact title. */
    title?: string
    /** Reverse-proxy base path, e.g. `/dev-preview/<run-id>` (no trailing slash). */
    basePath: string
    /** Preview token that authorizes the `/dev-preview` proxy. */
    token: string
    /** Optional absolute public URL (with token) for "open in new tab". */
    publicUrl?: string
    /** Optional LAN URL (with token), e.g. http://192.168.x.x:3000/dev-preview/<run-id>/. */
    lanUrl?: string
    /** Optional status hint at emit time (e.g. "running"). */
    status?: string
}

export type ParseDevPreviewResult =
    | { ok: true; value: DevPreviewArtifact }
    | { ok: false; error: string }

const BASE_PATH_RE = /^\/dev-preview\/[A-Za-z0-9._-]{1,100}$/

export function parseDevPreviewArtifact(source: string): ParseDevPreviewResult {
    let raw: unknown
    try {
        raw = JSON.parse(source)
    } catch {
        return { ok: false, error: 'Content is not valid JSON.' }
    }
    if (!raw || typeof raw !== 'object') {
        return { ok: false, error: 'Content must be a JSON object.' }
    }
    const obj = raw as Record<string, unknown>

    const runId = typeof obj.runId === 'string' ? obj.runId.trim() : ''
    if (!runId) return { ok: false, error: 'Missing "runId".' }

    const basePath = typeof obj.basePath === 'string' ? obj.basePath.trim().replace(/\/+$/, '') : ''
    if (!BASE_PATH_RE.test(basePath)) {
        return { ok: false, error: 'Missing or invalid "basePath" (expected "/dev-preview/<run-id>").' }
    }

    const token = typeof obj.token === 'string' ? obj.token.trim() : ''
    if (!token) return { ok: false, error: 'Missing "token".' }

    const title = typeof obj.title === 'string' && obj.title.trim() ? obj.title.trim() : undefined
    const publicUrl = typeof obj.publicUrl === 'string' && obj.publicUrl.trim() ? obj.publicUrl.trim() : undefined
    const lanUrl = typeof obj.lanUrl === 'string' && obj.lanUrl.trim() ? obj.lanUrl.trim() : undefined
    const status = typeof obj.status === 'string' && obj.status.trim() ? obj.status.trim() : undefined

    return { ok: true, value: { runId, title, basePath, token, publicUrl, lanUrl, status } }
}

/**
 * Same-origin iframe URL for the preview. The token is carried as a query param;
 * the `/dev-preview` proxy converts it to an HttpOnly cookie on first load and
 * 302s to a clean URL, so subsequent in-iframe navigations stay authorized.
 */
export function devPreviewLocalSrc(value: Pick<DevPreviewArtifact, 'basePath' | 'token'>): string {
    return `${value.basePath}/?preview_token=${encodeURIComponent(value.token)}`
}
