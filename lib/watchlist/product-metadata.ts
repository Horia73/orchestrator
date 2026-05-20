import {
  readResponseBody,
  safeFetch,
  validatePublicHttpUrl,
} from "@/lib/ai/tools/web"

const FETCH_TIMEOUT_MS = 12_000
const MAX_FETCH_BYTES = 1_500_000
const KNOWN_CURRENCIES = new Set([
  "USD",
  "EUR",
  "GBP",
  "RON",
  "CHF",
  "JPY",
  "CAD",
  "AUD",
  "PLN",
  "HUF",
  "BGN",
  "CZK",
  "SEK",
  "NOK",
  "DKK",
  "TRY",
])
const CURRENCY_SYMBOL_MAP: Record<string, string> = {
  "$": "USD",
  "€": "EUR",
  "£": "GBP",
  "¥": "JPY",
  "lei": "RON",
}

export interface ProductMetadata {
  url: string
  name: string | null
  price: number | null
  currency: string | null
  image: string | null
  store: string | null
  description: string | null
}

/**
 * Fetch a product page and best-effort extract { name, price, currency, image, store }.
 *
 * The extractor reads OpenGraph tags, JSON-LD `schema.org/Product`, twitter:* meta
 * and a few microdata hints. Designed to be cheap (single GET, no browser). Returns
 * nulls when something can't be confidently inferred — caller decides what to do.
 */
export async function fetchProductMetadata(
  rawUrl: string
): Promise<{ ok: true; data: ProductMetadata } | { ok: false; error: string }> {
  const safety = await validatePublicHttpUrl(rawUrl)
  if (!safety.ok) return { ok: false, error: safety.error }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await safeFetch(safety.url, controller.signal)
    if (!response.ok) {
      return {
        ok: false,
        error: `Fetch failed (${response.status} ${response.statusText})`,
      }
    }
    const contentType = response.headers.get("content-type") ?? ""
    if (!contentType.includes("text/html") && !contentType.includes("xml")) {
      return {
        ok: false,
        error: `Unsupported content-type for product page: ${contentType || "unknown"}`,
      }
    }
    const html = await readResponseBody(response, MAX_FETCH_BYTES)
    const data = extractFromHtml(html, response.url || safety.url.toString())
    return { ok: true, data }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Unknown extractor error",
    }
  } finally {
    clearTimeout(timer)
  }
}

function extractFromHtml(html: string, finalUrl: string): ProductMetadata {
  const meta = extractMeta(html)
  const jsonLd = extractJsonLdProducts(html)
  const productLd = jsonLd[0] ?? null
  const offers = pickOffer(productLd)

  const name =
    cleanStringField(productLd?.name) ??
    cleanStringField(meta["og:title"]) ??
    cleanStringField(meta["twitter:title"]) ??
    cleanStringField(extractTagText(html, "title")) ??
    cleanStringField(extractTagText(html, "h1"))

  const description =
    cleanStringField(productLd?.description) ??
    cleanStringField(meta["og:description"]) ??
    cleanStringField(meta["twitter:description"]) ??
    cleanStringField(meta["description"])

  const imageRaw =
    pickFirstImage(productLd?.image) ??
    cleanStringField(meta["og:image"]) ??
    cleanStringField(meta["og:image:url"]) ??
    cleanStringField(meta["og:image:secure_url"]) ??
    cleanStringField(meta["twitter:image"]) ??
    cleanStringField(meta["twitter:image:src"])

  const image = imageRaw ? resolveUrl(imageRaw, finalUrl) : null

  const priceFromLd =
    parseNumber(offers?.price) ??
    parseNumber(offers?.lowPrice) ??
    parseNumber(offers?.highPrice)
  const currencyFromLd = normalizeCurrency(offers?.priceCurrency)

  const priceFromMeta =
    parseNumber(meta["product:price:amount"]) ??
    parseNumber(meta["og:price:amount"]) ??
    parseNumber(meta["product:price"]) ??
    parseNumber(meta["twitter:data1"])
  const currencyFromMeta = normalizeCurrency(
    meta["product:price:currency"] ??
      meta["og:price:currency"] ??
      meta["product:currency"]
  )

  const microPrice = extractMicrodataPrice(html)
  let price = priceFromLd ?? priceFromMeta ?? microPrice.price ?? null
  let currency = currencyFromLd ?? currencyFromMeta ?? microPrice.currency ?? null

  // Last resort: pull a "199,99 lei" or "$1,299.00" near the top of the body.
  if (price == null || currency == null) {
    const sniff = sniffPriceFromBody(html)
    if (price == null) price = sniff.price
    if (!currency) currency = sniff.currency
  }

  return {
    url: finalUrl,
    name: name ?? null,
    price: price ?? null,
    currency: currency ?? null,
    image,
    store: storeFromUrl(finalUrl),
    description: description ?? null,
  }
}

