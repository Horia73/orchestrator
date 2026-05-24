import type {
  MapArtifact,
  MapBBox,
  MapCoordinate,
  MapPin as MapPinType,
  MapRoute,
} from "@/lib/maps/schema"

export type MapRuntimeBasemap = "roadmap" | "satellite" | "terrain"

export interface MapRuntimeSettings {
  basemap: MapRuntimeBasemap
  satelliteLabels: boolean
  traffic: boolean
  transit: boolean
  bicycling: boolean
  earth3d: boolean
  tilt: number
  heading: number
}

export type MapActionCommand =
  | { type: "toggle-street-view"; nonce: number }
  | { type: "open-street-view"; nonce: number; position: [number, number] }
  | { type: "clear-search"; nonce: number }
  | { type: "start-area-draw"; nonce: number }
  | { type: "cancel-area-draw"; nonce: number }
  | { type: "clear-area-selection"; nonce: number }
  | { type: "undo-area-point"; nonce: number }
  | { type: "finish-area-draw"; nonce: number }
  | {
      type: "set-area-selection"
      nonce: number
      selection: MapAreaSelection
    }
  | {
      type: "recenter"
      nonce: number
      position: [number, number]
      zoom?: number
    }
  | { type: "orbit-around-center"; nonce: number }

export interface MapAreaSelection {
  ring: MapCoordinate[]
  bbox: MapBBox
  center: MapCoordinate
  areaSqKm: number | null
}

export interface MapSearchTarget {
  id: string
  nonce: number
  position: [number, number]
  label: string
  address?: string | null
  rating?: number | null
  photoUrl?: string | null
  googleMapsUri?: string | null
  websiteUri?: string | null
  sourceUrl?: string | null
  savedPlaceId?: string | null
  description?: string | null
  notes?: string | null
  userRatingCount?: number | null
  openNow?: boolean | null
  phoneNumber?: string | null
  provider?: "google-places" | "google-geocoding"
  placeId?: string | null
}

export type IframeMapArtifact = MapArtifact & {
  fitBounds?: MapBBox
}

export interface PlaceClickFallback {
  label?: string | null
  address?: string | null
  rating?: number | null
  photoUrl?: string | null
  googleMapsUri?: string | null
  websiteUri?: string | null
  sourceUrl?: string | null
  savedPlaceId?: string | null
  description?: string | null
  notes?: string | null
  userRatingCount?: number | null
  openNow?: boolean | null
  phoneNumber?: string | null
  provider?: "google-places" | "google-geocoding"
}

export interface MapIframeApi {
  /** Pan + zoom the iframe map to a pin and mark it active. */
  flyToPin: (key: string, position: [number, number]) => void
  checkStreetView: (key: string, position: [number, number]) => void
  openStreetView: (position: [number, number]) => void
  clearActive: () => void
}

export interface PinRow {
  key: string
  pin: MapPinType
  number: number
  dayLabel?: string
  /** True while the row is a freshly opened dynamic place whose details
   *  are still being fetched. The UI swaps in a skeleton for missing
   *  title/meta and replaces it once the data arrives. */
  loading?: boolean
}

export type DirectionsTravelMode =
  | "driving"
  | "walking"
  | "bicycling"
  | "transit"

export type PinActionIntent = "save" | "calendar" | "whatsapp" | "research"

export interface DirectionsPoint {
  kind: "current" | "place"
  label: string
  address?: string | null
  position?: MapCoordinate
  placeId?: string | null
  provider?: "google-places" | "google-geocoding" | null
}

export interface ResolvedDirectionsPoint {
  position: MapCoordinate
  placeId?: string | null
}

export interface DirectionsApiResponse {
  route?: MapRoute
  fitBounds?: MapBBox | null
  distanceMeters?: number | null
  durationText?: string | null
  error?: string
}

export interface DirectionsRequest {
  /** Keep the active route attached to its original destination row. */
  destinationKey?: string
  origin: DirectionsPoint
  destination: DirectionsPoint
  /** Intermediate stops between origin and destination, in visit order. */
  waypoints?: DirectionsPoint[]
  travelMode: DirectionsTravelMode
}

export interface ActiveDirections {
  destinationKey: string
  route: MapRoute
  routes: MapRoute[]
  fitBounds: MapBBox | null
  distanceMeters: number | null
  durationText: string | null
  accessDistanceMeters: number | null
  accessDurationText: string | null
  originLabel: string
  destinationLabel: string
  originPoint: DirectionsPoint
  destinationPoint: DirectionsPoint
  /** Intermediate stops between origin and destination, in visit order. */
  stops: DirectionsPoint[]
  requestedTravelMode: DirectionsTravelMode
  travelMode: DirectionsTravelMode
  navigationUrl: string
  notice: string | null
}

export interface RouteSearchSuggestion {
  id: string
  title: string
  subtitle: string | null
  query: string
  placeId: string | null
  kind: "place" | "query"
  provider: "google-places-autocomplete"
}

export interface RouteSearchResult {
  id: string
  title: string
  address: string | null
  position: MapCoordinate
  rating: number | null
  photoUrl: string | null
  googleMapsUri: string | null
  provider: "google-places" | "google-geocoding"
}

export interface PlaceDetailsApiResponse {
  place?: {
    id: string
    title: string
    address: string | null
    position: MapCoordinate
    rating: number | null
    userRatingCount?: number | null
    photoUrl: string | null
    googleMapsUri: string | null
    websiteUri: string | null
    businessStatus?: string | null
    openNow?: boolean | null
    openingHours?: string[]
    phoneNumber?: string | null
    priceLevel?: string | null
    editorialSummary?: string | null
    provider: "google-places"
  }
  error?: string
}
