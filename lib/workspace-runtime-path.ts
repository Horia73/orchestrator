const WORKSPACE_RUNTIME_PATH_RE =
  /(?:^|\/)\.orchestrator\/(?:profiles\/[^/]+\/)?workspace(?:\/|$)/

/**
 * Convert an absolute Orchestrator runtime path back to the profile-relative
 * workspace path that is stable across hosts and installations.
 *
 * Both layouts exist in persisted chat history:
 *   - <root>/.orchestrator/workspace/... (legacy/admin)
 *   - <root>/.orchestrator/profiles/<id>/workspace/... (profile-scoped)
 */
export function workspaceRelativePathFromRuntimePath(
  value: string
): string | null {
  const portable = value.replace(/\\/g, "/")
  const match = WORKSPACE_RUNTIME_PATH_RE.exec(portable)
  if (!match) return null
  return portable.slice((match.index ?? 0) + match[0].length)
}

export function isWorkspaceRuntimePath(value: string): boolean {
  return workspaceRelativePathFromRuntimePath(value) !== null
}