function extractMeta(html: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re =
    /<meta\b[^>]*?(?:property|name|itemprop)\s*=\s*["']([^"']+)["'][^>]*?content\s*=\s*["']([^"']*)["'][^>]*>/gi
  const reAlt =
    /<meta\b[^>]*?content\s*=\s*["']([^"']*)["'][^>]*?(?:property|name|itemprop)\s*=\s*["']([^"']+)["'][^>]*>/gi
  let match: RegExpExecArray | null
  while ((match = re.exec(html))) {
    const key = match[1].toLowerCase()
    if (!(key in out)) out[key] = decodeEntities(match[2])
  }
  while ((match = reAlt.exec(html))) {
    const key = match[2].toLowerCase()
    if (!(key in out)) out[key] = decodeEntities(match[1])
  }
  return out
}

function extractTagText(html: string, tag: string): string | null {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i")
  const match = re.exec(html)
  if (!match) return null
  return decodeEntities(match[1].replace(/<[^>]+>/g, " ").trim())
}

type JsonLdProduct = {
  "@type"?: string | string[]
  name?: unknown
  description?: unknown
  image?: unknown
  offers?: unknown
  brand?: unknown
}

function extractJsonLdProducts(html: string): JsonLdProduct[] {
  const out: JsonLdProduct[] = []
  const blockRe =
    /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  let match: RegExpExecArray | null
  while ((match = blockRe.exec(html))) {
    const raw = match[1].trim()
    if (!raw) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      // Some sites embed multiple objects separated by newlines or stray commas.
      // Best-effort: try to recover the first object.
      const firstBrace = raw.indexOf("{")
      const lastBrace = raw.lastIndexOf("}")
      if (firstBrace >= 0 && lastBrace > firstBrace) {
        try {
          parsed = JSON.parse(raw.slice(firstBrace, lastBrace + 1))
        } catch {
          continue
        }
      } else continue
    }
    collectProducts(parsed, out)
  }
  return out
}

function collectProducts(node: unknown, out: JsonLdProduct[]) {
  if (!node) return
  if (Array.isArray(node)) {
    for (const item of node) collectProducts(item, out)
    return
  }
  if (typeof node !== "object") return
  const obj = node as Record<string, unknown>
  const type = obj["@type"]
  const matches = (value: unknown) =>
    typeof value === "string" && value.toLowerCase() === "product"
  if (matches(type) || (Array.isArray(type) && type.some(matches))) {
    out.push(obj as JsonLdProduct)
  }
  if (Array.isArray(obj["@graph"])) {
    for (const child of obj["@graph"] as unknown[]) collectProducts(child, out)
  }
}

type Offer = {
  price?: unknown
  lowPrice?: unknown
  highPrice?: unknown
  priceCurrency?: unknown
  priceSpecification?: unknown
}

function pickOffer(product: JsonLdProduct | null): Offer | null {
  if (!product) return null
  const offers = product.offers
  if (!offers) return null
  const candidate = Array.isArray(offers) ? offers[0] : offers
  if (!candidate || typeof candidate !== "object") return null
  const offer = candidate as Offer
  if (offer.price == null && offer.priceSpecification) {
    const spec = Array.isArray(offer.priceSpecification)
      ? offer.priceSpecification[0]
      : offer.priceSpecification
    if (spec && typeof spec === "object") {
      const s = spec as Offer
      return { ...offer, price: s.price, priceCurrency: s.priceCurrency }
    }
  }
  return offer
}

function pickFirstImage(value: unknown): string | null {
  if (!value) return null
  if (typeof value === "string") return value
  if (Array.isArray(value)) {
    for (const item of value) {
      const candidate = pickFirstImage(item)
      if (candidate) return candidate
    }
    return null
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>
    if (typeof obj.url === "string") return obj.url
    if (typeof obj.contentUrl === "string") return obj.contentUrl
  }
  return null
}

function parseNumber(value: unknown): number | null {
  if (value == null) return null
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value !== "string") return null
  const cleaned = value.trim().replace(/\s+/g, "")
  if (!cleaned) return null
  // Choose the right decimal separator: prefer the rightmost.
  const lastComma = cleaned.lastIndexOf(",")
  const lastDot = cleaned.lastIndexOf(".")
  let normalized = cleaned
  if (lastComma > -1 && lastComma > lastDot) {
    normalized = cleaned.replace(/\./g, "").replace(",", ".")
  } else if (lastDot > -1 && lastDot > lastComma) {
    normalized = cleaned.replace(/,/g, "")
  } else {
    normalized = cleaned.replace(/,/g, "")
  }
  const numeric = Number(normalized.replace(/[^0-9.\-]/g, ""))
  return Number.isFinite(numeric) ? numeric : null
}

