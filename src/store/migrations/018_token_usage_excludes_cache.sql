-- Token usage now counts only what the provider had to process fresh plus what
-- it generated: `model_tokens` (chat scope) and `vision_tokens` (sticker index)
-- no longer include cache reads or cache writes, which are audited per model
-- call instead. Cache reads are served from the provider's cached prefix, so
-- counting them made the daily meter follow cache hit rate instead of work.
--
-- Rebuild the derived rollup from the per-call audit rows for every day the
-- audit still covers, so the series has no mixed-era step. Days without audit
-- rows keep whatever they already had.
DELETE FROM daily_usage
 WHERE metric IN ('model_tokens', 'vision_tokens')
   AND utc_date IN (SELECT DISTINCT substr(COALESCE(finished_at, created_at), 1, 10) FROM model_calls);

INSERT INTO daily_usage(utc_date, scope, resource, metric, amount, updated_at)
SELECT substr(COALESCE(mc.finished_at, mc.created_at), 1, 10),
       'chat',
       CAST(ch.telegram_chat_id AS TEXT),
       'model_tokens',
       SUM(COALESCE(mc.input_tokens, 0) + COALESCE(mc.output_tokens, 0)),
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM model_calls mc
  JOIN invocations i ON i.id = mc.invocation_id
  JOIN conversations c ON c.id = i.conversation_id
  JOIN chats ch ON ch.id = c.chat_id
 WHERE mc.role IN ('agent', 'vision_chat')
 GROUP BY 1, 3;

INSERT INTO daily_usage(utc_date, scope, resource, metric, amount, updated_at)
SELECT substr(COALESCE(finished_at, created_at), 1, 10),
       'system',
       'sticker_index',
       'vision_tokens',
       SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)),
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM model_calls
 WHERE role = 'vision_sticker'
 GROUP BY 1;
