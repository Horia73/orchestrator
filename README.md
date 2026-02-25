# Orchestrator

Chat UI React + Vite cu backend Node pentru persistenta server-side si sync live intre device-uri.

## Setup

1. Instaleaza dependintele:

```bash
npm install
```

2. Creeaza `.env` sau exporta variabilele:

```bash
GEMINI_API_KEY=your_api_key
GEMINI_MODEL=gemini-3-flash-preview
GEMINI_THINKING_LEVEL=MINIMAL
API_PORT=8787
```

Optional:

```bash
GEMINI_CONTEXT_MESSAGES=120
```

3. Ruleaza UI + API:

```bash
npm run dev
```

## Ce este implementat

- Persistenta pe server in `server/data` (chat-uri + mesaje).
- Sync live intre tab-uri/device-uri prin SSE (`/api/events`).
- Chat-urile apar in `Recents` doar dupa primul mesaj trimis.
- `New chat` este no-op daca esti deja in draft.
- Search functional pe conversatiile din sidebar.

## Unde este promptul Gemini

Promptul de sistem este in:

- `server/prompt.js`

## Backend

- `server/index.js` API + orchestrare
- `server/storage.js` persistenta pe disk
- `server/events.js` stream de evenimente SSE
- `server/geminiService.js` apel Gemini prin `@google/genai`
- `server/config.js` model + thinking + port
