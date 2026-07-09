export const OPENAI_API_PRICING_SOURCE =
  "https://developers.openai.com/api/docs/pricing"
export const ANTHROPIC_API_PRICING_SOURCE =
  "https://platform.claude.com/docs/en/about-claude/pricing"
export const API_PRICING_AS_OF = "2026-07-09"

export interface ApiEquivalentInputs {
  inputTokens: number | null | undefined
  outputTokens: number | null | undefined
  cachedTokens: number | null | undefined
}

export interface ApiEquivalentEstimate {
  usd: number
  costSource: "api-pricing"
  costAccuracy: "per-call" | "aggregate"
  pricingSource: string
  pricingAsOf: string
}

interface TokenRates {
  inputPerMillion: number
  cachedInputPerMillion: number
  outputPerMillion: number
  largeContextThreshold?: number
  inputPerMillionLarge?: number
  cachedInputPerMillionLarge?: number
  outputPerMillionLarge?: number
}

const CODEX_API_RATES: Record<string, TokenRates> = {
  "gpt-5.6-sol": {
    inputPerMillion: 5,
    cachedInputPerMillion: 0.5,
    outputPerMillion: 30,
  },
  "gpt-5.6-terra": {
    inputPerMillion: 2.5,
    cachedInputPerMillion: 0.25,
    outputPerMillion: 15,
  },
  "gpt-5.6-luna": {
    inputPerMillion: 1,
    cachedInputPerMillion: 0.1,
    outputPerMillion: 6,
  },
  "gpt-5.5": {
    inputPerMillion: 5,
    cachedInputPerMillion: 0.5,
    outputPerMillion: 30,
    largeContextThreshold: 272_000,
    inputPerMillionLarge: 10,
    cachedInputPerMillionLarge: 1,
    outputPerMillionLarge: 45,
  },
  "gpt-5.4": {
    inputPerMillion: 2.5,
    cachedInputPerMillion: 0.25,
    outputPerMillion: 15,
    largeContextThreshold: 272_000,
    inputPerMillionLarge: 5,
    cachedInputPerMillionLarge: 0.5,
    outputPerMillionLarge: 22.5,
  },
  "gpt-5.4-mini": {
    inputPerMillion: 0.75,
    cachedInputPerMillion: 0.075,
    outputPerMillion: 4.5,
  },
}

// Historical Claude Code rows only retain combined cache tokens, so these
// rates intentionally treat that bucket as cache reads (a conservative lower
// bound). New rows use Claude Code's own modelUsage.costUSD instead.
const CLAUDE_API_RATES: Array<{ matches: string[]; rates: TokenRates }> = [
  {
    matches: ["claude-fable-5", "fable"],
    rates: {
      inputPerMillion: 10,
      cachedInputPerMillion: 1,
      outputPerMillion: 50,
    },
  },
  {
    matches: ["claude-mythos-5", "mythos"],
    rates: {
      inputPerMillion: 10,
      cachedInputPerMillion: 1,
      outputPerMillion: 50,
    },
  },
  {
    matches: ["claude-opus-4-8", "opus[1m]", "opus", "default"],
    rates: {
      inputPerMillion: 5,
      cachedInputPerMillion: 0.5,
      outputPerMillion: 25,
    },
  },
  {
    matches: ["claude-sonnet-5", "sonnet-5"],
    rates: {
      inputPerMillion: 2,
      cachedInputPerMillion: 0.2,
      outputPerMillion: 10,
    },
  },
  {
    matches: ["claude-sonnet-4-6", "sonnet[1m]", "sonnet"],
    rates: {
      inputPerMillion: 3,
      cachedInputPerMillion: 0.3,
      outputPerMillion: 15,
    },
  },
  {
    matches: ["claude-haiku-4-5", "haiku"],
    rates: {
      inputPerMillion: 1,
      cachedInputPerMillion: 0.1,
      outputPerMillion: 5,
    },
  },
]

export function estimateCodexApiEquivalentCall(
  model: string,
  inputs: ApiEquivalentInputs,
  contextInputTokens = inputs.inputTokens ?? 0
): ApiEquivalentEstimate | null {
  const rates = findCodexRates(model)
  if (!rates) return null
  return {
    usd: computeCost(rates, inputs, contextInputTokens),
    costSource: "api-pricing",
    costAccuracy: "per-call",
    pricingSource: OPENAI_API_PRICING_SOURCE,
    pricingAsOf: API_PRICING_AS_OF,
  }
}

/** Best-effort fallback for rows written before provider-level billing detail. */
export function estimateCliApiEquivalentAggregate(
  provider: string,
  model: string,
  inputs: ApiEquivalentInputs
): ApiEquivalentEstimate | null {
  if (provider === "codex") {
    const rates = findCodexRates(model)
    if (!rates) return null
    return {
      usd: computeCost(rates, inputs, inputs.inputTokens ?? 0),
      costSource: "api-pricing",
      costAccuracy: "aggregate",
      pricingSource: OPENAI_API_PRICING_SOURCE,
      pricingAsOf: API_PRICING_AS_OF,
    }
  }

  if (provider === "claude-code") {
    const normalized = normalizeModel(model)
    const match = CLAUDE_API_RATES.find((entry) =>
      entry.matches.some(
        (alias) => normalized === alias || normalized.startsWith(`${alias}-`)
      )
    )
    if (!match) return null
    return {
      usd: computeCost(match.rates, inputs, inputs.inputTokens ?? 0),
      costSource: "api-pricing",
      costAccuracy: "aggregate",
      pricingSource: ANTHROPIC_API_PRICING_SOURCE,
      pricingAsOf: API_PRICING_AS_OF,
    }
  }

  return null
}

function findCodexRates(model: string): TokenRates | null {
  const normalized = normalizeModel(model)
  const id = Object.keys(CODEX_API_RATES)
    .sort((a, b) => b.length - a.length)
    .find(
      (candidate) =>
        normalized === candidate || normalized.startsWith(`${candidate}-`)
    )
  return id ? CODEX_API_RATES[id] : null
}

function computeCost(
  rates: TokenRates,
  inputs: ApiEquivalentInputs,
  contextInputTokens: number
): number {
  const large =
    typeof rates.largeContextThreshold === "number" &&
    contextInputTokens > rates.largeContextThreshold
  const inputRate = large
    ? (rates.inputPerMillionLarge ?? rates.inputPerMillion)
    : rates.inputPerMillion
  const cachedRate = large
    ? (rates.cachedInputPerMillionLarge ?? rates.cachedInputPerMillion)
    : rates.cachedInputPerMillion
  const outputRate = large
    ? (rates.outputPerMillionLarge ?? rates.outputPerMillion)
    : rates.outputPerMillion
  const input = nonNegative(inputs.inputTokens)
  const cached = Math.min(input, nonNegative(inputs.cachedTokens))
  const fresh = Math.max(0, input - cached)
  const output = nonNegative(inputs.outputTokens)
  return (
    (fresh * inputRate + cached * cachedRate + output * outputRate) / 1_000_000
  )
}

function normalizeModel(model: string): string {
  return model.trim().toLowerCase()
}

function nonNegative(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0
}
