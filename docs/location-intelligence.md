# Location Intelligence

Location Intelligence is an optional local subsystem. It is off by default and should only be enabled after explicit user opt-in.

## Local Flow

1. Home Assistant location update source sends events to a local webhook.
2. A microscript writes every raw webhook sample to `points.jsonl` under `microscripts/<scriptId>/files/location/`.
3. A daily scheduled agent task summarizes the journal into `days/*.json` without clustering sparse Home Assistant points into synthetic stops.
4. Library > Places reads local JSON files and renders a map, route approximation, stats, summarized Places, and raw observations. For raw points, apparent stays are inferred from the gap until the next webhook sample.

Supported journal files:

- `points.jsonl`
- `days/*.json`
- `routine.json`
- `place_aliases.json`

## Config

Non-secret configuration lives in workspace `config.json` under `locationIntelligence`:

```json
{
  "enabled": true,
  "source": {
    "type": "home-assistant-webhook",
    "entityId": "person.example",
    "label": "Home Assistant person entity"
  },
  "journalScriptId": "ms_...",
  "dailyTaskId": "sch_...",
  "retentionDays": 90,
  "mapsMode": "balanced"
}
```

For unlimited retention, use `"retention": "forever"` instead of `retentionDays`.

Do not store Home Assistant tokens, webhook secrets, or API keys in this config object.

## Privacy Notes

- Missing config or files must render an empty/setup state, not an error.
- Day lists expose summary counts only; day details may include route coordinates and raw observations for map display.
- Preserve a `home` label when it exists, but do not display exact home addresses in user-facing copy.
