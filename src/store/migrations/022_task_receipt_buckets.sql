ALTER TABLE task_receipts ADD COLUMN bucket_id INTEGER REFERENCES buckets(id) ON DELETE SET NULL;

UPDATE task_receipts
SET bucket_id = (SELECT bucket_id FROM invocations WHERE id = task_receipts.invocation_id)
WHERE invocation_id IS NOT NULL;

DROP INDEX task_receipts_invocation_unique;
CREATE INDEX task_receipts_invocation_idx ON task_receipts(invocation_id);
CREATE UNIQUE INDEX task_receipts_bucket_unique ON task_receipts(bucket_id) WHERE bucket_id IS NOT NULL;
