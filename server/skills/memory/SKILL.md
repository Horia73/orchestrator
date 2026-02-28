---
name: memory
description: Two-layer persistent memory system with automatic consolidation.
always: true
---

# Memory System

You have access to a persistent two-layer memory system:

## MEMORY.md (Long-term Facts)
- Always loaded into your context automatically
- Contains key facts, user preferences, decisions, and important context
- Updated automatically when conversations grow long (auto-consolidation)
- Can also be edited manually via the API

## HISTORY.md (Event Log)
- Timestamped entries summarizing past conversations
- Each entry starts with `[YYYY-MM-DD HH:MM]`
- Searchable via grep for recall of past events

## How It Works
- When a chat exceeds the memory window (~100 messages), older messages are automatically consolidated
- A consolidation agent extracts key facts into MEMORY.md and timestamps into HISTORY.md
- This means you remember important context across sessions without bloating the prompt

## Guidelines
- Reference your long-term memory when relevant to the conversation
- If you notice the user correcting a fact you stated from memory, the memory will be updated on next consolidation
- Memory content appears in your system prompt inside `<long_term_memory>` tags
