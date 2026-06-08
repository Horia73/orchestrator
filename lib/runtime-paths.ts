import path from 'path';
import {
  getActiveProfileId,
  isAdminProfileId,
  normalizeProfileId,
} from '@/lib/profiles/context';

/** Project root for this orchestrator instance. */
export const PROJECT_DIR = /* turbopackIgnore: true */ process.cwd();

/** Application state lives under the project. */
export const ORCHESTRATOR_STATE_DIR = resolveStateDir();

/**
 * Runtime workspace for agents. CLI agents start here, shell tools run here,
 * and filesystem tools expose this directory as "/".
 */
export const WORKSPACE_DIR = path.join(/* turbopackIgnore: true */ ORCHESTRATOR_STATE_DIR, 'workspace');
export const PRIVATE_STATE_DIR = path.join(/* turbopackIgnore: true */ ORCHESTRATOR_STATE_DIR, 'private');

export const WORKSPACE_ENV_PATH = path.join(/* turbopackIgnore: true */ WORKSPACE_DIR, '.env.local');
export const UPLOADS_DIR = path.join(/* turbopackIgnore: true */ ORCHESTRATOR_STATE_DIR, 'uploads');
/** Cache for derived preview artifacts (e.g. PPTX→PDF conversions). Bounded,
 *  evictable, and deliberately under the state dir — never /tmp, which fills
 *  the host eMMC and breaks unrelated subsystems. */
export const PREVIEW_CACHE_DIR = path.join(/* turbopackIgnore: true */ ORCHESTRATOR_STATE_DIR, 'preview-cache');
export const AGENT_WORKSPACE_DIR = WORKSPACE_DIR;
export const ARTIFACTS_DIR = path.join(/* turbopackIgnore: true */ WORKSPACE_DIR, 'artifacts');

export interface RuntimePathSet {
  profileId: string;
  stateDir: string;
  workspaceDir: string;
  privateStateDir: string;
  workspaceEnvPath: string;
  uploadsDir: string;
  previewCacheDir: string;
  agentWorkspaceDir: string;
  artifactsDir: string;
}

export function profileStateDir(profileId = getActiveProfileId()): string {
  const clean = normalizeProfileId(profileId);
  if (isAdminProfileId(clean)) return ORCHESTRATOR_STATE_DIR;
  return path.join(
    /* turbopackIgnore: true */ ORCHESTRATOR_STATE_DIR,
    'profiles',
    clean,
  );
}

export function runtimePathsForProfile(
  profileId = getActiveProfileId(),
): RuntimePathSet {
  const clean = normalizeProfileId(profileId);
  const stateDir = profileStateDir(clean);
  const workspaceDir = path.join(/* turbopackIgnore: true */ stateDir, 'workspace');
  const privateStateDir = path.join(/* turbopackIgnore: true */ stateDir, 'private');
  return {
    profileId: clean,
    stateDir,
    workspaceDir,
    privateStateDir,
    workspaceEnvPath: path.join(/* turbopackIgnore: true */ workspaceDir, '.env.local'),
    uploadsDir: path.join(/* turbopackIgnore: true */ stateDir, 'uploads'),
    previewCacheDir: path.join(/* turbopackIgnore: true */ stateDir, 'preview-cache'),
    agentWorkspaceDir: workspaceDir,
    artifactsDir: path.join(/* turbopackIgnore: true */ workspaceDir, 'artifacts'),
  };
}

export function activeRuntimePaths(): RuntimePathSet {
  return runtimePathsForProfile(getActiveProfileId());
}

function resolveStateDir(): string {
  const configured = process.env.ORCHESTRATOR_STATE_DIR?.trim();
  if (configured) return path.resolve(configured);
  return path.join(/* turbopackIgnore: true */ PROJECT_DIR, '.orchestrator');
}
