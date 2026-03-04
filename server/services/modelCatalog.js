import fs from 'node:fs';
import { ThinkingLevel } from '@google/genai';
import { getGeminiApiKey } from '../core/config.js';
import { MODELS_CONFIG_PATH } from '../core/dataPaths.js';

const THINKING_LEVEL_ORDER = ['MINIMAL', 'LOW', 'MEDIUM', 'HIGH'];
const MONTH_INDEX = {
    january: 0,
    february: 1,
    march: 2,
    april: 3,
    may: 4,
    june: 5,
    july: 6,
    august: 7,
    september: 8,
    septempber: 8,
    october: 9,
    november: 10,
    december: 11,
};

function normalizeSpaces(value) {
    return String(value ?? '')
        .replace(/\r/g, '')
        .replace(/\u00a0/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeModelId(value) {
    const raw = String(value ?? '').trim();
    if (!raw) {
        return '';
    }

    return raw.startsWith('models/') ? raw.slice('models/'.length) : raw;
}

function withModelsPrefix(value) {
    const normalized = normalizeModelId(value);
    return normalized ? `models/${normalized}` : '';
}

function isRollingAliasModelId(value) {
    const normalized = normalizeModelId(value).toLowerCase();
    return Boolean(normalized) && /(?:^|-)latest(?:$|-)/.test(normalized);
}

function uniqueStrings(values = []) {
    return [...new Set(
        (Array.isArray(values) ? values : [])
            .map((value) => String(value ?? '').trim())
            .filter(Boolean),
    )];
}

function toFiniteNumber(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}

function toPositiveNumber(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function firstFiniteNumber(...values) {
    for (const value of values) {
        const parsed = toFiniteNumber(value);
        if (parsed !== undefined) {
            return parsed;
        }
    }

    return undefined;
}

function normalizePricingFields(rawEntry = {}) {
    const normalized = {
        inputPrice200k: firstFiniteNumber(toPositiveNumber(rawEntry.inputPrice200k), toPositiveNumber(rawEntry.inputPrice)),
        inputPriceOver200k: firstFiniteNumber(toPositiveNumber(rawEntry.inputPriceOver200k)),
        outputPrice200k: firstFiniteNumber(toPositiveNumber(rawEntry.outputPrice200k), toPositiveNumber(rawEntry.outputPrice)),
        outputPriceOver200k: firstFiniteNumber(toPositiveNumber(rawEntry.outputPriceOver200k)),
        outputTextPrice200k: firstFiniteNumber(toPositiveNumber(rawEntry.outputTextPrice200k), toPositiveNumber(rawEntry.outputPriceText)),
        outputImagePrice200k: firstFiniteNumber(toPositiveNumber(rawEntry.outputImagePrice200k)),
        outputImagePricePerImage: firstFiniteNumber(toPositiveNumber(rawEntry.outputImagePricePerImage), toPositiveNumber(rawEntry.outputPriceImage)),
        outputImagePrice1K: firstFiniteNumber(toPositiveNumber(rawEntry.outputImagePrice1K), toPositiveNumber(rawEntry.outputPriceImage1K)),
        outputImagePrice2K: firstFiniteNumber(toPositiveNumber(rawEntry.outputImagePrice2K), toPositiveNumber(rawEntry.outputPriceImage2K)),
        outputImagePrice4K: firstFiniteNumber(toPositiveNumber(rawEntry.outputImagePrice4K), toPositiveNumber(rawEntry.outputPriceImage4K)),
        outputAudioPrice: firstFiniteNumber(toPositiveNumber(rawEntry.outputAudioPrice)),
        outputPricePerSecond: firstFiniteNumber(toPositiveNumber(rawEntry.outputPricePerSecond)),
        pricePerQuery: firstFiniteNumber(toPositiveNumber(rawEntry.pricePerQuery)),
        groundingPricePer1k: firstFiniteNumber(toPositiveNumber(rawEntry.groundingPricePer1k)),
        defaultImageTokensPerOutput: firstFiniteNumber(rawEntry.defaultImageTokensPerOutput),
        contextWindow: firstFiniteNumber(rawEntry.contextWindow),
    };

    return Object.fromEntries(
        Object.entries(normalized).filter(([, value]) => value !== undefined),
    );
}

function parseReleaseDateCandidate(value) {
    const text = normalizeSpaces(value);
    if (!text) {
        return null;
    }

    let match = text.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
    if (match) {
        const year = Number(match[1]);
        const month = Number(match[2]) - 1;
        const day = Number(match[3]);
        return {
            releaseDate: `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
            releaseTimestamp: Date.UTC(year, month, day),
        };
    }

    match = text.match(/\b([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,)?\s+(20\d{2})\b/i);
    if (match) {
        const monthIndex = MONTH_INDEX[String(match[1]).toLowerCase()];
        if (monthIndex !== undefined) {
            const year = Number(match[3]);
            const day = Number(match[2]);
            return {
                releaseDate: `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
                releaseTimestamp: Date.UTC(year, monthIndex, day),
            };
        }
    }

    match = text.match(/\b([a-z]+)\s+of\s+(20\d{2})\b/i);
    if (match) {
        const monthIndex = MONTH_INDEX[String(match[1]).toLowerCase()];
        if (monthIndex !== undefined) {
            const year = Number(match[2]);
            return {
                releaseDate: `${year}-${String(monthIndex + 1).padStart(2, '0')}-01`,
                releaseTimestamp: Date.UTC(year, monthIndex, 1),
            };
        }
    }

    match = text.match(/\b(0?[1-9]|1[0-2])-(20\d{2})\b/);
    if (match) {
        const month = Number(match[1]) - 1;
        const year = Number(match[2]);
        return {
            releaseDate: `${year}-${String(month + 1).padStart(2, '0')}-01`,
            releaseTimestamp: Date.UTC(year, month, 1),
        };
    }

    match = text.match(/\b(20\d{2})-(0?[1-9]|1[0-2])\b/);
    if (match) {
        const year = Number(match[1]);
        const month = Number(match[2]) - 1;
        return {
            releaseDate: `${year}-${String(month + 1).padStart(2, '0')}-01`,
            releaseTimestamp: Date.UTC(year, month, 1),
        };
    }

    match = text.match(/\b(0?[1-9]|1[0-2])-(\d{2})\b/);
    if (match) {
        const month = Number(match[1]) - 1;
        const year = 2000 + Number(match[2]);
        return {
            releaseDate: `${year}-${String(month + 1).padStart(2, '0')}-01`,
            releaseTimestamp: Date.UTC(year, month, 1),
        };
    }

    return null;
}

function parseSemanticVersionRank(values = []) {
    for (const value of values) {
        const match = normalizeSpaces(value).match(/\b(\d+)(?:\.(\d+))?\b/);
        if (!match) {
            continue;
        }

        const major = Number(match[1]);
        const minor = Number(match[2] ?? 0);
        return major * 100 + minor;
    }

    return 0;
}

function buildReleaseInfo(apiModel = {}, catalogEntry = {}) {
    const candidates = [
        catalogEntry?.releaseDate,
        apiModel?.version,
        apiModel?.description,
        apiModel?.displayName,
        apiModel?.name,
    ];

    for (const candidate of candidates) {
        const parsed = parseReleaseDateCandidate(candidate);
        if (parsed) {
            return {
                ...parsed,
                versionRank: parseSemanticVersionRank([apiModel?.version, apiModel?.name]),
            };
        }
    }

    return {
        releaseDate: '',
        releaseTimestamp: 0,
        versionRank: parseSemanticVersionRank([apiModel?.version, apiModel?.name]),
    };
}

function normalizeThinkingPresets(presets = []) {
    return (Array.isArray(presets) ? presets : [])
        .map((preset) => {
            const id = String(preset?.id ?? '').trim().toUpperCase();
            if (!id) {
                return null;
            }

            const normalized = {
                id,
                label: String(preset?.label ?? id).trim() || id,
                description: String(preset?.description ?? '').trim(),
                default: preset?.default === true,
            };

            const budget = toFiniteNumber(preset?.thinkingBudget);
            if (budget !== undefined) {
                normalized.thinkingBudget = Math.trunc(budget);
            }

            const level = String(preset?.thinkingLevel ?? '').trim().toUpperCase();
            if (level) {
                normalized.thinkingLevel = level;
            }

            return normalized;
        })
        .filter(Boolean);
}

function chooseDefaultThinkingPreset({ thinkingMode, supportedThinkingLevels = [], supportedThinkingBudgets = [] } = {}) {
    if (thinkingMode === 'level') {
        if (supportedThinkingLevels.includes('HIGH')) {
            return 'HIGH';
        }
        return supportedThinkingLevels[0] ?? '';
    }

    if (thinkingMode === 'budget') {
        if (supportedThinkingBudgets.includes(-1)) {
            return 'DYNAMIC';
        }

        const positiveBudget = [...supportedThinkingBudgets]
            .filter((budget) => budget > 0)
            .sort((left, right) => left - right)[0];
        if (Number.isFinite(positiveBudget)) {
            return `BUDGET_${positiveBudget}`;
        }

        if (supportedThinkingBudgets.includes(0)) {
            return 'OFF';
        }
    }

    return '';
}

function inferTier(modelId) {
    const id = normalizeModelId(modelId).toLowerCase();
    if (id.includes('pro')) return 'pro';
    if (id.includes('flash-lite') || id.includes('lite')) return 'flash-lite';
    if (id.includes('flash')) return 'flash';
    if (id.includes('image') || id.startsWith('imagen-')) return 'image';
    if (id.includes('veo')) return 'video';
    return 'standard';
}

function classifyModelKind(apiModel = {}) {
    const modelId = normalizeModelId(apiModel.name ?? apiModel.id);
    const methods = uniqueStrings(apiModel.supportedGenerationMethods);

    if (!modelId) return 'other';
    if (modelId === 'aqa') return 'aqa';
    if (modelId.startsWith('imagen-')) return 'image-generation';
    if (modelId.startsWith('veo-')) return 'video-generation';
    if (modelId.includes('embedding') || methods.includes('embedContent')) return 'embedding';
    if (modelId.includes('native-audio') || methods.includes('bidiGenerateContent')) return 'live-audio';
    if (modelId.includes('-tts')) return 'tts';
    if (modelId.includes('computer-use')) return 'computer-use';
    if (modelId.includes('-image')) return 'image-generation';
    if (methods.includes('generateContent')) return 'chat';
    if (methods.includes('predict') || methods.includes('predictLongRunning')) return 'media-generation';
    return 'other';
}

function buildAllowedAgentIds(modelKind, thinkingMode) {
    if (modelKind === 'image-generation') {
        return ['image'];
    }

    if (modelKind === 'chat' || modelKind === 'computer-use') {
        const base = ['coding', 'multipurpose', 'orchestrator', 'researcher'];
        if (thinkingMode !== 'budget') {
            base.push('browser');
        }
        return base;
    }

    return [];
}

function normalizeCatalogEntry(rawEntry = {}, rawKey = '') {
    const modelId = withModelsPrefix(rawEntry?.id ?? rawKey);
    if (!modelId) {
        return null;
    }

    const thinkingMode = String(rawEntry?.thinkingMode ?? '').trim().toLowerCase();
    return {
        id: modelId,
        displayName: String(rawEntry?.displayName ?? rawEntry?.name ?? '').trim(),
        description: String(rawEntry?.description ?? '').trim(),
        note: String(rawEntry?.note ?? '').trim(),
        tier: String(rawEntry?.tier ?? '').trim() || inferTier(modelId),
        status: String(rawEntry?.status ?? '').trim().toLowerCase() || 'active',
        deprecatedAt: String(rawEntry?.deprecatedAt ?? rawEntry?.shutdownDate ?? '').trim(),
        recommendedReplacement: withModelsPrefix(rawEntry?.recommendedReplacement),
        restrictions: uniqueStrings(rawEntry?.restrictions),
        sourceUrls: uniqueStrings(rawEntry?.sourceUrls),
        pricingVerified: rawEntry?.pricingVerified === true,
        thinkingVerified: rawEntry?.thinkingVerified === true,
        lifecycleVerified: rawEntry?.lifecycleVerified === true,
        schemaVersion: firstFiniteNumber(rawEntry?.schemaVersion),
        lastVerifiedAt: String(rawEntry?.lastVerifiedAt ?? '').trim(),
        apiSignature: String(rawEntry?.apiSignature ?? '').trim(),
        supportedGenerationMethods: uniqueStrings(rawEntry?.supportedGenerationMethods),
        modelKind: String(rawEntry?.modelKind ?? '').trim() || 'other',
        thinkingMode: ['none', 'level', 'budget'].includes(thinkingMode) ? thinkingMode : '',
        supportedThinkingLevels: uniqueStrings(rawEntry?.supportedThinkingLevels)
            .map((value) => value.toUpperCase())
            .filter((value) => THINKING_LEVEL_ORDER.includes(value)),
        supportedThinkingBudgets: [...new Set(
            (Array.isArray(rawEntry?.supportedThinkingBudgets) ? rawEntry.supportedThinkingBudgets : [])
                .map((value) => toFiniteNumber(value))
                .filter((value) => value !== undefined)
                .map((value) => Math.trunc(value)),
        )],
        defaultThinkingPreset: String(rawEntry?.defaultThinkingPreset ?? rawEntry?.defaultThinkingLevel ?? '').trim().toUpperCase(),
        thinkingPresets: normalizeThinkingPresets(rawEntry?.thinkingPresets),
        allowedAgentIds: uniqueStrings(rawEntry?.allowedAgentIds),
        aliases: uniqueStrings(rawEntry?.aliases).map(withModelsPrefix).filter(Boolean),
        ...normalizePricingFields(rawEntry),
    };
}

export function readModelCatalog() {
    try {
        if (!fs.existsSync(MODELS_CONFIG_PATH)) {
            return {};
        }

        const raw = JSON.parse(fs.readFileSync(MODELS_CONFIG_PATH, 'utf8'));
        const entries = {};

        for (const [key, value] of Object.entries(raw ?? {})) {
            if (String(key).startsWith('__')) {
                continue;
            }

            const normalized = normalizeCatalogEntry(value, key);
            if (!normalized) {
                continue;
            }

            entries[normalizeModelId(normalized.id)] = normalized;
        }

        return entries;
    } catch {
        return {};
    }
}

export function getModelCatalogEntry(modelId) {
    const normalizedId = normalizeModelId(modelId);
    if (!normalizedId) {
        return null;
    }

    return readModelCatalog()[normalizedId] ?? null;
}

export async function listAvailableModelsFromApi() {
    const apiKey = getGeminiApiKey();
    if (!apiKey) {
        throw new Error('Missing GEMINI_API_KEY in environment or config.');
    }

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`);
    if (!response.ok) {
        throw new Error(`Failed to fetch models: ${response.status}`);
    }

    const payload = await response.json();
    return Array.isArray(payload?.models) ? payload.models : [];
}

function buildClientModel(apiModel = {}, catalogEntry = null) {
    const modelId = normalizeModelId(apiModel?.name ?? catalogEntry?.id);
    const entry = catalogEntry ?? {};
    const thinkingMode = entry.thinkingMode || (apiModel?.thinking === true ? '' : 'none');
    const modelKind = entry.modelKind || classifyModelKind(apiModel);
    const allowedAgentIds = entry.allowedAgentIds?.length > 0
        ? entry.allowedAgentIds
        : buildAllowedAgentIds(modelKind, thinkingMode);
    const releaseInfo = buildReleaseInfo(apiModel, entry);

    return {
        id: modelId,
        fullName: withModelsPrefix(modelId),
        displayName: entry.displayName || String(apiModel?.displayName ?? '').trim() || modelId,
        description: entry.description || String(apiModel?.description ?? '').trim() || 'No description available',
        tier: entry.tier || inferTier(modelId),
        note: entry.note || '',
        status: entry.status || 'active',
        deprecatedAt: entry.deprecatedAt || '',
        recommendedReplacement: entry.recommendedReplacement || '',
        supportedGenerationMethods: uniqueStrings(apiModel?.supportedGenerationMethods ?? entry.supportedGenerationMethods),
        contextWindow: firstFiniteNumber(entry.contextWindow, apiModel?.inputTokenLimit),
        outputTokenLimit: firstFiniteNumber(apiModel?.outputTokenLimit),
        modelKind,
        allowedAgentIds,
        releaseDate: releaseInfo.releaseDate,
        releaseTimestamp: releaseInfo.releaseTimestamp,
        versionRank: releaseInfo.versionRank,
        pricingVerified: entry.pricingVerified === true,
        thinkingVerified: entry.thinkingVerified === true,
        lifecycleVerified: entry.lifecycleVerified === true,
        catalogComplete: entry.pricingVerified === true && entry.thinkingVerified === true,
        thinkingMode,
        thinkingSupported: thinkingMode === 'level' || thinkingMode === 'budget',
        thinkingPresets: normalizeThinkingPresets(entry.thinkingPresets),
        defaultThinkingPreset: entry.defaultThinkingPreset || chooseDefaultThinkingPreset(entry),
        restrictions: uniqueStrings(entry.restrictions),
        sourceUrls: uniqueStrings(entry.sourceUrls),
        inputPrice200k: entry.inputPrice200k,
        inputPriceOver200k: entry.inputPriceOver200k,
        outputPrice200k: entry.outputPrice200k,
        outputPriceOver200k: entry.outputPriceOver200k,
        outputTextPrice200k: entry.outputTextPrice200k,
        outputImagePrice200k: entry.outputImagePrice200k,
        outputImagePricePerImage: entry.outputImagePricePerImage,
        outputImagePrice1K: entry.outputImagePrice1K,
        outputImagePrice2K: entry.outputImagePrice2K,
        outputImagePrice4K: entry.outputImagePrice4K,
        outputAudioPrice: entry.outputAudioPrice,
        outputPricePerSecond: entry.outputPricePerSecond,
        pricePerQuery: entry.pricePerQuery,
        groundingPricePer1k: entry.groundingPricePer1k,
        supportedThinkingLevels: uniqueStrings(entry.supportedThinkingLevels),
        supportedThinkingBudgets: [...(entry.supportedThinkingBudgets ?? [])],
    };
}

export async function getModelsForClient() {
    const rawModels = await listAvailableModelsFromApi();
    const catalog = readModelCatalog();

    return rawModels
        .map((apiModel) => buildClientModel(apiModel, catalog[normalizeModelId(apiModel?.name)] ?? null))
        .filter((model) => model.status !== 'retired')
        .sort((left, right) => {
            const rollingAliasDelta = Number(isRollingAliasModelId(left.id)) - Number(isRollingAliasModelId(right.id));
            if (rollingAliasDelta !== 0) {
                return rollingAliasDelta;
            }

            const releaseDelta = Number(right.releaseTimestamp ?? 0) - Number(left.releaseTimestamp ?? 0);
            if (releaseDelta !== 0) {
                return releaseDelta;
            }

            const versionDelta = Number(right.versionRank ?? 0) - Number(left.versionRank ?? 0);
            if (versionDelta !== 0) {
                return versionDelta;
            }

            return String(left.displayName ?? '').localeCompare(String(right.displayName ?? ''));
        });
}

function fallbackThinkingConfigFromLegacyLevel(presetId) {
    const normalized = String(presetId ?? '').trim().toUpperCase();
    if (!THINKING_LEVEL_ORDER.includes(normalized)) {
        return null;
    }

    return {
        thinkingLevel: ThinkingLevel[normalized],
        includeThoughts: true,
    };
}

export function resolveThinkingConfig(modelId, presetId) {
    const entry = getModelCatalogEntry(modelId);
    const normalizedPresetId = String(presetId ?? '').trim().toUpperCase();

    if (!entry || !entry.thinkingVerified || !entry.thinkingMode) {
        return fallbackThinkingConfigFromLegacyLevel(normalizedPresetId);
    }

    if (entry.thinkingMode === 'none') {
        return null;
    }

    const presets = normalizeThinkingPresets(entry.thinkingPresets);
    const preferredId = normalizedPresetId || String(entry.defaultThinkingPreset ?? '').trim().toUpperCase();
    const matched = presets.find((preset) => preset.id === preferredId)
        ?? presets.find((preset) => preset.default === true)
        ?? presets[0];

    if (!matched) {
        return null;
    }

    if (entry.thinkingMode === 'level' && matched.thinkingLevel) {
        return {
            thinkingLevel: ThinkingLevel[matched.thinkingLevel] ?? ThinkingLevel.MINIMAL,
            includeThoughts: true,
        };
    }

    if (entry.thinkingMode === 'budget' && Number.isFinite(matched.thinkingBudget)) {
        return {
            thinkingBudget: matched.thinkingBudget,
            includeThoughts: matched.thinkingBudget !== 0,
        };
    }

    return null;
}
