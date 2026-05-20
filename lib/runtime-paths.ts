import path from 'path';

/** Project root for this orchestrator instance. */
export const PROJECT_DIR = /* turbopackIgnore: true */ process.cwd();

/** Application state lives under the project. */
export const ORCHESTRATOR_STATE_DIR = path.join(/* turbopackIgnore: true */ PROJECT_DIR, '.orchestrator');

/**
 * Runtime workspace for agents. CLI agents start here, shell tools run here,
 * and filesystem tools expose this directory as "/".
 */
export const WORKSPACE_DIR = path.join(/* turbopackIgnore: true */ ORCHESTRATOR_STATE_DIR, 'workspace');
export const PRIVATE_STATE_DIR = path.join(/* turbopackIgnore: true */ ORCHESTRATOR_STATE_DIR, 'private');

export const WORKSPACE_ENV_PATH = path.join(/* turbopackIgnore: true */ WORKSPACE_DIR, '.env.local');
export const UPLOADS_DIR = path.join(/* turbopackIgnore: true */ ORCHESTRATOR_STATE_DIR, 'uploads');
export const AGENT_WORKSPACE_DIR = WORKSPACE_DIR;
export const ARTIFACTS_DIR = path.join(/* turbopackIgnore: true */ WORKSPACE_DIR, 'artifacts');
