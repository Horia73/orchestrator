import path from 'path'

/**
 * Keep every project/self-development helper on the app-owned state root even
 * when the shell cwd is the mounted source checkout or an agent workspace.
 */
export function resolveProjectRunsRoot(fallbackProjectDir = process.cwd()) {
  const explicit = process.env.ORCHESTRATOR_PROJECT_RUNS_DIR?.trim()
  if (explicit) return path.resolve(fallbackProjectDir, explicit)

  const stateDir = process.env.ORCHESTRATOR_STATE_DIR?.trim()
  if (stateDir) return path.join(path.resolve(fallbackProjectDir, stateDir), 'project-runs')

  const appDir = process.env.ORCHESTRATOR_APP_DIR?.trim()
  if (appDir) return path.join(path.resolve(fallbackProjectDir, appDir), '.orchestrator', 'project-runs')

  return path.join(fallbackProjectDir, '.orchestrator', 'project-runs')
}
