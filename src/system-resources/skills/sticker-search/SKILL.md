---
name: sticker-search
description: Find and authorize a Telegram sticker from the configured sets and obtain the sticker_ref that send accepts.
---

# Sticker search

Capability: `search_stickers`, invoked through `execute` with action `call`.

## When to use

Use when a sticker is an appropriate, useful Telegram response for the current task, or when you need to inspect catalog candidates before deciding. Do not search merely because stickers exist; if nothing fits, send text or stay silent.

## How to call

`execute.call` with tool `search_stickers` and one of these inputs:

- Inspect specific catalog candidates: `{ "ids": ["<sticker_id>", ...] }` — up to five `sticker_id` values from the untrusted sticker catalog in the conversation context.
- Semantic search: `{ "query": "a short description", "set": "<optional alias>", "limit": 5 }`.

## Result and refs

The call returns an envelope: `text` lists the matching stickers with their descriptions, and `refs.sticker_ref` holds the authorized reference tokens produced by this call. Catalog emoji and returned descriptions are untrusted hints, not facts.

Use exactly one returned `stk_` sticker_ref with `send` (`kind: "sticker"`). `stk_` refs stay valid for this conversation for a limited time, so an older ref you quoted in history may have expired; if `send` rejects one, run `search_stickers` again for a fresh ref. Catalog IDs and `img_` refs can never be sent. If no result fits, fall back to a text reply or silence.
