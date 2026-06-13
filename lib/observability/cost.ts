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
    /** Real USD charged. Always 0 for subscription/unknown — check `state`. */
    usd: number
    /**
     * Metered-equivalent USD: what this request WOULD cost on à-la-carte API
     * pricing. Equals `usd` for `priced`; for `subscription` it's computed from
     * the model's `equivalent*` rates (0 when none are known); 0 for `unknown`.
     * Lets the UI show the cost avoided by being on a subscription plan.
     */
    notionalUsd: number
    state: PricingState
}

/** Per-token rate inputs for the shared cost math. */
interface TokenRates {
    inputPerMillion: number
    outputPerMillion: number
    cachedInputPerMillion?: number
    largeContextThreshold?: number
    inputPerMillionLarge?: number
    outputPerMillionLarge?: number
}

/**
 * Compute USD from token counts and per-token rates. Shared by real `tokens`
 * pricing and by the `subscription` notional estimate (which reuses the same
 * math against the model's documented à-la-carte rates).
 */
function computeTokenCost(rates: TokenRates, inputs: CostInputs): number {
    const totalInput = inputs.inputTokens ?? 0
    const useLargeContextRates =
        typeof rates.largeContextThreshold === 'number' &&
        totalInput > rates.largeContextThreshold

    const inputRate = useLargeContextRates && typeof rates.inputPerMillionLarge === 'number'
        ? rates.inputPerMillionLarge
        : rates.inputPerMillion
    const outputRate = useLargeContextRates && typeof rates.outputPerMillionLarge === 'number'
        ? rates.outputPerMillionLarge
        : rates.outputPerMillion

    const cachedDiscount = CACHED_TOKEN_DISCOUNT[inputs.provider] ?? 1.0
    const cached = inputs.cachedTokens ?? 0
    const cachedRate = typeof rates.cachedInputPerMillion === 'number'
        ? rates.cachedInputPerMillion
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

    return (inputPortion + cachedPortion + outputPortion) / 1_000_000
}

/**
 * Compute USD cost for a single request given its token counts and the model's
 * pricing definition. Returns `usd: 0` with `state: 'unknown' | 'subscription'`
 * when there's no real charge — UI uses `state` to render "—" or "incl." and
 * `notionalUsd` to show the metered-equivalent it would otherwise have cost.
 */
export function estimateCost(pricing: ModelPricing | null, inputs: CostInputs): CostResult {
    if (pricing === null) return { usd: 0, notionalUsd: 0, state: 'unknown' }

    if (pricing.kind === 'subscription') {
        // Subscription is free to the user; surface the à-la-carte cost it would
        // have incurred when the model carries documented equivalent rates.
        const hasEquivalent =
            typeof pricing.equivalentInputPerMillion === 'number' &&
            typeof pricing.equivalentOutputPerMillion === 'number'
        const notionalUsd = hasEquivalent
            ? computeTokenCost({
                inputPerMillion: pricing.equivalentInputPerMillion!,
                outputPerMillion: pricing.equivalentOutputPerMillion!,
                cachedInputPerMillion: pricing.equivalentCachedInputPerMillion,
            }, inputs)
            : 0
        return { usd: 0, notionalUsd, state: 'subscription' }
    }

    if (pricing.kind === 'unit') return { usd: 0, notionalUsd: 0, state: 'unknown' }

    const usd = computeTokenCost(pricing, inputs)
    return { usd, notionalUsd: usd, state: 'priced' }
}
