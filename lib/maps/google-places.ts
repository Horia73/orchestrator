import { readGoogleMapsApiKey } from "./google-session"
import type { MapBBox, MapCoordinate, MapPin } from "./schema"

const GOOGLE_PLACES_TEXT_SEARCH_URL =
  "https://places.googleapis.com/v1/places:searchText"
const GOOGLE_PLACES_NEARBY_SEARCH_URL =
  "https://places.googleapis.com/v1/places:searchNearby"
const GOOGLE_PLACES_AUTOCOMPLETE_URL =
  "https://places.googleapis.com/v1/places:autocomplete"
const GOOGLE_PLACES_DETAILS_URL = "https://places.googleapis.com/v1/places"
const GOOGLE_PLACES_MEDIA_URL = "https://places.googleapis.com/v1"

const BASE_FIELD_MASK = [
  "places.id",
  "places.name",
  "places.displayName",
  "places.formattedAddress",
  "places.shortFormattedAddress",
  "places.location",
  "places.types",
  "places.primaryType",
  "places.googleMapsUri",
  "nextPageToken",
]

const AUTOCOMPLETE_FIELD_MASK = [
  "suggestions.placePrediction.placeId",
  "suggestions.placePrediction.text.text",
  "suggestions.placePrediction.structuredFormat.mainText.text",
  "suggestions.placePrediction.structuredFormat.secondaryText.text",
  "suggestions.placePrediction.types",
  "suggestions.queryPrediction.text.text",
  "suggestions.queryPrediction.structuredFormat.mainText.text",
  "suggestions.queryPrediction.structuredFormat.secondaryText.text",
].join(",")

const PLACE_DETAILS_FIELD_MASK = [
  "id",
  "name",
  "displayName",
  "formattedAddress",
  "shortFormattedAddress",
  "location",
  "types",
  "primaryType",
  "businessStatus",
  "rating",
  "userRatingCount",
  "googleMapsUri",
  "websiteUri",
  "nationalPhoneNumber",
  "internationalPhoneNumber",
  "priceLevel",
  "editorialSummary",
  "currentOpeningHours",
  "regularOpeningHours",
  "photos",
].join(",")

export type PlacesSearchMode = "text" | "nearby"
export type PlacesRankPreference = "relevance" | "distance" | "popularity"

export interface PlacesSearchOptions {
  mode: PlacesSearchMode
  query?: string
  center?: MapCoordinate
  radiusMeters?: number
  includedTypes?: string[]
  includedPrimaryTypes?: string[]
  excludedTypes?: string[]
  excludedPrimaryTypes?: string[]
  maxResults?: number
  openNow?: boolean
  rankPreference?: PlacesRankPreference
  languageCode?: string
  regionCode?: string
  pageToken?: string
  includeRatings?: boolean
  includeWebsite?: boolean
  includePhotos?: boolean
}

export interface PlacesSearchResult {
  mode: PlacesSearchMode
  places: PlaceResult[]
  pinReady: MapPin[]
  fitBounds: MapBBox | null
  nextPageToken: string | null
  provider: "google-places"
}

export interface PlacesAutocompleteOptions {
  input: string
  center?: MapCoordinate
  radiusMeters?: number
  includeQueryPredictions?: boolean
  languageCode?: string
  regionCode?: string
  sessionToken?: string
}

export interface PlacesAutocompleteResult {
  suggestions: PlacesAutocompleteSuggestion[]
  provider: "google-places-autocomplete"
}

export interface PlacesAutocompleteSuggestion {
  id: string
  kind: "place" | "query"
  text: string
  mainText: string
  secondaryText: string | null
  placeId: string | null
  types: string[]
}

export interface PlaceDetailsOptions {
  languageCode?: string
  regionCode?: string
  sessionToken?: string
  includePhoto?: boolean
  maxPhotoWidthPx?: number
  maxPhotoHeightPx?: number
}

export interface PlaceResult {
  id: string
  resourceName: string | null
  displayName: string
  formattedAddress: string | null
  shortFormattedAddress: string | null
  position: MapCoordinate
  types: string[]
  primaryType: string | null
  rating: number | null
  userRatingCount: number | null
  googleMapsUri: string | null
  websiteUri: string | null
  photoUrl: string | null
  businessStatus: string | null
  phoneNumber: string | null
  priceLevel: string | null
  editorialSummary: string | null
  currentOpeningHours: PlaceOpeningHours | null
  regularOpeningHours: PlaceOpeningHours | null
}

