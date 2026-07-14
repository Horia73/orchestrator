import fs from 'fs'
import path from 'path'

import {
  shouldSyncWorkspaceEnvToProcess,
  writableWorkspaceEnvPath,
} from '@/lib/profiles/env-sharing'

/**
 * Env keys the onboarding wizard is allowed to write. Kept to provider API keys
 * + the handful of optional service keys the wizard surfaces, so a stray request
 * can't write arbitrary secrets.
 */
export const ONBOARDING_ENV_ALLOWLIST = new Set<string>([
  // Model providers
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENROUTER_API_KEY',
  'LM_STUDIO_BASE_URL',
  'LM_STUDIO_API_KEY',
  'LM_STUDIO_AUTO_UNLOAD',
  // Optional services
  'GOOGLE_MAPS_API_KEY',
  'GOOGLE_MAPS_MAP_ID',
  'TWELVE_DATA_API_KEY',
  'HOME_ASSISTANT_URL',
  'HOME_ASSISTANT_TOKEN',
])

function formatEnvValue(value: string): string {
  // Quote when the value has whitespace/# so the .env parser keeps it intact.
  if (/[\s#"']/.test(value)) return `"${value.replace(/"/g, '\\"')}"`
  return value
}

/**
 * Patch a single key in the workspace `.env.local` and update `process.env`
 * live so provider readiness recomputes without a restart. Mirrors the
 * read/modify/atomic-write pattern used by the integration config routes.
 */
export function setOnboardingEnvValue(key: string, value: string): void {
  if (!ONBOARDING_ENV_ALLOWLIST.has(key)) {
    throw new Error(`Key not allowed: ${key}`)
  }

  const envPath = writableWorkspaceEnvPath()
  fs.mkdirSync(path.dirname(envPath), { recursive: true })
  const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : ''

  const trimmed = value.trim()
  const lines = existing.split('\n')
  const kept: string[] = []
  let replaced = false
  for (const line of lines) {
    const match = /^\s*([A-Z0-9_]+)\s*=/.exec(line)
    if (match && match[1] === key) {
      if (trimmed) {
        kept.push(`${key}=${formatEnvValue(trimmed)}`)
        replaced = true
      }
      // empty value => drop the line (unset)
      continue
    }
    if (line.trim().length > 0) kept.push(line)
  }
  if (!replaced && trimmed) kept.push(`${key}=${formatEnvValue(trimmed)}`)

  fs.writeFileSync(envPath, `${kept.join('\n')}\n`, { encoding: 'utf-8', mode: 0o600 })
  try {
    fs.chmodSync(envPath, 0o600)
  } catch {
    // best-effort on platforms without chmod
  }

  if (shouldSyncWorkspaceEnvToProcess()) {
    if (trimmed) process.env[key] = trimmed
    else delete process.env[key]
  }
}
