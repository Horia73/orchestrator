---
name: cron
description: Schedule reminders and recurring tasks.
---

# Scheduling / Cron

You can create scheduled tasks using the `manage_schedule` tool.

## Actions

### Add a job
```
manage_schedule({ action: "add", name: "daily standup reminder", schedule: { cron: "0 9 * * 1-5", tz: "Europe/Bucharest" }, prompt: "Remind me about the daily standup meeting" })
```

### List all jobs
```
manage_schedule({ action: "list" })
```

### Remove a job
```
manage_schedule({ action: "remove", jobId: "..." })
```

### Enable/disable a job
```
manage_schedule({ action: "enable", jobId: "...", enabled: true/false })
```

## Schedule Types

| Type | Field | Example | Description |
|------|-------|---------|-------------|
| Interval | `every` | `{ every: 3600 }` | Run every N seconds |
| Cron | `cron` | `{ cron: "0 9 * * *", tz: "Europe/Bucharest" }` | Cron expression with optional timezone |
| One-shot | `at` | `{ at: "2026-03-01T10:00:00Z" }` | Run once at specific time (ISO 8601) |

## Common Patterns

| Natural language | Schedule |
|-----------------|----------|
| Every hour | `{ every: 3600 }` |
| Every day at 9am | `{ cron: "0 9 * * *" }` |
| Every weekday at 9am Bucharest time | `{ cron: "0 9 * * 1-5", tz: "Europe/Bucharest" }` |
| Tomorrow at 3pm UTC | `{ at: "2026-03-01T15:00:00Z" }` |
| Every 30 minutes | `{ every: 1800 }` |
| First of every month at midnight | `{ cron: "0 0 1 * *" }` |

When a scheduled job fires, its prompt is injected as a system message into its associated chat.
