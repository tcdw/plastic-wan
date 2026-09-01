import { sql } from 'drizzle-orm';
import {
  check,
  customType,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
} from 'drizzle-orm/sqlite-core';

/**
 * SQLite INTEGER column that maps to TypeScript `bigint`.
 *
 * drizzle's SQLite dialect has no built-in bigint mode, so this custom type
 * keeps the project invariant that SQLite row IDs and Telegram IDs are
 * `bigint` on both read and write. `bun:sqlite` accepts bigint bindings
 * natively; `fromDriver` also coerces plain numbers so the layer stays correct
 * regardless of the driver's safeIntegers setting.
 */
export const sqliteBigInt = customType<{ data: bigint; driverData: bigint | number }>({
  dataType: () => 'integer',
  toDriver: (value) => value,
  fromDriver: (value) => BigInt(value),
});

/**
 * `sqliteBigInt` for INTEGER PRIMARY KEY columns. SQLite assigns rowids to
 * these columns automatically, so inserts may omit the value; the `default`
 * marker teaches drizzle's insert types that the column is optional. It never
 * emits a DEFAULT clause at runtime.
 */
export const sqliteBigIntId = customType<{
  data: bigint;
  driverData: bigint | number;
  default: true;
}>({
  dataType: () => 'integer',
  toDriver: (value) => value,
  fromDriver: (value) => BigInt(value),
});

/**
 * Drizzle schema for the Plastic Wan SQLite database.
 *
 * The authoritative DDL lives in `src/migrations/*.sql`. This file is the
 * typed query-layer mapping for drizzle-orm: table and column names must
 * match the migration end state exactly. When you add a migration, update
 * this file in the same change and keep both in sync.
 *
 * Conventions:
 * - INTEGER identity/reference/count columns use `sqliteBigInt`; SQLite row
 *   IDs are `bigint` everywhere in this codebase.
 * - 0/1 flag columns use `integer(..., { mode: 'boolean' })`.
 * - The `sticker_search` FTS5 virtual table is intentionally not declared
 *   here; drizzle cannot express virtual tables. Query it through `sql`
 *   templates.
 * - WITHOUT ROWID tables are declared with composite primary keys only;
 *   the rowid setting itself stays in the SQL migrations.
 */

export const schemaMigrations = sqliteTable('schema_migrations', {
  version: sqliteBigIntId('version').primaryKey(),
  appliedAt: text('applied_at').notNull(),
});

