// ---------------------------------------------------------------------------
// Per-conversation integration activation.
//
// Operational integration tool schemas are heavy. We expose them only after an
// agent explicitly activates the integration for the current conversation
// (via the ActivateIntegrationTools tool). This store records that decision.
//
// Process-local and in-memory by design — same model as chat streams and
// provider interaction ids. A restart resets activation, which is safe: the
// agent simply re-activates on the next relevant turn (one cheap hop).
// ---------------------------------------------------------------------------

const MAX_TRACKED_CONVERSATIONS = 500

/** Insertion-ordered so we can evict the oldest conversation when over cap. */
const store = new Map<string, Set<string>>()

function touch(conversationId: string): Set<string> {
    let set = store.get(conversationId)
    if (set) {
        // Re-insert to mark as most-recently-used.
        store.delete(conversationId)
        store.set(conversationId, set)
        return set
    }
    set = new Set<string>()
    store.set(conversationId, set)
    if (store.size > MAX_TRACKED_CONVERSATIONS) {
        const oldest = store.keys().next().value
        if (oldest !== undefined) store.delete(oldest)
    }
    return set
}

/** Mark one or more integrations active for a conversation. Returns the full active set. */
export function activateIntegrations(conversationId: string, integrationIds: string[]): Set<string> {
    if (!conversationId) return new Set()
    const set = touch(conversationId)
    for (const id of integrationIds) set.add(id)
    return new Set(set)
}

/** Integrations currently active for a conversation. */
export function getActivatedIntegrations(conversationId: string | undefined): Set<string> {
    if (!conversationId) return new Set()
    return new Set(store.get(conversationId) ?? [])
}

export function isIntegrationActivated(conversationId: string | undefined, integrationId: string): boolean {
    if (!conversationId) return false
    return store.get(conversationId)?.has(integrationId) ?? false
}
