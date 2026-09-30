-- Invocation summaries must not scan every stored request/response for each list row.
CREATE INDEX model_calls_invocation_idx ON model_calls(invocation_id);
CREATE INDEX tool_calls_invocation_idx ON tool_calls(invocation_id);
