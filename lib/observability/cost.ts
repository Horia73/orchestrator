import type { ModelPricing } from '@/lib/models/schema'

// ---------------------------------------------------------------------------
// Cost estimation for a single request.
//
// We only know per-token pricing from the registry today (input/output, with
// optional large-context tier). Thinking tokens are billed as output by every
// provider that exposes them, so we charge them at the output rate.
//
// Cached tokens — Gemini bills these at ~25% of regular input. We expose the
// discount as a constant so it's tunable per-provider when other providers
// land. Anthropic's cache reads are 0.10x; OpenAI's are 0.50x. Default is 1.0
// (no discount) for unknown providers — overestimate is safer than underestimate.
// ---------------------------------------------------------------------------

const CACHED_TOKEN_DISCOUNT: Record<string, number> = {
    google: 0.25,
    anthropic: 0.10,
    openai: 0.50,
}

export interface CostInputs {
    provider: string
    /** Window contributed across all roles. */
    inputTokens: number | null | undefined
    outputTokens: number | null | undefined
    thinkingTokens: number | null | undefined
    cachedTokens: number | null | undefined
    toolUseTokens: number | null | undefined
}

export type PricingState = 'priced' | 'subscription' | 'unknown'

export interface CostResult {
    /** USD. Always 0 for subscription/unknown — check `state` to interpret. */
    usd: number
    state: PricingState
}

const ZERO_UNKNOWN: CostResult = { usd: 0, state: 'unknown' }
const ZERO_SUBSCRIPTION: CostResult = { usd: 0, state: 'subscription' }

/**
 * Compute USD cost for a single request given its token counts and the model's
 * pricing definition. Returns `usd: 0` with `state: 'unknown' | 'subscription'`
 * when we can't compute a real number — UI uses `state` to render "—" or "incl."
 */
export function estimateCost(pricing: ModelPricing | null, inputs: CostInputs): CostResult {
    if (pricing === null) return ZERO_UNKNOWN
    if (pricing.kind === 'subscription') return ZERO_SUBSCRIPTION
    if (pricing.kind === 'unit') return ZERO_UNKNOWN

    const totalInput = inputs.inputTokens ?? 0
    const useLargeContextRates =
        typeof pricing.largeContextThreshold === 'number' &&
        totalInput > pricing.largeContextThreshold

    const inputRate = useLargeContextRates && typeof pricing.inputPerMillionLarge === 'number'
        ? pricing.inputPerMillionLarge
        : pricing.inputPerMillion
    const outputRate = useLargeContextRates && typeof pricing.outputPerMillionLarge === 'number'
        ? pricing.outputPerMillionLarge
        : pricing.outputPerMillion

    const cachedDiscount = CACHED_TOKEN_DISCOUNT[inputs.provider] ?? 1.0
    const cached = inputs.cachedTokens ?? 0
    const cachedRate = typeof pricing.cachedInputPerMillion === 'number'
        ? pricing.cachedInputPerMillion
        : inputRate * cachedDiscount

    // Real input = total input minus the cached portion (cached is counted in
    // total_input_tokens upstream). If the provider's totals are incomplete and
    // cached > input, clamp to 0 to avoid negative spend.
    const billableInput = Math.max(0, totalInput - cached)

    const output = inputs.outputTokens ?? 0
    const thinking = inputs.thinkingTokens ?? 0
    const toolUse = inputs.toolUseTokens ?? 0

    // Tool-use prompts are charged at input rate for Gemini. Treating them as
    // input across providers is the safe default — every provider currently
    // counts tool roundtrips against input pricing.
    const inputPortion = (billableInput + toolUse) * inputRate
    const cachedPortion = cached * cachedRate
    const outputPortion = (output + thinking) * outputRate

    const usd = (inputPortion + cachedPortion + outputPortion) / 1_000_000

    return { usd, state: 'priced' }
}