export interface PlacePhotoAttribution {
  displayName: string | null
  uri: string | null
  photoUri: string | null
}

export interface PlaceDetailsResult extends PlaceResult {
  photoAttributions: PlacePhotoAttribution[]
}

export interface PlaceOpeningHours {
  openNow: boolean | null
  weekdayDescriptions: string[]
}

interface GooglePlacesResponse {
  places?: GooglePlace[]
  nextPageToken?: string
  error?: {
    code?: number
    message?: string
    status?: string
  }
}

interface GooglePlacesAutocompleteResponse {
  suggestions?: GooglePlacesAutocompleteSuggestion[]
  error?: {
    code?: number
    message?: string
    status?: string
  }
}

interface GooglePlacesAutocompleteSuggestion {
  placePrediction?: {
    placeId?: string
    text?: GoogleFormattableText
    structuredFormat?: GoogleStructuredFormat
    types?: string[]
  }
  queryPrediction?: {
    text?: GoogleFormattableText
    structuredFormat?: GoogleStructuredFormat
  }
}

interface GoogleFormattableText {
  text?: string
}

interface GoogleStructuredFormat {
  mainText?: GoogleFormattableText
  secondaryText?: GoogleFormattableText
}

interface GooglePlace {
  id?: string
  name?: string
  displayName?: {
    text?: string
    languageCode?: string
  }
  formattedAddress?: string
  shortFormattedAddress?: string
  location?: {
    latitude?: number
    longitude?: number
  }
  types?: string[]
  primaryType?: string
  businessStatus?: string
  rating?: number
  userRatingCount?: number
  googleMapsUri?: string
  websiteUri?: string
  nationalPhoneNumber?: string
  internationalPhoneNumber?: string
  priceLevel?: string
  editorialSummary?: {
    text?: string
    languageCode?: string
  }
  currentOpeningHours?: GooglePlaceOpeningHours
  regularOpeningHours?: GooglePlaceOpeningHours
  photos?: GooglePlacePhoto[]
}

interface GooglePlaceOpeningHours {
  openNow?: boolean
  weekdayDescriptions?: string[]
}

interface GooglePlacePhoto {
  name?: string
  widthPx?: number
  heightPx?: number
  authorAttributions?: GooglePlacePhotoAttribution[]
}

interface GooglePlacePhotoAttribution {
  displayName?: string
  uri?: string
  photoUri?: string
}

interface GooglePlacePhotoMediaResponse {
  name?: string
  photoUri?: string
  error?: {
    code?: number
    message?: string
    status?: string
  }
}

export async function searchPlaces(
  options: PlacesSearchOptions
): Promise<PlacesSearchResult> {
  const apiKey = readGoogleMapsApiKey()
  if (!apiKey) throw new Error("GOOGLE_MAPS_API_KEY is not set")

  const mode = options.mode
  const body =
    mode === "nearby"
      ? buildNearbySearchRequest(options)
      : buildTextSearchRequest(options)
  const data = await postPlacesJson<GooglePlacesResponse>(
    mode === "nearby"
      ? GOOGLE_PLACES_NEARBY_SEARCH_URL
      : GOOGLE_PLACES_TEXT_SEARCH_URL,
    apiKey,
    body,
    buildFieldMask(options)
  )

  const normalizedPlaces = (data.places ?? [])
    .map((raw) => ({ raw, place: normalizePlace(raw) }))
    .filter(
      (entry): entry is { raw: GooglePlace; place: PlaceResult } =>
        entry.place !== null
    )
  const places = options.includePhotos
    ? await Promise.all(
        normalizedPlaces.map(({ raw, place }) =>
          enrichPlacePhoto(apiKey, raw, place)
        )
      )
    : normalizedPlaces.map(({ place }) => place)
  const pinReady = places.map(placeToPin)

  return {
    mode,
    places,
    pinReady,
    fitBounds: bboxForPlaces(places),
    nextPageToken: cleanString(data.nextPageToken),
    provider: "google-places",
  }
}