function normalizeCurrency(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (!trimmed) return null
  const upper = trimmed.toUpperCase()
  if (KNOWN_CURRENCIES.has(upper)) return upper
  if (/^[A-Z]{3}$/.test(upper)) return upper
  const lower = trimmed.toLowerCase()
  if (CURRENCY_SYMBOL_MAP[lower]) return CURRENCY_SYMBOL_MAP[lower]
  if (CURRENCY_SYMBOL_MAP[trimmed]) return CURRENCY_SYMBOL_MAP[trimmed]
  return null
}

function cleanStringField(value: unknown): string | null {
  if (typeof value !== "string") return null
  const cleaned = decodeEntities(value).replace(/\s+/g, " ").trim()
  return cleaned ? cleaned : null
}

function extractMicrodataPrice(html: string): {
  price: number | null
  currency: string | null
} {
  const priceRe =
    /itemprop\s*=\s*["']price["'][^>]*content\s*=\s*["']([^"']+)["']/i
  const altPriceRe =
    /content\s*=\s*["']([^"']+)["'][^>]*itemprop\s*=\s*["']price["']/i
  const currencyRe =
    /itemprop\s*=\s*["']priceCurrency["'][^>]*content\s*=\s*["']([^"']+)["']/i
  const altCurrencyRe =
    /content\s*=\s*["']([^"']+)["'][^>]*itemprop\s*=\s*["']priceCurrency["']/i
  const priceMatch = priceRe.exec(html) ?? altPriceRe.exec(html)
  const currencyMatch = currencyRe.exec(html) ?? altCurrencyRe.exec(html)
  return {
    price: priceMatch ? parseNumber(priceMatch[1]) : null,
    currency: currencyMatch ? normalizeCurrency(currencyMatch[1]) : null,
  }
}

function sniffPriceFromBody(html: string): {
  price: number | null
  currency: string | null
} {
  // Drop scripts/styles before sniffing so we don't catch JS-embedded numbers.
  const sanitized = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
  const bodyStart = sanitized.search(/<body\b/i)
  const slice = bodyStart > -1 ? sanitized.slice(bodyStart, bodyStart + 200_000) : sanitized.slice(0, 200_000)
  const patterns: Array<{ re: RegExp; currency: string; numberIndex: number }> = [
    { re: /(\d{1,3}(?:[. \s]\d{3})*(?:[.,]\d{1,2})?)\s*(?:lei|RON)/i, currency: "RON", numberIndex: 1 },
    { re: /€\s*(\d{1,3}(?:[. \s]\d{3})*(?:[.,]\d{1,2})?)/, currency: "EUR", numberIndex: 1 },
    { re: /(\d{1,3}(?:[. \s]\d{3})*(?:[.,]\d{1,2})?)\s*€/, currency: "EUR", numberIndex: 1 },
    { re: /\$\s*(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?)/, currency: "USD", numberIndex: 1 },
    { re: /£\s*(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?)/, currency: "GBP", numberIndex: 1 },
  ]
  for (const { re, currency, numberIndex } of patterns) {
    const match = re.exec(slice)
    if (match) {
      const price = parseNumber(match[numberIndex])
      if (price != null && price > 0) return { price, currency }
    }
  }
  return { price: null, currency: null }
}

function storeFromUrl(value: string): string | null {
  try {
    const url = new URL(value)
    const host = url.hostname.replace(/^www\./i, "")
    // Strip TLD parts past the second-level domain for short labels.
    const parts = host.split(".")
    if (parts.length <= 2) return host
    // Keep "amazon.co.uk" style two-piece TLDs.
    const last = parts[parts.length - 1]
    const second = parts[parts.length - 2]
    const isCompoundTld = last.length === 2 && second.length <= 3
    return isCompoundTld
      ? parts.slice(-3).join(".")
      : parts.slice(-2).join(".")
  } catch {
    return null
  }
}

function resolveUrl(value: string, base: string): string | null {
  try {
    return new URL(value, base).toString()
  } catch {
    return null
  }
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, code) => {
      const n = Number(code)
      return Number.isFinite(n) ? String.fromCodePoint(n) : ""
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const n = parseInt(hex, 16)
      return Number.isFinite(n) ? String.fromCodePoint(n) : ""
    })
}