export const appState = sqliteTable('app_state', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const telegramUpdates = sqliteTable(
  'telegram_updates',
  {
    updateId: sqliteBigIntId('update_id').primaryKey(),
    chatId: sqliteBigInt('chat_id'),
    chatType: text('chat_type'),
    receivedAt: text('received_at').notNull(),
    allowed: integer('allowed', { mode: 'boolean' }).notNull(),
    rejectionReason: text('rejection_reason'),
    rawJson: text('raw_json'),
  },
  () => [
    check(
      'telegram_updates_allowed_raw_json',
      sql`(allowed = 1 AND raw_json IS NOT NULL) OR (allowed = 0 AND raw_json IS NULL)`,
    ),
  ],
);

export const chats = sqliteTable('chats', {
  id: sqliteBigIntId('id').primaryKey(),
  telegramChatId: sqliteBigInt('telegram_chat_id').notNull().unique(),
  canonicalChatId: sqliteBigInt('canonical_chat_id').notNull(),
  type: text('type').notNull(),
  title: text('title'),
  username: text('username'),
  updatedAt: text('updated_at').notNull(),
});

export const chatMigrations = sqliteTable('chat_migrations', {
  oldChatId: sqliteBigIntId('old_chat_id').primaryKey(),
  newChatId: sqliteBigInt('new_chat_id').notNull().unique(),
  receivedAt: text('received_at').notNull(),
});

export const conversations = sqliteTable(
  'conversations',
  {
    id: sqliteBigIntId('id').primaryKey(),
    chatId: sqliteBigInt('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    messageThreadId: sqliteBigInt('message_thread_id').notNull().default(0n),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [uniqueIndex('conversations_chat_thread_unique').on(t.chatId, t.messageThreadId)],
);

export const senders = sqliteTable(
  'senders',
  {
    id: sqliteBigIntId('id').primaryKey(),
    telegramType: text('telegram_type').notNull(),
    telegramId: sqliteBigInt('telegram_id').notNull(),
    displayName: text('display_name').notNull(),
    username: text('username'),
    isBot: integer('is_bot', { mode: 'boolean' }).notNull().default(false),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    check('senders_telegram_type_check', sql`telegram_type IN ('user', 'sender_chat')`),
    uniqueIndex('senders_telegram_type_id_unique').on(t.telegramType, t.telegramId),
  ],
);

export const messages = sqliteTable(
  'messages',
  {
    id: sqliteBigIntId('id').primaryKey(),
    conversationId: sqliteBigInt('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    chatId: sqliteBigInt('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    telegramMessageId: sqliteBigInt('telegram_message_id').notNull(),
    currentRevisionId: sqliteBigInt('current_revision_id').references((): AnySQLiteColumn => messageRevisions.id),
    visible: integer('visible', { mode: 'boolean' }).notNull().default(true),
    sentByBot: integer('sent_by_bot', { mode: 'boolean' }).notNull().default(false),
    telegramDate: text('telegram_date').notNull(),
    receivedAt: text('received_at').notNull(),
  },
  (t) => [uniqueIndex('messages_chat_telegram_unique').on(t.chatId, t.telegramMessageId)],
);

export const messageRevisions = sqliteTable(
  'message_revisions',
  {
    id: sqliteBigIntId('id').primaryKey(),
    messageId: sqliteBigInt('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    revisionNo: sqliteBigInt('revision_no').notNull(),
    senderId: sqliteBigInt('sender_id'),
    kind: text('kind').notNull(),
    text: text('text'),
    caption: text('caption'),
    replyToMessageId: sqliteBigInt('reply_to_message_id'),
    replySnapshotJson: text('reply_snapshot_json'),
    forwardOriginJson: text('forward_origin_json'),
    mediaGroupId: text('media_group_id'),
    serviceJson: text('service_json'),
    createdAt: text('created_at').notNull(),
    rawFragmentJson: text('raw_fragment_json').notNull(),
  },
  (t) => [uniqueIndex('message_revisions_message_revision_unique').on(t.messageId, t.revisionNo)],
);

export const media = sqliteTable(
  'media',
  {
    id: sqliteBigIntId('id').primaryKey(),
    revisionId: sqliteBigInt('revision_id')
      .notNull()
      .references(() => messageRevisions.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    fileId: text('file_id').notNull(),
    fileUniqueId: text('file_unique_id').notNull(),
    mimeType: text('mime_type'),
    fileSize: sqliteBigInt('file_size'),
    width: sqliteBigInt('width'),
    height: sqliteBigInt('height'),
    telegramJson: text('telegram_json').notNull(),
  },
  (t) => [
    check('media_kind_check', sql`kind IN ('photo', 'document', 'sticker')`),
    index('media_revision_idx').on(t.revisionId),
    index('media_unique_idx').on(t.fileUniqueId),
  ],
);

export const buckets = sqliteTable(
  'buckets',
  {
    id: sqliteBigIntId('id').primaryKey(),
    conversationId: sqliteBigInt('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    state: text('state').notNull(),
    kind: text('kind').notNull().default('realtime'),
    firstReceivedAt: text('first_received_at').notNull(),
    deadlineAt: text('deadline_at').notNull(),
    queuedAt: text('queued_at'),
    startedAt: text('started_at'),
    finishedAt: text('finished_at'),
    mergedIntoBucketId: sqliteBigInt('merged_into_bucket_id').references((): AnySQLiteColumn => buckets.id),
    errorCode: text('error_code'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    check(
      'buckets_state_check',
      sql`state IN ('collecting', 'queued', 'running', 'completed', 'failed', 'aborted', 'outcome_unknown', 'merged', 'expired', 'skipped_budget')`,
    ),
    check('buckets_kind_check', sql`kind IN ('realtime', 'startup_catch_up')`),
    uniqueIndex('one_collecting_bucket_per_conversation').on(t.conversationId).where(sql`state = 'collecting'`),
    index('buckets_schedule_idx').on(t.state, t.deadlineAt, t.id),
  ],
);

export const bucketMessages = sqliteTable(
  'bucket_messages',
  {
    bucketId: sqliteBigInt('bucket_id')
      .notNull()
      .references(() => buckets.id, { onDelete: 'cascade' }),
    messageId: sqliteBigInt('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    sequenceNo: sqliteBigInt('sequence_no').notNull(),
    sourceBucketId: sqliteBigInt('source_bucket_id'),
  },
  (t) => [
    primaryKey({ columns: [t.bucketId, t.messageId] }),
    uniqueIndex('bucket_messages_bucket_sequence_unique').on(t.bucketId, t.sequenceNo),
  ],
);

export const invocations = sqliteTable(
  'invocations',
  {
    id: sqliteBigIntId('id').primaryKey(),
    bucketId: sqliteBigInt('bucket_id')
      .notNull()
      .references(() => buckets.id),
    conversationId: sqliteBigInt('conversation_id')
      .notNull()
      .references(() => conversations.id),
    state: text('state').notNull(),
    configHash: text('config_hash').notNull(),
    promptVersion: sqliteBigInt('prompt_version').notNull(),
    toolRegistryHash: text('tool_registry_hash'),
    toolRegistryJson: text('tool_registry_json'),
    startedAt: text('started_at'),
    finishedAt: text('finished_at'),
    completionReason: text('completion_reason'),
    errorCode: text('error_code'),
    sendsUsed: sqliteBigInt('sends_used').notNull().default(0n),
    toolCallsUsed: sqliteBigInt('tool_calls_used').notNull().default(0n),
    turnsUsed: sqliteBigInt('turns_used').notNull().default(0n),
    sideEffectStarted: integer('side_effect_started', { mode: 'boolean' }).notNull().default(false),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    check(
      'invocations_state_check',
      sql`state IN ('queued', 'running', 'completed', 'failed', 'aborted', 'outcome_unknown', 'skipped_budget')`,
    ),
    uniqueIndex('one_running_invocation_per_conversation').on(t.conversationId).where(sql`state = 'running'`),
    index('invocations_queue_idx').on(t.state, t.id),
  ],
);

export const invocationMessages = sqliteTable(
  'invocation_messages',
  {
    invocationId: sqliteBigInt('invocation_id')
      .notNull()
      .references(() => invocations.id, { onDelete: 'cascade' }),
    messageId: sqliteBigInt('message_id')
      .notNull()
      .references(() => messages.id),
    revisionId: sqliteBigInt('revision_id')
      .notNull()
      .references(() => messageRevisions.id),
    section: text('section').notNull(),
    sequenceNo: sqliteBigInt('sequence_no').notNull(),
    sourceBucketId: sqliteBigInt('source_bucket_id'),
    omittedBefore: sqliteBigInt('omitted_before').notNull().default(0n),
    snapshotJson: text('snapshot_json').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.invocationId, t.sequenceNo] }),
    check('invocation_messages_section_check', sql`section IN ('history', 'new')`),
  ],
);

export const modelCalls = sqliteTable(
  'model_calls',
  {
    id: sqliteBigIntId('id').primaryKey(),
    invocationId: sqliteBigInt('invocation_id').references(() => invocations.id, {
      onDelete: 'cascade',
    }),
    mediaAnalysisId: sqliteBigInt('media_analysis_id'),
    role: text('role').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    attempt: sqliteBigInt('attempt').notNull(),
    state: text('state').notNull(),
    inputTokens: sqliteBigInt('input_tokens'),
    outputTokens: sqliteBigInt('output_tokens'),
    cacheReadTokens: sqliteBigInt('cache_read_tokens'),
    cacheWriteTokens: sqliteBigInt('cache_write_tokens'),
    totalTokens: sqliteBigInt('total_tokens'),
    cost: real('cost'),
    durationMs: sqliteBigInt('duration_ms'),
    errorCode: text('error_code'),
    errorDetail: text('error_detail'),
    toolsJson: text('tools_json'),
    requestJson: text('request_json'),
    responseJson: text('response_json'),
    createdAt: text('created_at').notNull(),
    finishedAt: text('finished_at'),
  },
  () => [
    check('model_calls_role_check', sql`role IN ('agent', 'vision_chat', 'vision_sticker', 'doctor')`),
    check(
      'model_calls_state_check',
      sql`state IN ('pending', 'success', 'error', 'outcome_unknown', 'blocked_budget')`,
    ),
  ],
);

export const agentMessages = sqliteTable(
  'agent_messages',
  {
    id: sqliteBigIntId('id').primaryKey(),
    invocationId: sqliteBigInt('invocation_id')
      .notNull()
      .references(() => invocations.id, { onDelete: 'cascade' }),
    sequenceNo: sqliteBigInt('sequence_no').notNull(),
    role: text('role').notNull(),
    text: text('text').notNull(),
    thinkingText: text('thinking_text').notNull().default(''),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    check('agent_messages_role_check', sql`role IN ('assistant', 'tool_result', 'harness_nudge')`),
    uniqueIndex('agent_messages_invocation_sequence_unique').on(t.invocationId, t.sequenceNo),
    check('agent_messages_thinking_empty_check', sql`thinking_text = ''`),
  ],
);

export const toolCalls = sqliteTable(
  'tool_calls',
  {
    id: sqliteBigIntId('id').primaryKey(),
    invocationId: sqliteBigInt('invocation_id')
      .notNull()
      .references(() => invocations.id, { onDelete: 'cascade' }),
    toolCallId: text('tool_call_id').notNull().unique(),
    toolName: text('tool_name').notNull(),
    argumentsJson: text('arguments_json').notNull(),
    resultText: text('result_text'),
    state: text('state').notNull(),
    sideEffect: integer('side_effect', { mode: 'boolean' }).notNull(),
    errorCode: text('error_code'),
    durationMs: sqliteBigInt('duration_ms'),
    createdAt: text('created_at').notNull(),
    finishedAt: text('finished_at'),
  },
  () => [
    check('tool_calls_state_check', sql`state IN ('pending', 'success', 'error', 'outcome_unknown', 'blocked_budget')`),
  ],
);

export const telegramSends = sqliteTable(
  'telegram_sends',
  {
    id: sqliteBigIntId('id').primaryKey(),
    toolCallId: sqliteBigInt('tool_call_id')
      .notNull()
      .references(() => toolCalls.id),
    conversationId: sqliteBigInt('conversation_id')
      .notNull()
      .references(() => conversations.id),
    kind: text('kind').notNull(),
    requestJson: text('request_json').notNull(),
    state: text('state').notNull(),
    telegramMessageId: sqliteBigInt('telegram_message_id'),
    responseJson: text('response_json'),
    errorCode: text('error_code'),
    createdAt: text('created_at').notNull(),
    finishedAt: text('finished_at'),
  },
  () => [
    check('telegram_sends_kind_check', sql`kind IN ('text', 'sticker')`),
    check('telegram_sends_state_check', sql`state IN ('pending', 'success', 'error', 'outcome_unknown')`),
  ],
);

export const mediaAnalyses = sqliteTable(
  'media_analyses',
  {
    id: sqliteBigIntId('id').primaryKey(),
    fileUniqueId: text('file_unique_id').notNull(),
    analysisVersion: text('analysis_version').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    promptVersion: sqliteBigInt('prompt_version').notNull(),
    kind: text('kind').notNull(),
    state: text('state').notNull(),
    description: text('description'),
    metadataJson: text('metadata_json'),
    expiresAt: text('expires_at'),
    failureCount: sqliteBigInt('failure_count').notNull().default(0n),
    nextRetryAt: text('next_retry_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    check('media_analyses_kind_check', sql`kind IN ('image', 'sticker')`),
    check('media_analyses_state_check', sql`state IN ('pending', 'success', 'error')`),
    uniqueIndex('media_analyses_file_version_unique').on(t.fileUniqueId, t.analysisVersion),
  ],
);

export const stickerSets = sqliteTable(
  'sticker_sets',
  {
    id: sqliteBigIntId('id').primaryKey(),
    alias: text('alias').notNull().unique(),
    telegramName: text('telegram_name').notNull().unique(),
    title: text('title'),
    configured: integer('configured', { mode: 'boolean' }).notNull().default(true),
    syncState: text('sync_state').notNull().default('pending'),
    lastSyncedAt: text('last_synced_at'),
    errorCode: text('error_code'),
    updatedAt: text('updated_at').notNull(),
  },
  () => [check('sticker_sets_sync_state_check', sql`sync_state IN ('pending', 'running', 'success', 'error')`)],
);

export const stickers = sqliteTable(
  'stickers',
  {
    id: sqliteBigIntId('id').primaryKey(),
    stickerSetId: sqliteBigInt('sticker_set_id')
      .notNull()
      .references(() => stickerSets.id, { onDelete: 'cascade' }),
    fileUniqueId: text('file_unique_id').notNull().unique(),
    fileId: text('file_id').notNull(),
    emoji: text('emoji'),
    format: text('format').notNull(),
    thumbnailJson: text('thumbnail_json'),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    currentAnalysisId: sqliteBigInt('current_analysis_id').references(() => mediaAnalyses.id),
    indexState: text('index_state').notNull().default('pending'),
    failureCount: sqliteBigInt('failure_count').notNull().default(0n),
    nextRetryAt: text('next_retry_at'),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    check('stickers_format_check', sql`format IN ('static', 'animated', 'video')`),
    check('stickers_index_state_check', sql`index_state IN ('pending', 'running', 'success', 'error')`),
    index('stickers_index_queue_idx').on(t.active, t.indexState, t.nextRetryAt, t.id),
  ],
);

export const dailyUsage = sqliteTable(
  'daily_usage',
  {
    utcDate: text('utc_date').notNull(),
    scope: text('scope').notNull(),
    resource: text('resource').notNull(),
    metric: text('metric').notNull(),
    amount: sqliteBigInt('amount').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.utcDate, t.scope, t.resource, t.metric] })],
);

export const mcpServerState = sqliteTable(
  'mcp_server_state',
  {
    alias: text('alias').primaryKey(),
    state: text('state').notNull(),
    registryHash: text('registry_hash'),
    reconnectAttempt: sqliteBigInt('reconnect_attempt').notNull().default(0n),
    nextReconnectAt: text('next_reconnect_at'),
    errorCode: text('error_code'),
    updatedAt: text('updated_at').notNull(),
  },
  () => [check('mcp_server_state_check', sql`state IN ('starting', 'ready', 'degraded', 'stopped')`)],
);

export const adminUsers = sqliteTable('admin_users', {
  id: sqliteBigIntId('id').primaryKey(),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  lastLoginAt: text('last_login_at'),
});

export const adminSessions = sqliteTable(
  'admin_sessions',
  {
    id: sqliteBigIntId('id').primaryKey(),
    userId: sqliteBigInt('user_id')
      .notNull()
      .references(() => adminUsers.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    createdAt: text('created_at').notNull(),
    expiresAt: text('expires_at').notNull(),
    lastSeenAt: text('last_seen_at').notNull(),
  },
  (t) => [index('admin_sessions_expiry_idx').on(t.expiresAt)],
);

export const memories = sqliteTable(
  'memories',
  {
    id: text('id').primaryKey(),
    conversationId: sqliteBigInt('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    content: text('content').notNull(),
    createdAt: text('created_at').notNull(),
    expiresAt: text('expires_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    check('memories_content_length_check', sql`length(content) BETWEEN 1 AND 150`),
    check('memories_expiry_check', sql`expires_at > created_at`),
    index('memories_conversation_created_idx').on(t.conversationId, t.createdAt),
    index('memories_expiry_idx').on(t.expiresAt),
  ],
);

export const chatPause = sqliteTable('chat_pause', {
  chatId: sqliteBigIntId('chat_id')
    .primaryKey()
    .references(() => chats.id, { onDelete: 'cascade' }),
  pausedAt: text('paused_at').notNull(),
});

export const botAdmins = sqliteTable('bot_admins', {
  telegramUserId: sqliteBigIntId('telegram_user_id').primaryKey(),
  displayName: text('display_name').notNull().default(''),
  addedBy: text('added_by').notNull().default(''),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const chatContextCutoffs = sqliteTable('chat_context_cutoffs', {
  chatId: sqliteBigIntId('chat_id')
    .primaryKey()
    .references(() => chats.id, { onDelete: 'cascade' }),
  telegramMessageId: sqliteBigInt('telegram_message_id').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const alarms = sqliteTable(
  'alarms',
  {
    id: sqliteBigIntId('id').primaryKey(),
    conversationId: sqliteBigInt('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    targetUserId: sqliteBigInt('target_user_id').notNull(),
    targetDisplayName: text('target_display_name').notNull(),
    summary: text('summary').notNull(),
    scheduledAt: text('scheduled_at').notNull(),
    createdAt: text('created_at').notNull(),
    createdByInvocationId: sqliteBigInt('created_by_invocation_id').references(() => invocations.id, {
      onDelete: 'set null',
    }),
    state: text('state').notNull(),
    firedAt: text('fired_at'),
    invocationId: sqliteBigInt('invocation_id').references(() => invocations.id, {
      onDelete: 'set null',
    }),
    invocationOutcome: text('invocation_outcome'),
    completionReason: text('completion_reason'),
    cancelledAt: text('cancelled_at'),
    cancelledBy: text('cancelled_by'),
    adminCancelled: integer('admin_cancelled', { mode: 'boolean' }).notNull().default(false),
    cancelReason: text('cancel_reason'),
    updatedAt: text('updated_at').notNull(),
    createdByUserId: sqliteBigInt('created_by_user_id'),
  },
  (t) => [
    check('alarms_target_user_id_check', sql`target_user_id > 0`),
    check('alarms_summary_length_check', sql`length(summary) BETWEEN 1 AND 500`),
    check('alarms_state_check', sql`state IN ('pending', 'firing', 'fired', 'cancelled')`),
    check('alarms_schedule_check', sql`scheduled_at > created_at`),
    index('alarms_schedule_idx').on(t.state, t.scheduledAt, t.id),
    index('alarms_invocation_idx').on(t.invocationId),
    index('alarms_created_by_idx').on(t.createdByInvocationId),
    index('alarms_created_by_user_pending_idx')
      .on(t.conversationId, t.createdByUserId, t.scheduledAt, t.id)
      .where(sql`state = 'pending' AND created_by_user_id IS NOT NULL`),
  ],
);

export const internalContexts = sqliteTable(
  'internal_contexts',
  {
    id: sqliteBigIntId('id').primaryKey(),
    conversationId: sqliteBigInt('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    invocationId: sqliteBigInt('invocation_id')
      .notNull()
      .references(() => invocations.id, { onDelete: 'cascade' }),
    sourceAgentMessageId: sqliteBigInt('source_agent_message_id').references(() => agentMessages.id, {
      onDelete: 'set null',
    }),
    kind: text('kind').notNull(),
    version: sqliteBigInt('version').notNull(),
    observedAt: text('observed_at').notNull(),
    payloadJson: text('payload_json').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    check('internal_contexts_version_check', sql`version > 0`),
    index('internal_contexts_conversation_idx').on(t.conversationId, sql`observed_at DESC`, sql`id DESC`),
    index('internal_contexts_invocation_idx').on(t.invocationId),
  ],
);