export async function autocompletePlaces(
  options: PlacesAutocompleteOptions
): Promise<PlacesAutocompleteResult> {
  const apiKey = readGoogleMapsApiKey()
  if (!apiKey) throw new Error("GOOGLE_MAPS_API_KEY is not set")

  const input = cleanString(options.input)
  if (!input) throw new Error("Places autocomplete requires a non-empty input.")

  const body: Record<string, unknown> = {
    input: input.slice(0, 180),
    includeQueryPredictions: options.includeQueryPredictions ?? true,
  }
  if (options.center) {
    body.locationBias = {
      circle: {
        center: googleLatLng(options.center),
        radius: clampRadius(options.radiusMeters ?? 12_000),
      },
    }
  }
  if (options.languageCode) body.languageCode = options.languageCode
  if (options.regionCode) body.regionCode = options.regionCode
  if (options.sessionToken) body.sessionToken = options.sessionToken

  const data = await postPlacesJson<GooglePlacesAutocompleteResponse>(
    GOOGLE_PLACES_AUTOCOMPLETE_URL,
    apiKey,
    body,
    AUTOCOMPLETE_FIELD_MASK
  )

  return {
    suggestions: (data.suggestions ?? [])
      .map(normalizeAutocompleteSuggestion)
      .filter(
        (suggestion): suggestion is PlacesAutocompleteSuggestion =>
          suggestion !== null
      )
      .slice(0, 5),
    provider: "google-places-autocomplete",
  }
}

export async function getPlaceDetails(
  placeId: string,
  options: PlaceDetailsOptions = {}
): Promise<PlaceDetailsResult> {
  const apiKey = readGoogleMapsApiKey()
  if (!apiKey) throw new Error("GOOGLE_MAPS_API_KEY is not set")

  const id = cleanString(placeId)?.replace(/^places\//, "")
  if (!id) throw new Error("Place details requires a non-empty place id.")

  const url = new URL(`${GOOGLE_PLACES_DETAILS_URL}/${encodeURIComponent(id)}`)
  if (options.languageCode)
    url.searchParams.set("languageCode", options.languageCode)
  if (options.regionCode) url.searchParams.set("regionCode", options.regionCode)
  if (options.sessionToken)
    url.searchParams.set("sessionToken", options.sessionToken)

  const fieldMask =
    options.includePhoto === false
      ? PLACE_DETAILS_FIELD_MASK.split(",")
          .filter((field) => field !== "photos")
          .join(",")
      : PLACE_DETAILS_FIELD_MASK
  const place = await getPlacesJson<GooglePlace>(
    url.toString(),
    apiKey,
    fieldMask
  )
  const normalized = normalizePlace(place)
  if (!normalized)
    throw new Error("Place details response did not include usable geometry.")

  const photo = choosePlacePhoto(place.photos)
  const photoUrl =
    options.includePhoto === false || !photo?.name
      ? null
      : await resolvePlacePhotoUri(apiKey, photo.name, {
          maxWidthPx: options.maxPhotoWidthPx ?? 900,
          maxHeightPx: options.maxPhotoHeightPx ?? 520,
        }).catch(() => null)

  return {
    ...normalized,
    photoUrl,
    photoAttributions: normalizePhotoAttributions(photo?.authorAttributions),
  }
}

function buildTextSearchRequest(
  options: PlacesSearchOptions
): Record<string, unknown> {
  const textQuery = cleanString(options.query)
  if (!textQuery)
    throw new Error("MapsPlaces text search requires a non-empty query.")

  const body: Record<string, unknown> = {
    textQuery,
    pageSize: clampInt(options.maxResults ?? 10, 1, 20),
  }
  addCommonSearchOptions(body, options)

  if (options.center) {
    body.locationBias = {
      circle: {
        center: googleLatLng(options.center),
        radius: clampRadius(options.radiusMeters ?? 2500),
      },
    }
  }

  const rankPreference = parseTextRankPreference(options.rankPreference)
  if (rankPreference) body.rankPreference = rankPreference

  return body
}

function buildNearbySearchRequest(
  options: PlacesSearchOptions
): Record<string, unknown> {
  if (!options.center)
    throw new Error("MapsPlaces nearby search requires `center` as [lng, lat].")
  const includedTypes = cleanStringList(options.includedTypes)
  const includedPrimaryTypes = cleanStringList(options.includedPrimaryTypes)
  if (includedTypes.length === 0 && includedPrimaryTypes.length === 0) {
    throw new Error(
      "MapsPlaces nearby search requires at least one included type or primary type."
    )
  }

  const body: Record<string, unknown> = {
    maxResultCount: clampInt(options.maxResults ?? 10, 1, 20),
    locationRestriction: {
      circle: {
        center: googleLatLng(options.center),
        radius: clampRadius(options.radiusMeters ?? 2500),
      },
    },
  }
  if (includedTypes.length > 0) body.includedTypes = includedTypes
  if (includedPrimaryTypes.length > 0)
    body.includedPrimaryTypes = includedPrimaryTypes

  const excludedTypes = cleanStringList(options.excludedTypes)
  const excludedPrimaryTypes = cleanStringList(options.excludedPrimaryTypes)
  if (excludedTypes.length > 0) body.excludedTypes = excludedTypes
  if (excludedPrimaryTypes.length > 0)
    body.excludedPrimaryTypes = excludedPrimaryTypes

  addCommonSearchOptions(body, options)

  const rankPreference = parseNearbyRankPreference(options.rankPreference)
  if (rankPreference) body.rankPreference = rankPreference

  return body
}

function addCommonSearchOptions(
  body: Record<string, unknown>,
  options: PlacesSearchOptions
): void {
  if (options.openNow === true) body.openNow = true
  if (options.languageCode) body.languageCode = options.languageCode
  if (options.regionCode) body.regionCode = options.regionCode
  if (options.pageToken) body.pageToken = options.pageToken
}

async function postPlacesJson<T>(
  url: string,
  apiKey: string,
  body: Record<string, unknown>,
  fieldMask: string
): Promise<T> {
  let resp: Response
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": fieldMask,
      },
      body: JSON.stringify(body),
    })
  } catch (e) {
    throw new Error(`network: ${(e as Error).message}`)
  }

  let data: T
  try {
    data = (await resp.json()) as T
  } catch (e) {
    throw new Error(`bad json: ${(e as Error).message}`)
  }

  const upstream = data as {
    error?: { code?: number; message?: string; status?: string }
  }
  if (!resp.ok || upstream.error) {
    const err = upstream.error
    const prefix =
      err?.status ?? (resp.ok ? "PLACES_ERROR" : `HTTP ${resp.status}`)
    throw new Error(`${prefix}: ${err?.message ?? resp.statusText}`)
  }

  return data
}

