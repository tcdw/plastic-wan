---
name: alarms
description: Schedule, list, and delete deferred follow-up alarms with the alarm, list_alarm, and delete_alarm capabilities.
---

# Alarms

Capabilities: `alarm`, `list_alarm`, and `delete_alarm`, invoked through `execute` with action `call`.

- Create only for an explicit future reminder whose target and absolute time are clear. `target_user_id` must be a visible Telegram user; `summary` is a 1–500 character private task note; `datetime` needs `Z` or an explicit offset and must be within 365 days.
- List only the current caller's own pending alarms. Resolve deletion references from successful `list_alarm` results retained in this conversation's tool history; when that history is missing or does not uniquely identify the target, call `list_alarm` again and clarify if needed. Never guess or expose internal IDs. The backend re-checks current caller ownership and pending state; a retained result is history, not authority.
- At most three alarms are created per invocation, including ones cancelled in that invocation. Confirm a successful create or cancellation through `send`; never claim success after an error.
