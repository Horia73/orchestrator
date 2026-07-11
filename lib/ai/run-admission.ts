/**
 * Process-wide admission barrier for new AI runs.
 *
 * Managed updates close this barrier only after the already-registered runs
 * have drained. Registries check it synchronously, which closes the race where
 * a request passed an early maintenance check, awaited setup, and registered
 * only after the updater had started rebuilding the container.
 *
 * State lives on globalThis so Next.js hot reloads cannot accidentally reopen
 * admissions while an update is active.
 */

export interface AiRunAdmissionBlock {
    owner: string
    reason: string
    blockedAt: number
}

const globalForAiRunAdmission = globalThis as unknown as {
    __orchestratorAiRunAdmissionBlock?: AiRunAdmissionBlock | null
}

if (globalForAiRunAdmission.__orchestratorAiRunAdmissionBlock === undefined) {
    globalForAiRunAdmission.__orchestratorAiRunAdmissionBlock = null
}

export function blockAiRunAdmission(owner: string, reason: string): AiRunAdmissionBlock {
    const current = globalForAiRunAdmission.__orchestratorAiRunAdmissionBlock
    if (current?.owner === owner) return current
    const block = { owner, reason, blockedAt: Date.now() }
    globalForAiRunAdmission.__orchestratorAiRunAdmissionBlock = block
    return block
}

export function unblockAiRunAdmission(owner: string): boolean {
    const current = globalForAiRunAdmission.__orchestratorAiRunAdmissionBlock
    if (!current || current.owner !== owner) return false
    globalForAiRunAdmission.__orchestratorAiRunAdmissionBlock = null
    return true
}

export function getAiRunAdmissionBlock(): AiRunAdmissionBlock | null {
    return globalForAiRunAdmission.__orchestratorAiRunAdmissionBlock ?? null
}