async function getPlacesJson<T>(
  url: string,
  apiKey: string,
  fieldMask: string
): Promise<T> {
  let resp: Response
  try {
    resp = await fetch(url, {
      method: "GET",
      headers: {
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": fieldMask,
      },
    })
  } catch (e) {
    throw new Error(`network: ${(e as Error).message}`)
  }

  let data: T
  try {
    data = (await resp.json()) as T
  } catch (e) {
    throw new Error(`bad json: ${(e as Error).message}`)
  }

  const upstream = data as {
    error?: { code?: number; message?: string; status?: string }
  }
  if (!resp.ok || upstream.error) {
    const err = upstream.error
    const prefix =
      err?.status ?? (resp.ok ? "PLACES_ERROR" : `HTTP ${resp.status}`)
    throw new Error(`${prefix}: ${err?.message ?? resp.statusText}`)
  }

  return data
}

async function resolvePlacePhotoUri(
  apiKey: string,
  photoName: string,
  options: { maxWidthPx: number; maxHeightPx: number }
): Promise<string | null> {
  const safePath = cleanString(photoName)
    ?.split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")
  if (!safePath) return null

  const url = new URL(`${GOOGLE_PLACES_MEDIA_URL}/${safePath}/media`)
  url.searchParams.set(
    "maxWidthPx",
    String(clampInt(options.maxWidthPx, 1, 4800))
  )
  url.searchParams.set(
    "maxHeightPx",
    String(clampInt(options.maxHeightPx, 1, 4800))
  )
  url.searchParams.set("skipHttpRedirect", "true")
  url.searchParams.set("key", apiKey)

  const resp = await fetch(url.toString(), { method: "GET" })
  const data = (await resp
    .json()
    .catch(() => ({}))) as GooglePlacePhotoMediaResponse
  if (!resp.ok || data.error) return null
  return cleanString(data.photoUri)
}

function buildFieldMask(options: PlacesSearchOptions): string {
  const fields = new Set(BASE_FIELD_MASK)
  if (options.includeRatings) {
    fields.add("places.rating")
    fields.add("places.userRatingCount")
  }
  if (options.includeWebsite) fields.add("places.websiteUri")
  if (options.includePhotos) fields.add("places.photos")
  return Array.from(fields).join(",")
}

