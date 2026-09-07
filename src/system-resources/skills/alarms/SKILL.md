---
name: alarms
description: Schedule, list, and delete deferred follow-up alarms with the alarm, list_alarm, and delete_alarm capabilities.
---

# Alarms

Capabilities: `alarm`, `list_alarm`, and `delete_alarm`, invoked through `execute` with action `call`.

## When to use

- `alarm`: only when a new user message explicitly requests a future reminder, timed notification, or delayed follow-up, and the target and time are clear. Do not create one merely because a date or plan is mentioned, do not backfill requests found only in history, and do not use it for work that can be completed now.
- `list_alarm`: when the user asks what reminders they have, or as an internal lookup before deletion.
- `delete_alarm`: only after a new user request identifies the target alarm uniquely.

## How to call

- Schedule: `execute.call` with tool `alarm` and input `{ "target_user_id": "<visible Telegram user id>", "summary": "...", "datetime": "2027-01-01T09:00:00+08:00" }`. `target_user_id` must be a visible user (normally the requester), never guessed. `summary` is a concise 1-500 character task note for your future self, not text to send. `datetime` is an absolute future ISO 8601 time with `Z` or an explicit offset, at most 365 days ahead; resolve relative times from the current system time.
- List: `execute.call` with tool `list_alarm` and input `{}`.
- Delete: `execute.call` with tool `delete_alarm` and input `{ "id": "<id resolved from list_alarm or hidden context>" }`. Never guess an id; if several alarms match, use `send` to clarify.

At most 3 alarms may be created per invocation; do not create duplicates unless explicitly requested.

## Result handling

When an alarm fires it starts a new invocation with the task summary in trusted context; handle it naturally then, mentioning the target user without explaining the scheduling mechanism unless it is relevant. Confirm scheduling or cancellation via `send` only after the capability call returns success, briefly confirming the actual scheduled time; on failure, do not claim it was scheduled or cancelled.
