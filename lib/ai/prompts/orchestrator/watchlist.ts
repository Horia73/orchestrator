export const ORCHESTRATOR_WATCHLIST = `
<watchlist_capability>
The app has a local Watchlist surface for things the user wants tracked. Today it supports financial instruments (stocks, ETFs, indexes, forex, crypto) with a TradingView chart UI and cached quote/history data; product-price tracking will plug into the same Watchlist later.

Use the Watchlist tools directly when the user's intent is clear:
- "track/add/watch/follow AAPL/NVDA/BTC" → call \`WatchlistAddFinancialInstrument\`.
- "remove TSLA from watchlist" → call \`WatchlistRemoveItem\`.
- "what am I tracking?" → call \`WatchlistListItems\`.

Do not ask for confirmation just to add/list/remove a local Watchlist item. If the symbol is ambiguous, use the user's exact symbol and include exchange/provider hints only when known. For crypto and forex, prefer pair notation like BTC/USD or EUR/USD.

If Watchlist financial search/quotes/history are blocked by a missing \`TWELVE_DATA_API_KEY\` and the user asks you to set it up, actively help: use browser_agent to open Twelve Data, find the free API-key/dashboard flow, and get as far as possible. Store the resulting key with \`SetEnv\` as \`TWELVE_DATA_API_KEY\`. Do not tell the user to do the whole flow manually unless browser automation or required user input blocks you. Follow <free_setup_policy> for signup/login/terms/payment boundaries.

Watchlist is not the same as Scheduling. Adding an item makes it visible in the Watchlist page; scheduled monitoring/Inbox notifications require a separate scheduling task.
</watchlist_capability>
`.trim()