async function enrichPlacePhoto(
  apiKey: string,
  raw: GooglePlace,
  place: PlaceResult
): Promise<PlaceResult> {
  const photo = choosePlacePhoto(raw.photos)
  if (!photo?.name) return place
  const photoUrl = await resolvePlacePhotoUri(apiKey, photo.name, {
    maxWidthPx: 900,
    maxHeightPx: 520,
  }).catch(() => null)
  return photoUrl ? { ...place, photoUrl } : place
}

function normalizeAutocompleteSuggestion(
  suggestion: GooglePlacesAutocompleteSuggestion
): PlacesAutocompleteSuggestion | null {
  if (suggestion.placePrediction) {
    const prediction = suggestion.placePrediction
    const text = cleanString(prediction.text?.text)
    const mainText =
      cleanString(prediction.structuredFormat?.mainText?.text) ?? text
    if (!text || !mainText) return null
    const placeId = cleanString(prediction.placeId)
    return {
      id: stableAutocompleteId(placeId ?? text),
      kind: "place",
      text,
      mainText,
      secondaryText: cleanString(
        prediction.structuredFormat?.secondaryText?.text
      ),
      placeId,
      types: Array.isArray(prediction.types)
        ? prediction.types.filter(
            (item): item is string => typeof item === "string"
          )
        : [],
    }
  }

  if (suggestion.queryPrediction) {
    const prediction = suggestion.queryPrediction
    const text = cleanString(prediction.text?.text)
    const mainText =
      cleanString(prediction.structuredFormat?.mainText?.text) ?? text
    if (!text || !mainText) return null
    return {
      id: stableAutocompleteId(text),
      kind: "query",
      text,
      mainText,
      secondaryText: cleanString(
        prediction.structuredFormat?.secondaryText?.text
      ),
      placeId: null,
      types: [],
    }
  }

  return null
}

function normalizePlace(place: GooglePlace): PlaceResult | null {
  const lat = finiteNumber(place.location?.latitude)
  const lng = finiteNumber(place.location?.longitude)
  if (lat === null || lng === null || Math.abs(lat) > 90 || Math.abs(lng) > 180)
    return null

  const id =
    cleanString(place.id) ??
    cleanString(place.name)?.replace(/^places\//, "") ??
    ""
  const displayName =
    cleanString(place.displayName?.text) ??
    cleanString(place.formattedAddress) ??
    cleanString(place.shortFormattedAddress) ??
    id
  if (!id || !displayName) return null

  return {
    id,
    resourceName: cleanString(place.name),
    displayName,
    formattedAddress: cleanString(place.formattedAddress),
    shortFormattedAddress: cleanString(place.shortFormattedAddress),
    position: [lng, lat],
    types: Array.isArray(place.types)
      ? place.types.filter((item): item is string => typeof item === "string")
      : [],
    primaryType: cleanString(place.primaryType),
    rating: finiteNumber(place.rating),
    userRatingCount: finiteNumber(place.userRatingCount),
    googleMapsUri: cleanString(place.googleMapsUri),
    websiteUri: cleanString(place.websiteUri),
    photoUrl: null,
    businessStatus: cleanString(place.businessStatus),
    phoneNumber:
      cleanString(place.nationalPhoneNumber) ??
      cleanString(place.internationalPhoneNumber),
    priceLevel: cleanString(place.priceLevel),
    editorialSummary: cleanString(place.editorialSummary?.text),
    currentOpeningHours: normalizeOpeningHours(place.currentOpeningHours),
    regularOpeningHours: normalizeOpeningHours(place.regularOpeningHours),
  }
}

function stableAutocompleteId(value: string): string {
  return `autocomplete-${
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 56) || "suggestion"
  }`
}

function placeToPin(place: PlaceResult): MapPin {
  return {
    id: stablePinId(place.id),
    position: place.position,
    label: place.displayName,
    address: place.shortFormattedAddress ?? place.formattedAddress ?? undefined,
    rating: place.rating ?? undefined,
    userRatingCount: place.userRatingCount ?? undefined,
    photoUrl: place.photoUrl ?? undefined,
    placeId: place.id,
    googleMapsUri: place.googleMapsUri ?? undefined,
    websiteUri: place.websiteUri ?? undefined,
    businessStatus: place.businessStatus ?? undefined,
    openNow:
      place.currentOpeningHours?.openNow ??
      place.regularOpeningHours?.openNow ??
      undefined,
    openingHours: place.currentOpeningHours?.weekdayDescriptions.length
      ? place.currentOpeningHours.weekdayDescriptions
      : place.regularOpeningHours?.weekdayDescriptions.length
        ? place.regularOpeningHours.weekdayDescriptions
        : undefined,
    phoneNumber: place.phoneNumber ?? undefined,
    priceLevel: place.priceLevel ?? undefined,
    editorialSummary: place.editorialSummary ?? undefined,
    icon: iconForPlace(place),
  }
}

function iconForPlace(place: PlaceResult): string {
  const types = new Set([place.primaryType, ...place.types].filter(Boolean))
  if (hasAny(types, ["cafe", "coffee_shop"])) return "coffee"
  if (hasAny(types, ["restaurant", "meal_takeaway", "meal_delivery", "food"]))
    return "food"
  if (hasAny(types, ["bar", "night_club"])) return "drink"
  if (hasAny(types, ["lodging", "hotel"])) return "hotel"
  if (hasAny(types, ["museum", "art_gallery"])) return "museum"
  if (hasAny(types, ["park", "tourist_attraction"])) return "park"
  if (hasAny(types, ["gas_station"])) return "gas"
  if (hasAny(types, ["airport"])) return "airport"
  if (hasAny(types, ["shopping_mall", "store", "supermarket"]))
    return "shopping"
  if (
    hasAny(types, [
      "bus_station",
      "transit_station",
      "train_station",
      "subway_station",
    ])
  )
    return "transport"
  return "default"
}

function hasAny(types: Set<string | null>, wanted: string[]): boolean {
  return wanted.some((type) => types.has(type))
}

function stablePinId(placeId: string): string {
  return `place-${
    placeId
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 56) || "result"
  }`
}

function choosePlacePhoto(
  photos: GooglePlacePhoto[] | undefined
): GooglePlacePhoto | null {
  if (!Array.isArray(photos) || photos.length === 0) return null
  return (
    photos
      .filter((photo) => Boolean(cleanString(photo.name)))
      .sort((a, b) => {
        const aArea =
          (finiteNumber(a.widthPx) ?? 0) * (finiteNumber(a.heightPx) ?? 0)
        const bArea =
          (finiteNumber(b.widthPx) ?? 0) * (finiteNumber(b.heightPx) ?? 0)
        return bArea - aArea
      })[0] ?? null
  )
}

function normalizePhotoAttributions(
  value: GooglePlacePhotoAttribution[] | undefined
): PlacePhotoAttribution[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => ({
    displayName: cleanString(item.displayName),
    uri: cleanString(item.uri),
    photoUri: cleanString(item.photoUri),
  }))
}

