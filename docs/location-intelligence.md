# Location Intelligence

Location Intelligence is an optional local subsystem. It is off by default and should only be enabled after explicit user opt-in.

## Local Flow

1. Home Assistant location update source sends events to a local webhook.
2. A microscript writes a location journal under `microscripts/<scriptId>/files/location/`.
3. A daily scheduled agent task summarizes the journal into `days/*.json`.
4. Library > Places reads local JSON files and renders a map, route approximation, stats, and stop timeline.

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
- Day lists should not expose raw points.
- Day details may include route coordinates for map display.
- Preserve a `home` label when it exists, but do not display exact home addresses in user-facing copy.
