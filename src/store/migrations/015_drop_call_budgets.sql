-- The per-chat daily invocation budget and the MCP per-chat/global daily call
-- budgets are gone; nothing writes these metrics any more.
DELETE FROM daily_usage WHERE metric IN ('agent_invocations', 'tool_calls');
