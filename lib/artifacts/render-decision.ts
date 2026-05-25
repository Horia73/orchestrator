import type { ArtifactDisplay, ArtifactRow } from './schema'

/**
 * Decide where an artifact should render: inline (in the chat bubble), in
 * the side panel, or from a dedicated full-screen route.
 *
 * Decision order:
 *   1. Explicit `display` attr on the artifact wins. The model chooses.
 *   2. Missing `display` falls back to inline for compatibility with older
 *      saved messages or malformed model output. New prompts require the
 *      model to set `display`.
 *
 * The user can always click "↗ Expand" on an inline artifact to move it to
 * the panel.
 */
type RenderTarget = 'inline' | 'panel' | 'fullscreen'

function decideRenderTarget(args: {
    display?: ArtifactDisplay | null
}): RenderTarget {
    if (args.display === 'inline' || args.display === 'panel' || args.display === 'fullscreen') return args.display
    return 'inline'
}

/** Same decision but takes a persisted row directly (Db.display → attr). */
export function decideRowRenderTarget(row: ArtifactRow): RenderTarget {
    return decideRenderTarget({ display: row.display })
}
