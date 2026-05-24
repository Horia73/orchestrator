# Smart Maps Roadmap

Last updated: 2026-05-22

## Current Status

- Map rendering, Smart Maps page, saved maps, saved places, saved areas, browser geolocation fallback, Home Assistant location-source setup, Google Places search, route directions, local stop-order optimization, polygon draw/save/research handoff, pin save/draft actions, Static Maps endpoint, and Static Maps disk cache are implemented.
- Calendar, Gmail, WhatsApp, Home Assistant, researcher, errands, and trip-planner map composition are covered by the Maps doctrine/prompting. They do not need dedicated code unless we want first-class UI buttons, fixed workflows, or background automations.
- Only the orchestrator has Maps tools. Other agents return structured geographic data; the orchestrator paints the map.

## Done By Prompting

- Calendar -> Map: list events, geocode event locations, paint pins/days.
- Gmail -> Map: search/read confirmations, extract addresses/datetimes, geocode, group into trip days.
- WhatsApp -> Map: read/search relevant chats, extract shared places/links, geocode or parse coordinates, paint pins.
- Home Assistant -> Map: read device trackers/zones, paint live-location pins and zone overlays.
- Researcher -> Map: researcher returns ranked places with coordinates/rationale; orchestrator validates and renders.
- Trip planner composition: delegate research by category, group itinerary into `days[]`, call `MapRender`.

## Needs Code

- Click-to-act direct dispatch: Calendar/WhatsApp/Research actions currently draft a chat prompt from the pin. Direct tool execution still needs host-side dispatch, confirmation state, and audit handling.
- Polygon research direct pipeline: draw/save/copy/new-chat handoff exists. Automatic researcher execution and automatic MapRender update still need orchestration code or a dedicated tool.
- Static maps in Inbox/Smart Monitor: PNG endpoint and cache exist. `notify_inbox` does not yet accept/render map thumbnails.
- Morning commute monitor: needs monitor config, route polling, traffic-aware ETA logic, and Inbox notification with static map thumbnail.
- Live transit layer: Cluj GTFS/GTFS-RT ingestion, vehicle markers, route/station layers, ETA-to-nearest-stop UI.
- Risk/incidents overlays: needs provider selection and layer schema for incidents, closures, weather alerts, protests, etc.
- Geo-temporal correlation: needs a privacy-aware index over timestamped location signals from Calendar, Gmail receipts, WhatsApp messages, photos EXIF, Home Assistant, and maps.
- Photos -> Map: needs file ingestion, EXIF GPS extraction, clustering, and map artifact generation.
- ANCPI/cadastral overlays: needs ArcGIS REST integration, coordinate projection handling, bbox queries, rate limiting, and UI layer toggles.

## Source Notes

- Cluj public transport realtime data is available through GTFS-Realtime feeds catalogued by MobilityDatabase, including vehicle positions, trip updates, and service alerts.
- ANCPI exposes ArcGIS REST services through Geoportal/INIS. Cadastral parcels support JSON/geoJSON query responses, but production use needs careful rate limiting and legal/privacy review.
- Traffic/risk overlays likely need mixed sources: Waze for Cities if eligible, commercial APIs such as TomTom/NextBillion/Azure Maps for road incidents, official weather alerts, and local news/research for non-traffic risk.

## Suggested Order

1. Integrate Static Maps thumbnails into `notify_inbox`.
2. Add Live Cluj Transit as an optional Smart Maps layer.
3. Add Morning Commute monitor using MapsCurrentLocation + Routes API + Static Maps thumbnail.
4. Add ANCPI cadastral layer behind a clear beta toggle.
5. Add direct click-to-act dispatch for Calendar and WhatsApp.
6. Add automatic polygon research execution.
7. Add risk/incidents overlays after provider choice.
8. Add geo-temporal and Photos -> Map later because they touch private history and need stronger privacy controls.
