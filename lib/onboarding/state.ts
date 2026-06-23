import fs from 'fs'
import path from 'path'

import { WORKSPACE_DIR } from '@/lib/runtime-paths'

/**
 * First-run onboarding state for the instance.
 *
 * This is the DETERMINISTIC wizard's own completion flag, deliberately separate
 * from BOOT.md (the agent's CONVERSATIONAL onboarding, which the orchestrator
 * deletes when it finishes its staged interview). The wizard runs first
 * (profile → models → keys → remote access → integrations), then hands off into
 * the boot conversation; the two must not gate each other.
 *
 * Stored instance-global under the admin workspace (not per-profile) — onboarding
 * sets up the instance, not a member.
 */
export interface OnboardingState {
  version: 1
  /** Epoch ms the user finished the wizard, or null while incomplete. */
  completedAt: number | null
  /** Epoch ms the wizard was first opened (locks "in progress" against grandfather inference). */
  startedAt: number | null
  /** Last step id the user reached, for resume. */
  step: string | null
  /** Optional steps the user explicitly skipped (e.g. "remote-access"). */
  skipped: string[]
  /** Why completion was recorded ("wizard" | "grandfathered" | "skipped"). */
  completedReason: string | null
  /** Context captured during the wizard, used to seed the live boot message. */
  context: OnboardingContext | null
}

export interface OnboardingContext {
  userName?: string
  /** Integration ids the user said they want to set up now. */
  integrations?: string[]
  /** Whether HTTPS / remote access was configured. */
  httpsConfigured?: boolean
  /** The provider:model the user assigned to the orchestrator agent. */
  orchestratorModel?: string
}

const STATE_FILE = path.join(WORKSPACE_DIR, '.onboarding.json')
const WORKSPACE_INIT_MARKER = path.join(WORKSPACE_DIR, '.workspace-initialized')
const BOOT_FILE = path.join(WORKSPACE_DIR, 'BOOT.md')

function defaultState(): OnboardingState {
  return {
    version: 1,
    completedAt: null,
    startedAt: null,
    step: null,
    skipped: [],
    completedReason: null,
    context: null,
  }
}

export function readOnboardingState(): OnboardingState {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8')
    const parsed = JSON.parse(raw) as Partial<OnboardingState>
    return { ...defaultState(), ...parsed, version: 1 }
  } catch {
    return defaultState()
  }
}

export function writeOnboardingState(patch: Partial<OnboardingState>): OnboardingState {
  const next: OnboardingState = { ...readOnboardingState(), ...patch, version: 1 }
  try {
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true })
    fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2), { mode: 0o600 })
  } catch {
    // Best-effort: a read-only FS shouldn't hard-crash the gate. The grandfather
    // inference below keeps an established instance out of the wizard regardless.
  }
  return next
}

function fileExists(p: string): boolean {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

/**
 * Whether the instance is an already-established install that predates the
 * onboarding flag, so we must NOT drag it through the wizard on upgrade.
 *
 * Signal: the workspace was initialized at least once AND the conversational
 * boot script is gone (the agent consumed it, or the install predates BOOT.md).
 * A genuinely fresh install has BOOT.md present (or no marker yet), so this is
 * false and the wizard shows.
 */
export function instanceLooksEstablished(): boolean {
  return fileExists(WORKSPACE_INIT_MARKER) && !fileExists(BOOT_FILE)
}

/**
 * The single source of truth the server-side gate consults. Read-only and cheap
 * (a JSON read + at most two stat calls); safe to call on every request.
 */
export function isOnboardingComplete(): boolean {
  // Testing/demo override: force the wizard back on regardless of stored state.
  if (process.env.ORCHESTRATOR_FORCE_ONBOARDING === "1") return false
  const state = readOnboardingState()
  if (state.completedAt != null) return true
  // An explicitly-started-but-unfinished wizard stays in progress.
  if (state.startedAt != null) return false
  // No flag yet: grandfather established installs, show the wizard only on fresh ones.
  return instanceLooksEstablished()
}

export function markOnboardingStarted(): OnboardingState {
  const state = readOnboardingState()
  if (state.startedAt != null || state.completedAt != null) return state
  return writeOnboardingState({ startedAt: Date.now() })
}

export function markOnboardingComplete(
  reason = 'wizard',
  context?: OnboardingContext | null,
): OnboardingState {
  const patch: Partial<OnboardingState> = {
    completedAt: Date.now(),
    completedReason: reason,
  }
  if (context !== undefined) patch.context = context
  return writeOnboardingState(patch)
}