function normalizeOpeningHours(
  value: GooglePlaceOpeningHours | undefined
): PlaceOpeningHours | null {
  if (!value) return null
  const weekdayDescriptions = Array.isArray(value.weekdayDescriptions)
    ? value.weekdayDescriptions
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, 14)
    : []
  const openNow = typeof value.openNow === "boolean" ? value.openNow : null
  if (openNow === null && weekdayDescriptions.length === 0) return null
  return { openNow, weekdayDescriptions }
}

function bboxForPlaces(places: PlaceResult[]): MapBBox | null {
  if (places.length === 0) return null
  let west = places[0].position[0]
  let east = places[0].position[0]
  let south = places[0].position[1]
  let north = places[0].position[1]
  for (const place of places) {
    const [lng, lat] = place.position
    west = Math.min(west, lng)
    east = Math.max(east, lng)
    south = Math.min(south, lat)
    north = Math.max(north, lat)
  }
  return [west, south, east, north]
}

function googleLatLng(position: MapCoordinate): {
  latitude: number
  longitude: number
} {
  return {
    longitude: position[0],
    latitude: position[1],
  }
}

function parseNearbyRankPreference(
  value: PlacesRankPreference | undefined
): string | null {
  if (value === "distance") return "DISTANCE"
  if (value === "popularity") return "POPULARITY"
  return null
}

function parseTextRankPreference(
  value: PlacesRankPreference | undefined
): string | null {
  if (value === "distance") return "DISTANCE"
  if (value === "relevance") return "RELEVANCE"
  return null
}

function clampRadius(value: number): number {
  const radius = Math.floor(Number(value))
  if (!Number.isFinite(radius)) return 2500
  return Math.max(1, Math.min(radius, 50_000))
}

function clampInt(value: number, min: number, max: number): number {
  const parsed = Math.floor(Number(value))
  if (!Number.isFinite(parsed)) return min
  return Math.max(min, Math.min(parsed, max))
}

function cleanString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function cleanStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 50)
}

function finiteNumber(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}
