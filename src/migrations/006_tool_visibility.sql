ALTER TABLE invocations ADD COLUMN tool_registry_json TEXT;
ALTER TABLE model_calls ADD COLUMN tools_json TEXT;
