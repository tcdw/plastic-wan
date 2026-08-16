import type { Database } from "bun:sqlite";

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 25;
const MAX_SEARCH_LENGTH = 100;

type Bindings = (string | number | bigint | null)[];

export interface Page<T> {
  readonly items: readonly T[];
  readonly next_cursor: string | null;
}

export interface ListQuery {
  readonly limit?: string | null;
  readonly cursor?: string | null;
  readonly state?: string | null;
  readonly chat?: string | null;
  readonly set?: string | null;
  readonly search?: string | null;
}

export class AdminQueryError extends Error {
  readonly status = 400;
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

interface InvocationListRow {
  readonly id: bigint;
  readonly state: string;
  readonly created_at: string;
  readonly started_at: string | null;
  readonly finished_at: string | null;
  readonly completion_reason: string | null;
  readonly error_code: string | null;
  readonly sends_used: bigint;
  readonly tool_calls_used: bigint;
  readonly turns_used: bigint;
  readonly side_effect_started: bigint;
  readonly config_hash: string;
  readonly telegram_chat_id: bigint;
  readonly chat_type: string;
  readonly chat_title: string | null;
  readonly chat_username: string | null;
  readonly message_thread_id: bigint;
  readonly tool_call_count: bigint;
  readonly total_tokens: bigint;
  readonly total_cost: number | null;
}

interface ToolCallRow {
  readonly id: bigint;
  readonly tool_call_id: string;
  readonly tool_name: string;
  readonly arguments_json: string;
  readonly result_text: string | null;
  readonly state: string;
  readonly side_effect: bigint;
  readonly error_code: string | null;
  readonly duration_ms: bigint | null;
  readonly created_at: string;
  readonly finished_at: string | null;
}

interface ModelCallRow {
  readonly id: bigint;
  readonly role: string;
  readonly provider: string;
  readonly model: string;
  readonly attempt: bigint;
  readonly state: string;
  readonly input_tokens: bigint | null;
  readonly output_tokens: bigint | null;
  readonly cache_read_tokens: bigint | null;
  readonly cache_write_tokens: bigint | null;
  readonly total_tokens: bigint | null;
  readonly cost: number | null;
  readonly duration_ms: bigint | null;
  readonly error_code: string | null;
  readonly created_at: string;
  readonly finished_at: string | null;
}

interface AgentMessageRow {
  readonly sequence_no: bigint;
  readonly role: string;
  readonly text: string;
  readonly created_at: string;
}

interface SendRow {
  readonly id: bigint;
  readonly tool_call_id: string;
  readonly kind: string;
  readonly request_json: string;
  readonly state: string;
  readonly telegram_message_id: bigint | null;
  readonly error_code: string | null;
  readonly created_at: string;
  readonly finished_at: string | null;
}

interface ContextMessageRow {
  readonly section: string;
  readonly sequence_no: bigint;
  readonly message_id: bigint;
  readonly revision_id: bigint;
  readonly omitted_before: bigint;
  readonly snapshot_json: string;
}

interface MessageListRow {
  readonly id: bigint;
  readonly telegram_message_id: bigint;
  readonly telegram_date: string;
  readonly received_at: string;
  readonly visible: bigint;
  readonly sent_by_bot: bigint;
  readonly telegram_chat_id: bigint;
  readonly chat_type: string;
  readonly chat_title: string | null;
  readonly message_thread_id: bigint;
  readonly revision_no: bigint | null;
  readonly kind: string | null;
  readonly text: string | null;
  readonly caption: string | null;
  readonly reply_to_message_id: bigint | null;
  readonly media_group_id: string | null;
  readonly sender_display_name: string | null;
  readonly sender_username: string | null;
  readonly sender_is_bot: bigint | null;
  readonly revision_count: bigint;
  readonly media_count: bigint;
}

interface RevisionRow {
  readonly id: bigint;
  readonly revision_no: bigint;
  readonly kind: string;
  readonly text: string | null;
  readonly caption: string | null;
  readonly reply_to_message_id: bigint | null;
  readonly reply_snapshot_json: string | null;
  readonly forward_origin_json: string | null;
  readonly media_group_id: string | null;
  readonly service_json: string | null;
  readonly created_at: string;
  readonly sender_display_name: string | null;
  readonly sender_username: string | null;
}

interface MediaRow {
  readonly id: bigint;
  readonly revision_id: bigint;
  readonly kind: string;
  readonly file_unique_id: string;
  readonly mime_type: string | null;
  readonly file_size: bigint | null;
  readonly width: bigint | null;
  readonly height: bigint | null;
  readonly analysis_state: string | null;
  readonly analysis_description: string | null;
}

interface StickerSetRow {
  readonly id: bigint;
  readonly alias: string;
  readonly telegram_name: string;
  readonly title: string | null;
  readonly configured: bigint;
  readonly sync_state: string;
  readonly last_synced_at: string | null;
  readonly error_code: string | null;
  readonly updated_at: string;
  readonly sticker_count: bigint;
  readonly indexed_count: bigint;
  readonly pending_count: bigint;
  readonly error_count: bigint;
}

interface StickerRow {
  readonly id: bigint;
  readonly set_alias: string;
  readonly file_unique_id: string;
  readonly emoji: string | null;
  readonly format: string;
  readonly active: bigint;
  readonly index_state: string;
  readonly failure_count: bigint;
  readonly next_retry_at: string | null;
  readonly updated_at: string;
  readonly analysis_id: bigint | null;
  readonly analysis_state: string | null;
  readonly analysis_version: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly prompt_version: bigint | null;
  readonly description: string | null;
  readonly metadata_json: string | null;
  readonly analysis_updated_at: string | null;
}

interface CountRow {
  readonly label: string;
  readonly count: bigint;
}

export function listInvocations(db: Database, query: ListQuery): Page<Record<string, unknown>> {
  const limit = parseLimit(query.limit);
  const conditions: string[] = [];
  const parameters: Bindings = [];
  appendCursor(conditions, parameters, "i.id", query.cursor);
  if (query.state !== undefined && query.state !== null && query.state.length > 0) {
    conditions.push("i.state = ?");
    parameters.push(assertToken(query.state, "state"));
  }
  if (query.chat !== undefined && query.chat !== null && query.chat.length > 0) {
    conditions.push("ch.telegram_chat_id = ?");
    parameters.push(parseId(query.chat, "chat"));
  }
  parameters.push(BigInt(limit + 1));
  const rows = db
    .query<InvocationListRow, Bindings>(
      `SELECT i.id, i.state, i.created_at, i.started_at, i.finished_at, i.completion_reason, i.error_code,
              i.sends_used, i.tool_calls_used, i.turns_used, i.side_effect_started, i.config_hash,
              ch.telegram_chat_id, ch.type AS chat_type, ch.title AS chat_title, ch.username AS chat_username,
              c.message_thread_id,
              (SELECT COUNT(*) FROM tool_calls tc WHERE tc.invocation_id = i.id) AS tool_call_count,
              (SELECT COALESCE(SUM(mc.total_tokens), 0) FROM model_calls mc WHERE mc.invocation_id = i.id) AS total_tokens,
              (SELECT SUM(mc.cost) FROM model_calls mc WHERE mc.invocation_id = i.id) AS total_cost
       FROM invocations i
       JOIN conversations c ON c.id = i.conversation_id
       JOIN chats ch ON ch.id = c.chat_id
       ${where(conditions)}
       ORDER BY i.id DESC
       LIMIT ?`,
    )
    .all(...parameters);
  return page(rows, limit, (row) => ({
    id: row.id.toString(),
    state: row.state,
    created_at: row.created_at,
    started_at: row.started_at,
    finished_at: row.finished_at,
    completion_reason: row.completion_reason,
    error_code: row.error_code,
    sends_used: Number(row.sends_used),
    tool_calls_used: Number(row.tool_calls_used),
    turns_used: Number(row.turns_used),
    side_effect_started: row.side_effect_started === 1n,
    config_hash: row.config_hash,
    chat: chatSummary(row),
    tool_call_count: Number(row.tool_call_count),
    total_tokens: Number(row.total_tokens),
    total_cost: row.total_cost,
  }));
}

export function getInvocation(db: Database, id: bigint): Record<string, unknown> | null {
  const invocation = db
    .query<InvocationListRow & { readonly prompt_version: bigint; readonly tool_registry_hash: string | null; readonly bucket_id: bigint }, [bigint]>(
      `SELECT i.id, i.state, i.created_at, i.started_at, i.finished_at, i.completion_reason, i.error_code,
              i.sends_used, i.tool_calls_used, i.turns_used, i.side_effect_started, i.config_hash,
              i.prompt_version, i.tool_registry_hash, i.bucket_id,
              ch.telegram_chat_id, ch.type AS chat_type, ch.title AS chat_title, ch.username AS chat_username,
              c.message_thread_id,
              (SELECT COUNT(*) FROM tool_calls tc WHERE tc.invocation_id = i.id) AS tool_call_count,
              (SELECT COALESCE(SUM(mc.total_tokens), 0) FROM model_calls mc WHERE mc.invocation_id = i.id) AS total_tokens,
              (SELECT SUM(mc.cost) FROM model_calls mc WHERE mc.invocation_id = i.id) AS total_cost
       FROM invocations i
       JOIN conversations c ON c.id = i.conversation_id
       JOIN chats ch ON ch.id = c.chat_id
       WHERE i.id = ?`,
    )
    .get(id);
  if (invocation === null) return null;
  const toolCalls = db
    .query<ToolCallRow, [bigint]>(
      `SELECT id, tool_call_id, tool_name, arguments_json, result_text, state, side_effect, error_code,
              duration_ms, created_at, finished_at
       FROM tool_calls WHERE invocation_id = ? ORDER BY id`,
    )
    .all(id);
  const modelCalls = db
    .query<ModelCallRow, [bigint]>(
      `SELECT id, role, provider, model, attempt, state, input_tokens, output_tokens, cache_read_tokens,
              cache_write_tokens, total_tokens, cost, duration_ms, error_code, created_at, finished_at
       FROM model_calls WHERE invocation_id = ? ORDER BY id`,
    )
    .all(id);
  const agentMessages = db
    .query<AgentMessageRow, [bigint]>(
      "SELECT sequence_no, role, text, created_at FROM agent_messages WHERE invocation_id = ? ORDER BY sequence_no",
    )
    .all(id);
  const sends = db
    .query<SendRow, [bigint]>(
      `SELECT s.id, tc.tool_call_id, s.kind, s.request_json, s.state, s.telegram_message_id, s.error_code,
              s.created_at, s.finished_at
       FROM telegram_sends s
       JOIN tool_calls tc ON tc.id = s.tool_call_id
       WHERE tc.invocation_id = ?
       ORDER BY s.id`,
    )
    .all(id);
  const contextMessages = db
    .query<ContextMessageRow, [bigint]>(
      `SELECT section, sequence_no, message_id, revision_id, omitted_before, snapshot_json
       FROM invocation_messages WHERE invocation_id = ? ORDER BY sequence_no`,
    )
    .all(id);
  return {
    id: invocation.id.toString(),
    bucket_id: invocation.bucket_id.toString(),
    state: invocation.state,
    created_at: invocation.created_at,
    started_at: invocation.started_at,
    finished_at: invocation.finished_at,
    completion_reason: invocation.completion_reason,
    error_code: invocation.error_code,
    sends_used: Number(invocation.sends_used),
    tool_calls_used: Number(invocation.tool_calls_used),
    turns_used: Number(invocation.turns_used),
    side_effect_started: invocation.side_effect_started === 1n,
    config_hash: invocation.config_hash,
    prompt_version: Number(invocation.prompt_version),
    tool_registry_hash: invocation.tool_registry_hash,
    chat: chatSummary(invocation),
    total_tokens: Number(invocation.total_tokens),
    total_cost: invocation.total_cost,
    tool_calls: toolCalls.map((row) => ({
      id: row.id.toString(),
      tool_call_id: row.tool_call_id,
      tool_name: row.tool_name,
      arguments_json: row.arguments_json,
      result_text: row.result_text,
      state: row.state,
      side_effect: row.side_effect === 1n,
      error_code: row.error_code,
      duration_ms: row.duration_ms === null ? null : Number(row.duration_ms),
      created_at: row.created_at,
      finished_at: row.finished_at,
    })),
    model_calls: modelCalls.map((row) => ({
      id: row.id.toString(),
      role: row.role,
      provider: row.provider,
      model: row.model,
      attempt: Number(row.attempt),
      state: row.state,
      input_tokens: row.input_tokens === null ? null : Number(row.input_tokens),
      output_tokens: row.output_tokens === null ? null : Number(row.output_tokens),
      cache_read_tokens: row.cache_read_tokens === null ? null : Number(row.cache_read_tokens),
      cache_write_tokens: row.cache_write_tokens === null ? null : Number(row.cache_write_tokens),
      total_tokens: row.total_tokens === null ? null : Number(row.total_tokens),
      cost: row.cost,
      duration_ms: row.duration_ms === null ? null : Number(row.duration_ms),
      error_code: row.error_code,
      created_at: row.created_at,
      finished_at: row.finished_at,
    })),
    agent_messages: agentMessages.map((row) => ({
      sequence_no: Number(row.sequence_no),
      role: row.role,
      text: row.text,
      created_at: row.created_at,
    })),
    telegram_sends: sends.map((row) => ({
      id: row.id.toString(),
      tool_call_id: row.tool_call_id,
      kind: row.kind,
      request_json: row.request_json,
      state: row.state,
      telegram_message_id: row.telegram_message_id === null ? null : row.telegram_message_id.toString(),
      error_code: row.error_code,
      created_at: row.created_at,
      finished_at: row.finished_at,
    })),
    context_messages: contextMessages.map((row) => ({
      section: row.section,
      sequence_no: Number(row.sequence_no),
      message_id: row.message_id.toString(),
      revision_id: row.revision_id.toString(),
      omitted_before: Number(row.omitted_before),
      snapshot_json: row.snapshot_json,
    })),
  };
}

export function listMessages(db: Database, query: ListQuery): Page<Record<string, unknown>> {
  const limit = parseLimit(query.limit);
  const conditions: string[] = [];
  const parameters: Bindings = [];
  appendCursor(conditions, parameters, "m.id", query.cursor);
  if (query.chat !== undefined && query.chat !== null && query.chat.length > 0) {
    conditions.push("ch.telegram_chat_id = ?");
    parameters.push(parseId(query.chat, "chat"));
  }
  if (query.search !== undefined && query.search !== null && query.search.length > 0) {
    if (query.search.length > MAX_SEARCH_LENGTH) throw new AdminQueryError("invalid_search", "Search text is too long");
    conditions.push("(r.text LIKE ? ESCAPE '\\' OR r.caption LIKE ? ESCAPE '\\')");
    const like = `%${query.search.replace(/[\\%_]/g, "\\$&")}%`;
    parameters.push(like, like);
  }
  parameters.push(BigInt(limit + 1));
  const rows = db
    .query<MessageListRow, Bindings>(
      `SELECT m.id, m.telegram_message_id, m.telegram_date, m.received_at, m.visible, m.sent_by_bot,
              ch.telegram_chat_id, ch.type AS chat_type, ch.title AS chat_title, c.message_thread_id,
              r.revision_no, r.kind, r.text, r.caption, r.reply_to_message_id, r.media_group_id,
              sd.display_name AS sender_display_name, sd.username AS sender_username, sd.is_bot AS sender_is_bot,
              (SELECT COUNT(*) FROM message_revisions mr WHERE mr.message_id = m.id) AS revision_count,
              (SELECT COUNT(*) FROM media md WHERE md.revision_id = m.current_revision_id) AS media_count
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       JOIN chats ch ON ch.id = m.chat_id
       LEFT JOIN message_revisions r ON r.id = m.current_revision_id
       LEFT JOIN senders sd ON sd.id = r.sender_id
       ${where(conditions)}
       ORDER BY m.id DESC
       LIMIT ?`,
    )
    .all(...parameters);
  return page(rows, limit, (row) => ({
    id: row.id.toString(),
    telegram_message_id: row.telegram_message_id.toString(),
    telegram_date: row.telegram_date,
    received_at: row.received_at,
    visible: row.visible === 1n,
    sent_by_bot: row.sent_by_bot === 1n,
    chat: {
      telegram_chat_id: row.telegram_chat_id.toString(),
      type: row.chat_type,
      title: row.chat_title,
      message_thread_id: Number(row.message_thread_id),
    },
    revision_no: row.revision_no === null ? null : Number(row.revision_no),
    kind: row.kind,
    text: row.text,
    caption: row.caption,
    reply_to_message_id: row.reply_to_message_id === null ? null : row.reply_to_message_id.toString(),
    media_group_id: row.media_group_id,
    sender: row.sender_display_name === null
      ? null
      : { display_name: row.sender_display_name, username: row.sender_username, is_bot: row.sender_is_bot === 1n },
    revision_count: Number(row.revision_count),
    media_count: Number(row.media_count),
  }));
}

export function getMessage(db: Database, id: bigint): Record<string, unknown> | null {
  const message = db
    .query<MessageListRow, [bigint]>(
      `SELECT m.id, m.telegram_message_id, m.telegram_date, m.received_at, m.visible, m.sent_by_bot,
              ch.telegram_chat_id, ch.type AS chat_type, ch.title AS chat_title, c.message_thread_id,
              r.revision_no, r.kind, r.text, r.caption, r.reply_to_message_id, r.media_group_id,
              sd.display_name AS sender_display_name, sd.username AS sender_username, sd.is_bot AS sender_is_bot,
              (SELECT COUNT(*) FROM message_revisions mr WHERE mr.message_id = m.id) AS revision_count,
              (SELECT COUNT(*) FROM media md WHERE md.revision_id = m.current_revision_id) AS media_count
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       JOIN chats ch ON ch.id = m.chat_id
       LEFT JOIN message_revisions r ON r.id = m.current_revision_id
       LEFT JOIN senders sd ON sd.id = r.sender_id
       WHERE m.id = ?`,
    )
    .get(id);
  if (message === null) return null;
  const revisions = db
    .query<RevisionRow, [bigint]>(
      `SELECT r.id, r.revision_no, r.kind, r.text, r.caption, r.reply_to_message_id, r.reply_snapshot_json,
              r.forward_origin_json, r.media_group_id, r.service_json, r.created_at,
              sd.display_name AS sender_display_name, sd.username AS sender_username
       FROM message_revisions r
       LEFT JOIN senders sd ON sd.id = r.sender_id
       WHERE r.message_id = ?
       ORDER BY r.revision_no`,
    )
    .all(id);
  const media = db
    .query<MediaRow, [bigint]>(
      `SELECT md.id, md.revision_id, md.kind, md.file_unique_id, md.mime_type, md.file_size, md.width, md.height,
              ma.state AS analysis_state, ma.description AS analysis_description
       FROM media md
       JOIN message_revisions r ON r.id = md.revision_id
       LEFT JOIN media_analyses ma ON ma.file_unique_id = md.file_unique_id AND ma.state = 'success'
       WHERE r.message_id = ?
       ORDER BY md.id`,
    )
    .all(id);
  return {
    id: message.id.toString(),
    telegram_message_id: message.telegram_message_id.toString(),
    telegram_date: message.telegram_date,
    received_at: message.received_at,
    visible: message.visible === 1n,
    sent_by_bot: message.sent_by_bot === 1n,
    chat: {
      telegram_chat_id: message.telegram_chat_id.toString(),
      type: message.chat_type,
      title: message.chat_title,
      message_thread_id: Number(message.message_thread_id),
    },
    revisions: revisions.map((row) => ({
      id: row.id.toString(),
      revision_no: Number(row.revision_no),
      kind: row.kind,
      text: row.text,
      caption: row.caption,
      reply_to_message_id: row.reply_to_message_id === null ? null : row.reply_to_message_id.toString(),
      reply_snapshot_json: row.reply_snapshot_json,
      forward_origin_json: row.forward_origin_json,
      media_group_id: row.media_group_id,
      service_json: row.service_json,
      created_at: row.created_at,
      sender: row.sender_display_name === null
        ? null
        : { display_name: row.sender_display_name, username: row.sender_username },
    })),
    media: media.map((row) => ({
      id: row.id.toString(),
      revision_id: row.revision_id.toString(),
      kind: row.kind,
      file_unique_id: row.file_unique_id,
      mime_type: row.mime_type,
      file_size: row.file_size === null ? null : Number(row.file_size),
      width: row.width === null ? null : Number(row.width),
      height: row.height === null ? null : Number(row.height),
      analysis_state: row.analysis_state,
      analysis_description: row.analysis_description,
    })),
  };
}

export function listStickerSets(db: Database): readonly Record<string, unknown>[] {
  const rows = db
    .query<StickerSetRow, []>(
      `SELECT ss.id, ss.alias, ss.telegram_name, ss.title, ss.configured, ss.sync_state, ss.last_synced_at,
              ss.error_code, ss.updated_at,
              (SELECT COUNT(*) FROM stickers s WHERE s.sticker_set_id = ss.id AND s.active = 1) AS sticker_count,
              (SELECT COUNT(*) FROM stickers s WHERE s.sticker_set_id = ss.id AND s.active = 1 AND s.index_state = 'success') AS indexed_count,
              (SELECT COUNT(*) FROM stickers s WHERE s.sticker_set_id = ss.id AND s.active = 1 AND s.index_state IN ('pending', 'running')) AS pending_count,
              (SELECT COUNT(*) FROM stickers s WHERE s.sticker_set_id = ss.id AND s.active = 1 AND s.index_state = 'error') AS error_count
       FROM sticker_sets ss
       ORDER BY ss.configured DESC, ss.alias`,
    )
    .all();
  return rows.map((row) => ({
    id: row.id.toString(),
    alias: row.alias,
    telegram_name: row.telegram_name,
    title: row.title,
    configured: row.configured === 1n,
    sync_state: row.sync_state,
    last_synced_at: row.last_synced_at,
    error_code: row.error_code,
    updated_at: row.updated_at,
    sticker_count: Number(row.sticker_count),
    indexed_count: Number(row.indexed_count),
    pending_count: Number(row.pending_count),
    error_count: Number(row.error_count),
  }));
}

export function listStickers(db: Database, query: ListQuery): Page<Record<string, unknown>> {
  const limit = parseLimit(query.limit);
  const conditions: string[] = [];
  const parameters: Bindings = [];
  appendCursor(conditions, parameters, "s.id", query.cursor);
  if (query.set !== undefined && query.set !== null && query.set.length > 0) {
    conditions.push("ss.alias = ?");
    parameters.push(assertToken(query.set, "set"));
  }
  if (query.state !== undefined && query.state !== null && query.state.length > 0) {
    conditions.push("s.index_state = ?");
    parameters.push(assertToken(query.state, "state"));
  }
  if (query.search !== undefined && query.search !== null && query.search.length > 0) {
    if (query.search.length > MAX_SEARCH_LENGTH) throw new AdminQueryError("invalid_search", "Search text is too long");
    conditions.push("(ma.description LIKE ? ESCAPE '\\' OR s.emoji LIKE ? ESCAPE '\\')");
    const like = `%${query.search.replace(/[\\%_]/g, "\\$&")}%`;
    parameters.push(like, like);
  }
  parameters.push(BigInt(limit + 1));
  const rows = db
    .query<StickerRow, Bindings>(
      `SELECT s.id, ss.alias AS set_alias, s.file_unique_id, s.emoji, s.format, s.active, s.index_state,
              s.failure_count, s.next_retry_at, s.updated_at,
              ma.id AS analysis_id, ma.state AS analysis_state, ma.analysis_version, ma.provider, ma.model,
              ma.prompt_version, ma.description, ma.metadata_json, ma.updated_at AS analysis_updated_at
       FROM stickers s
       JOIN sticker_sets ss ON ss.id = s.sticker_set_id
       LEFT JOIN media_analyses ma ON ma.id = s.current_analysis_id
       ${where(conditions)}
       ORDER BY s.id DESC
       LIMIT ?`,
    )
    .all(...parameters);
  return page(rows, limit, (row) => ({
    id: row.id.toString(),
    set_alias: row.set_alias,
    file_unique_id: row.file_unique_id,
    emoji: row.emoji,
    format: row.format,
    active: row.active === 1n,
    index_state: row.index_state,
    failure_count: Number(row.failure_count),
    next_retry_at: row.next_retry_at,
    updated_at: row.updated_at,
    analysis: row.analysis_id === null
      ? null
      : {
          id: row.analysis_id.toString(),
          state: row.analysis_state,
          analysis_version: row.analysis_version,
          provider: row.provider,
          model: row.model,
          prompt_version: row.prompt_version === null ? null : Number(row.prompt_version),
          description: row.description,
          metadata_json: row.metadata_json,
          updated_at: row.analysis_updated_at,
        },
  }));
}

export function overview(db: Database, now = new Date()): Record<string, unknown> {
  const today = now.toISOString().slice(0, 10);
  const invocationStates = db
    .query<CountRow, []>("SELECT state AS label, COUNT(*) AS count FROM invocations GROUP BY state ORDER BY state")
    .all();
  const stickerStates = db
    .query<CountRow, []>(
      "SELECT index_state AS label, COUNT(*) AS count FROM stickers WHERE active = 1 GROUP BY index_state ORDER BY index_state",
    )
    .all();
  const toolNames = db
    .query<CountRow, []>(
      "SELECT tool_name AS label, COUNT(*) AS count FROM tool_calls GROUP BY tool_name ORDER BY count DESC LIMIT 10",
    )
    .all();
  const usage = db
    .query<{ resource: string; metric: string; scope: string; amount: bigint }, [string]>(
      "SELECT resource, metric, scope, amount FROM daily_usage WHERE utc_date = ? ORDER BY resource, metric, scope",
    )
    .all(today);
  const messageCount = db.query<{ count: bigint }, []>("SELECT COUNT(*) AS count FROM messages").get();
  const analysisCount = db
    .query<{ count: bigint }, []>("SELECT COUNT(*) AS count FROM media_analyses WHERE state = 'success'")
    .get();
  return {
    generated_at: now.toISOString(),
    invocation_states: invocationStates.map((row) => ({ label: row.label, count: Number(row.count) })),
    sticker_index_states: stickerStates.map((row) => ({ label: row.label, count: Number(row.count) })),
    top_tools: toolNames.map((row) => ({ label: row.label, count: Number(row.count) })),
    daily_usage: usage.map((row) => ({
      resource: row.resource,
      metric: row.metric,
      scope: row.scope,
      amount: Number(row.amount),
    })),
    message_count: Number(messageCount?.count ?? 0n),
    cached_analysis_count: Number(analysisCount?.count ?? 0n),
  };
}

function chatSummary(row: {
  readonly telegram_chat_id: bigint;
  readonly chat_type: string;
  readonly chat_title: string | null;
  readonly chat_username?: string | null;
  readonly message_thread_id: bigint;
}): Record<string, unknown> {
  return {
    telegram_chat_id: row.telegram_chat_id.toString(),
    type: row.chat_type,
    title: row.chat_title,
    username: row.chat_username ?? null,
    message_thread_id: Number(row.message_thread_id),
  };
}

function page<Row extends { readonly id: bigint }, Item>(
  rows: readonly Row[],
  limit: number,
  map: (row: Row) => Item,
): Page<Item> {
  const visible = rows.slice(0, limit);
  const last = visible.at(-1);
  return {
    items: visible.map(map),
    next_cursor: rows.length > limit && last !== undefined ? last.id.toString() : null,
  };
}

function where(conditions: readonly string[]): string {
  return conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;
}

function appendCursor(conditions: string[], parameters: Bindings, column: string, cursor: string | null | undefined): void {
  if (cursor === undefined || cursor === null || cursor.length === 0) return;
  conditions.push(`${column} < ?`);
  parameters.push(parseId(cursor, "cursor"));
}

export function parseId(value: string, label: string): bigint {
  if (!/^-?\d{1,19}$/.test(value)) throw new AdminQueryError(`invalid_${label}`, `${label} must be an integer`);
  return BigInt(value);
}

function parseLimit(value: string | null | undefined): number {
  if (value === undefined || value === null || value.length === 0) return DEFAULT_PAGE_SIZE;
  if (!/^\d{1,3}$/.test(value)) throw new AdminQueryError("invalid_limit", "limit must be a positive integer");
  const limit = Number.parseInt(value, 10);
  if (limit < 1 || limit > MAX_PAGE_SIZE) throw new AdminQueryError("invalid_limit", `limit must be between 1 and ${MAX_PAGE_SIZE}`);
  return limit;
}

function assertToken(value: string, label: string): string {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(value)) throw new AdminQueryError(`invalid_${label}`, `${label} filter is invalid`);
  return value;
}
