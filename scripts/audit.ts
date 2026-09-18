/**
 * Read-only audit helper for a Plastic Wan database.
 *
 * Answers the question an operator actually asks — "why did the bot reply, or
 * why did it stay silent?" — from the audit trail alone: the frozen batch the
 * model saw, every model call, every tool call, every `send`, and the private
 * assistant text plus harness nudges that never reached Telegram. The database
 * is opened read-only; this script never writes to it.
 *
 * Usage:
 *   node scripts/audit.ts invocation <id> [--db <path>] [--json]
 *   node scripts/audit.ts conversation <id> [--limit n] [--db <path>] [--json]
 *   node scripts/audit.ts prompt <invocationId> [--out <file>] [--db <path>]
 *   node scripts/audit.ts search --text <text> [--since <iso>] [--limit n] [--db <path>] [--json]
 */
import Database from 'better-sqlite3';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AGENT_PROMPT_VERSION } from '../src/platform/agent-protocol.ts';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const DEFAULT_DATABASE = resolve(REPO_ROOT, 'dev-data/data/plasticwan.sqlite');
const DEFAULT_LIMIT = 15;
const PREVIEW_CHARACTERS = 200;

type Command = 'invocation' | 'conversation' | 'prompt' | 'search';

interface Options {
  readonly command: Command;
  readonly target: string | null;
  readonly text: string | null;
  readonly database: string;
  readonly limit: number;
  readonly json: boolean;
  readonly out: string | null;
  readonly since: string | null;
}

interface InvocationRow {
  readonly id: number;
  readonly state: string;
  readonly config_hash: string;
  readonly prompt_version: number;
  readonly started_at: string | null;
  readonly finished_at: string | null;
  readonly completion_reason: string | null;
  readonly error_code: string | null;
  readonly sends_used: number;
  readonly tool_calls_used: number;
  readonly turns_used: number;
  readonly bucket_id: number;
  readonly bucket_kind: string;
  readonly bucket_state: string;
  readonly first_received_at: string;
  readonly deadline_at: string;
  readonly conversation_id: number;
  readonly message_thread_id: number;
  readonly telegram_chat_id: number;
  readonly chat_title: string | null;
  readonly chat_type: string;
}

interface InvocationMessageRow {
  readonly sequence_no: number;
  readonly section: string;
  readonly source_bucket_id: number | null;
  readonly snapshot_json: string;
}

interface ModelCallRow {
  readonly id: number;
  readonly state: string;
  readonly provider: string;
  readonly model: string;
  readonly attempt: number;
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
  readonly cache_read_tokens: number | null;
  readonly duration_ms: number | null;
  readonly error_code: string | null;
  readonly error_detail: string | null;
  readonly created_at: string;
  readonly finished_at: string | null;
  readonly request_messages: number | null;
  readonly request_tools: number | null;
}

interface ToolCallRow {
  readonly id: number;
  readonly tool_name: string;
  readonly state: string;
  readonly side_effect: number;
  readonly error_code: string | null;
  readonly duration_ms: number | null;
  readonly arguments_json: string;
  readonly result_text: string | null;
}

interface SendRow {
  readonly id: number;
  readonly kind: string;
  readonly state: string;
  readonly telegram_message_id: number | null;
  readonly error_code: string | null;
  readonly created_at: string;
  readonly request_json: string;
}

interface AgentMessageRow {
  readonly id: number;
  readonly sequence_no: number;
  readonly role: string;
  readonly text: string;
  readonly created_at: string;
}

interface ConversationRow {
  readonly id: number;
  readonly message_thread_id: number;
  readonly telegram_chat_id: number;
  readonly chat_title: string | null;
  readonly chat_type: string;
}

interface ConversationInvocationRow {
  readonly id: number;
  readonly state: string;
  readonly sends_used: number;
  readonly tool_calls_used: number;
  readonly turns_used: number;
  readonly completion_reason: string | null;
  readonly prompt_version: number;
  readonly started_at: string | null;
  readonly finished_at: string | null;
  readonly nudges: number;
  readonly private_texts: number;
}

interface ConversationSendRow {
  readonly id: number;
  readonly kind: string;
  readonly state: string;
  readonly telegram_message_id: number | null;
  readonly created_at: string;
  readonly request_json: string;
}

interface ContextRow {
  readonly head_seq: number;
  readonly next_seq: number;
  readonly system_prompt_hash: string;
  readonly updated_at: string;
  readonly total: number;
  readonly live: number;
  readonly checkpoints: number;
}

interface AttentionRow {
  readonly expires_at: string;
  readonly trigger_kind: string;
  readonly triggered_at: string;
}

interface SnapshotMessage {
  readonly message_id?: unknown;
  readonly telegram_date?: unknown;
  readonly sent_by_bot?: unknown;
  readonly kind?: unknown;
  readonly text?: unknown;
  readonly caption?: unknown;
  readonly sender?: { readonly name?: unknown; readonly username?: unknown } | undefined;
  readonly media?: readonly unknown[] | undefined;
}

function parseOptions(argv: readonly string[]): Options {
  let command: string | null = null;
  let target: string | null = null;
  let text: string | null = null;
  let database = DEFAULT_DATABASE;
  let limit = DEFAULT_LIMIT;
  let json = false;
  let out: string | null = null;
  let since: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = (): string => {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error(`Missing value for ${argument ?? ''}`);
      }
      index += 1;
      return value;
    };
    if (argument === '--db' || argument === '--database') {
      database = resolve(next());
      continue;
    }
    if (argument === '--limit') {
      limit = Number.parseInt(next(), 10);
      if (!Number.isInteger(limit) || limit <= 0) {
        throw new Error('--limit must be a positive integer');
      }
      continue;
    }
    if (argument === '--text') {
      text = next();
      continue;
    }
    if (argument === '--since') {
      since = next();
      continue;
    }
    if (argument === '--out') {
      out = resolve(next());
      continue;
    }
    if (argument === '--json') {
      json = true;
      continue;
    }
    if (argument?.startsWith('--')) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    if (command === null) {
      command = argument ?? '';
      continue;
    }
    if (target === null) {
      target = argument ?? '';
      continue;
    }
    throw new Error(`Unexpected argument: ${argument ?? ''}`);
  }
  if (command !== 'invocation' && command !== 'conversation' && command !== 'prompt' && command !== 'search') {
    throw new Error('Usage: node scripts/audit.ts <invocation|conversation|prompt|search> [id] [--db <path>] [--json]');
  }
  if (command === 'search' && (text === null || text.length === 0)) {
    throw new Error('search requires --text <text>');
  }
  if (command !== 'search' && target === null) {
    throw new Error(`${command} requires an id`);
  }
  return { command, target, text, database, limit, json, out, since };
}

function openDatabase(path: string): Database.Database {
  return new Database(path, { readonly: true, fileMustExist: true });
}

function preview(value: string | null, max = PREVIEW_CHARACTERS): string {
  if (value === null) {
    return '';
  }
  const collapsed = value.replaceAll(/\s+/g, ' ').trim();
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}

function field(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return value.toString();
  }
  return '';
}

function parseSnapshot(json: string): SnapshotMessage | null {
  try {
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === 'object' && parsed !== null ? (parsed as SnapshotMessage) : null;
  } catch {
    return null;
  }
}

function loadInvocation(database: Database.Database, id: number): InvocationRow {
  const row = database
    .prepare<[number], InvocationRow>(
      `SELECT i.id, i.state, i.config_hash, i.prompt_version, i.started_at, i.finished_at,
              i.completion_reason, i.error_code, i.sends_used, i.tool_calls_used, i.turns_used,
              i.bucket_id, b.kind AS bucket_kind, b.state AS bucket_state, b.first_received_at, b.deadline_at,
              i.conversation_id, v.message_thread_id, c.telegram_chat_id, c.title AS chat_title, c.type AS chat_type
       FROM invocations i
       JOIN buckets b ON b.id = i.bucket_id
       JOIN conversations v ON v.id = i.conversation_id
       JOIN chats c ON c.id = v.chat_id
       WHERE i.id = ?`,
    )
    .get(id);
  if (row === undefined) {
    throw new Error(`Invocation ${id} does not exist`);
  }
  return row;
}

function loadModelCalls(database: Database.Database, id: number): ModelCallRow[] {
  return database
    .prepare<[number], ModelCallRow>(
      `SELECT id, state, provider, model, attempt, input_tokens, output_tokens, cache_read_tokens,
              duration_ms, error_code, substr(error_detail, 1, 300) AS error_detail, created_at, finished_at,
              CASE WHEN request_json IS NULL THEN NULL
                   ELSE json_array_length(json_extract(request_json, '$.messages')) END AS request_messages,
              CASE WHEN request_json IS NULL THEN NULL
                   ELSE json_array_length(json_extract(request_json, '$.tools')) END AS request_tools
       FROM model_calls WHERE invocation_id = ? ORDER BY id`,
    )
    .all(id);
}

function loadToolCalls(database: Database.Database, id: number): ToolCallRow[] {
  return database
    .prepare<[number], ToolCallRow>(
      `SELECT id, tool_name, state, side_effect, error_code, duration_ms,
              substr(arguments_json, 1, 300) AS arguments_json, substr(result_text, 1, 300) AS result_text
       FROM tool_calls WHERE invocation_id = ? ORDER BY id`,
    )
    .all(id);
}

function loadSends(database: Database.Database, id: number): SendRow[] {
  return database
    .prepare<[number], SendRow>(
      `SELECT s.id, s.kind, s.state, s.telegram_message_id, s.error_code, s.created_at,
              substr(s.request_json, 1, 300) AS request_json
       FROM telegram_sends s JOIN tool_calls t ON t.id = s.tool_call_id
       WHERE t.invocation_id = ? ORDER BY s.id`,
    )
    .all(id);
}

function loadAgentMessages(database: Database.Database, id: number): AgentMessageRow[] {
  return database
    .prepare<[number], AgentMessageRow>(
      `SELECT id, sequence_no, role, text, created_at
       FROM agent_messages WHERE invocation_id = ? ORDER BY sequence_no`,
    )
    .all(id);
}

function loadBatch(database: Database.Database, id: number): InvocationMessageRow[] {
  return database
    .prepare<[number], InvocationMessageRow>(
      `SELECT sequence_no, section, source_bucket_id, snapshot_json
       FROM invocation_messages WHERE invocation_id = ? ORDER BY sequence_no`,
    )
    .all(id);
}

/** The batch messages that were allowed to create the current task. */
function newestMessages(batch: readonly InvocationMessageRow[]): {
  readonly messageId: string;
  readonly sender: string;
  readonly text: string;
  readonly fromBot: boolean;
  readonly media: number;
}[] {
  const out: {
    messageId: string;
    sender: string;
    text: string;
    fromBot: boolean;
    media: number;
  }[] = [];
  for (const row of batch) {
    if (row.section !== 'new') {
      continue;
    }
    const snapshot = parseSnapshot(row.snapshot_json);
    if (snapshot === null) {
      continue;
    }
    const username = field(snapshot.sender?.username);
    out.push({
      messageId: field(snapshot.message_id),
      sender: field(snapshot.sender?.name) || username || 'unknown',
      text: preview(field(snapshot.text) || field(snapshot.caption), 120),
      fromBot: username.toLowerCase().endsWith('bot'),
      media: Array.isArray(snapshot.media) ? snapshot.media.length : 0,
    });
  }
  return out;
}

/**
 * The verdict is deliberately mechanical: it only states what the audit rows
 * prove. Judging whether the silence was *right* is the reader's job.
 */
function verdict(input: {
  readonly invocation: InvocationRow;
  readonly sends: readonly SendRow[];
  readonly toolCalls: readonly ToolCallRow[];
  readonly messages: readonly AgentMessageRow[];
  readonly newest: readonly {
    readonly messageId: string;
    readonly sender: string;
    readonly text: string;
    readonly fromBot: boolean;
  }[];
}): string[] {
  const lines: string[] = [];
  const succeeded = input.sends.filter((send) => send.state === 'success');
  const assistantTexts = input.messages.filter(
    (message) => message.role === 'assistant' && message.text.trim().length > 0,
  );
  const nudges = input.messages.filter((message) => message.role === 'harness_nudge');

  if (succeeded.length > 0) {
    lines.push(`已产生 ${succeeded.length} 次成功的 Telegram 发送`);
  } else if (input.sends.length > 0) {
    lines.push(
      `有 ${input.sends.length} 次 send 调用但没有成功（${input.sends.map((send) => send.state).join(', ')}）`,
    );
  } else if (nudges.length > 0) {
    lines.push(`harness 提醒过 ${nudges.length} 次（harness_nudge）但仍未调用 send：模型自己选择不发言`);
  } else if (assistantTexts.length > 0) {
    lines.push(
      '模型产生了私有文本但未调用 send，且没有 harness_nudge 记录：检查 agent.send_nudge_enabled 与提醒判定条件',
    );
  } else {
    lines.push('模型没有任何输出：既没有私有文本，也没有 Tool Call');
  }
  if (input.toolCalls.length === 0 && input.sends.length === 0) {
    lines.push('本 Invocation 没有任何 Tool Call');
  }
  if (input.invocation.completion_reason !== null && input.invocation.completion_reason !== 'completed') {
    lines.push(`结束原因不是 completed，而是 ${input.invocation.completion_reason}`);
  }
  if (input.invocation.state !== 'completed') {
    lines.push(`Invocation state = ${input.invocation.state}`);
  }
  if (input.invocation.prompt_version !== Number(AGENT_PROMPT_VERSION)) {
    lines.push(
      `该 Invocation 用的是 prompt_version ${input.invocation.prompt_version}，当前代码是 ${AGENT_PROMPT_VERSION.toString()}：当时的系统提示词与现在不同`,
    );
  }
  if (input.newest.length === 0) {
    lines.push('本批没有任何 new 段消息（只有 history）');
  } else {
    const botAuthored = input.newest.filter((message) => message.fromBot).length;
    lines.push(
      `本批 new 消息 ${input.newest.length} 条，最新一条来自「${input.newest.at(-1)?.sender ?? 'unknown'}」：${input.newest.at(-1)?.text ?? ''}`,
    );
    if (botAuthored > 0) {
      lines.push(`其中 ${botAuthored} 条来自 Bot（Core Protocol 的 bot-to-bot 规则适用）`);
    }
  }
  return lines;
}

function renderInvocation(database: Database.Database, id: number, json: boolean): string {
  const invocation = loadInvocation(database, id);
  const modelCalls = loadModelCalls(database, id);
  const toolCalls = loadToolCalls(database, id);
  const sends = loadSends(database, id);
  const messages = loadAgentMessages(database, id);
  const batch = loadBatch(database, id);
  const newest = newestMessages(batch);
  const lines = verdict({ invocation, sends, toolCalls, messages, newest });

  if (json) {
    return JSON.stringify(
      { invocation, modelCalls, toolCalls, sends, messages, batch: newest, verdict: lines },
      null,
      2,
    );
  }

  const out: string[] = [];
  const section = (title: string): void => {
    out.push('', `=== ${title} ===`);
  };
  section('Invocation');
  out.push(
    `id=${invocation.id} state=${invocation.state} completion=${invocation.completion_reason ?? '-'} error=${invocation.error_code ?? '-'}`,
    `chat=${invocation.telegram_chat_id} (${invocation.chat_title ?? '-'}, ${invocation.chat_type}) conversation=${invocation.conversation_id} thread=${invocation.message_thread_id}`,
    `bucket=${invocation.bucket_id} kind=${invocation.bucket_kind} state=${invocation.bucket_state} received=${invocation.first_received_at} deadline=${invocation.deadline_at}`,
    `started=${invocation.started_at ?? '-'} finished=${invocation.finished_at ?? '-'}`,
    `prompt_version=${invocation.prompt_version} (current=${AGENT_PROMPT_VERSION.toString()}) config_hash=${invocation.config_hash.slice(0, 12)}`,
    `sends=${invocation.sends_used} tool_calls=${invocation.tool_calls_used} turns=${invocation.turns_used}`,
  );
  section(`本批 new 消息 (${newest.length})`);
  for (const message of newest) {
    out.push(
      `#${message.messageId} ${message.sender}${message.fromBot ? ' [bot]' : ''}${message.media > 0 ? ` [media ${message.media}]` : ''}: ${message.text}`,
    );
  }
  section(`Model calls (${modelCalls.length})`);
  for (const call of modelCalls) {
    out.push(
      `#${call.id} ${call.state} ${call.provider}/${call.model} messages=${call.request_messages ?? '-'} tools=${call.request_tools ?? '-'} in=${call.input_tokens ?? '-'} out=${call.output_tokens ?? '-'} cache_read=${call.cache_read_tokens ?? '-'} ${call.error_code ?? ''}`,
    );
  }
  section(`Tool calls (${toolCalls.length})`);
  for (const call of toolCalls) {
    out.push(
      `#${call.id} ${call.tool_name} ${call.state} side_effect=${call.side_effect === 1} ${call.error_code ?? ''}`,
    );
    out.push(`    args: ${preview(call.arguments_json, 200)}`);
    if (call.result_text !== null) {
      out.push(`    result: ${preview(call.result_text, 200)}`);
    }
  }
  section(`Telegram sends (${sends.length})`);
  for (const send of sends) {
    out.push(
      `#${send.id} ${send.kind} ${send.state} telegram_message_id=${send.telegram_message_id ?? '-'} ${send.error_code ?? ''} ${preview(send.request_json, 120)}`,
    );
  }
  section(`Agent messages (${messages.length})`);
  for (const message of messages) {
    out.push(`[${message.sequence_no}] ${message.role}: ${preview(message.text, 240)}`);
  }
  section('判读');
  for (const line of lines) {
    out.push(`- ${line}`);
  }
  return out.join('\n');
}

function renderConversation(database: Database.Database, id: number, limit: number, json: boolean): string {
  const conversation = database
    .prepare<[number], ConversationRow>(
      `SELECT v.id, v.message_thread_id, c.telegram_chat_id, c.title AS chat_title, c.type AS chat_type
       FROM conversations v JOIN chats c ON c.id = v.chat_id WHERE v.id = ?`,
    )
    .get(id);
  if (conversation === undefined) {
    throw new Error(`Conversation ${id} does not exist`);
  }
  const invocations = database
    .prepare<[number, number], ConversationInvocationRow>(
      `SELECT i.id, i.state, i.sends_used, i.tool_calls_used, i.turns_used, i.completion_reason,
              i.prompt_version, i.started_at, i.finished_at,
              (SELECT count(*) FROM agent_messages m WHERE m.invocation_id = i.id AND m.role = 'harness_nudge') AS nudges,
              (SELECT count(*) FROM agent_messages m WHERE m.invocation_id = i.id AND m.role = 'assistant') AS private_texts
       FROM invocations i WHERE i.conversation_id = ? ORDER BY i.id DESC LIMIT ?`,
    )
    .all(id, limit);
  const sends = database
    .prepare<[number, number], ConversationSendRow>(
      `SELECT id, kind, state, telegram_message_id, created_at, substr(request_json, 1, 160) AS request_json
       FROM telegram_sends WHERE conversation_id = ? ORDER BY id DESC LIMIT ?`,
    )
    .all(id, limit);
  const privateTexts = database
    .prepare<[number, number], { invocation_id: number; text: string }>(
      `SELECT m.invocation_id, m.text
       FROM agent_messages m JOIN invocations i ON i.id = m.invocation_id
       WHERE i.conversation_id = ? AND m.role = 'assistant'
       ORDER BY m.id DESC LIMIT ?`,
    )
    .all(id, limit);
  const context = database
    .prepare<[number], ContextRow>(
      `SELECT head_seq, next_seq, system_prompt_hash, updated_at,
              (SELECT count(*) FROM context_messages c WHERE c.context_id = cc.id) AS total,
              (SELECT count(*) FROM context_messages c WHERE c.context_id = cc.id AND c.evicted_at IS NULL) AS live,
              (SELECT count(*) FROM context_messages c WHERE c.context_id = cc.id AND c.is_checkpoint = 1) AS checkpoints
       FROM conversation_contexts cc WHERE cc.conversation_id = ?`,
    )
    .get(id);
  const attention = database
    .prepare<[number], AttentionRow>(
      `SELECT expires_at, trigger_kind, triggered_at FROM conversation_attention WHERE conversation_id = ?`,
    )
    .get(id);
  const memories = database
    .prepare<[number], { count: number }>(`SELECT count(*) AS count FROM memories WHERE conversation_id = ?`)
    .get(id);
  const gate =
    attention === undefined
      ? 'no attention window recorded'
      : `attention window until ${attention.expires_at} (${attention.trigger_kind} at ${attention.triggered_at})`;

  if (json) {
    return JSON.stringify(
      {
        conversation,
        invocations,
        sends,
        privateTexts,
        context: context ?? null,
        attention: attention ?? null,
        memoryCount: memories?.count ?? 0,
      },
      null,
      2,
    );
  }

  const out: string[] = [];
  const section = (title: string): void => {
    out.push('', `=== ${title} ===`);
  };
  section('Conversation');
  out.push(
    `id=${conversation.id} chat=${conversation.telegram_chat_id} (${conversation.chat_title ?? '-'}, ${conversation.chat_type}) thread=${conversation.message_thread_id}`,
    `memories=${memories?.count ?? 0}`,
    `participation: ${gate}`,
  );
  if (context !== undefined) {
    section('Context');
    out.push(
      `head_seq=${context.head_seq} next_seq=${context.next_seq} live=${context.live}/${context.total} checkpoints=${context.checkpoints} prompt_hash=${context.system_prompt_hash.slice(0, 12)} updated=${context.updated_at}`,
    );
  }
  section(`Recent invocations (${invocations.length})`);
  out.push('id  state      sends tools turns nudges texts  completion      prompt_v  started');
  for (const row of invocations) {
    out.push(
      `${String(row.id).padEnd(3)} ${row.state.padEnd(10)} ${String(row.sends_used).padEnd(5)} ${String(row.tool_calls_used).padEnd(5)} ${String(row.turns_used).padEnd(5)} ${String(row.nudges).padEnd(6)} ${String(row.private_texts).padEnd(6)} ${(row.completion_reason ?? '-').padEnd(15)} ${String(row.prompt_version).padEnd(9)} ${row.started_at ?? '-'}`,
    );
  }
  section(`Recent sends (${sends.length})`);
  for (const send of sends) {
    out.push(
      `#${send.id} ${send.kind} ${send.state} telegram_message_id=${send.telegram_message_id ?? '-'} ${send.created_at}`,
    );
  }
  section(`Recent private assistant texts (${privateTexts.length})`);
  for (const row of privateTexts) {
    out.push(`invocation ${row.invocation_id}: ${preview(row.text, 200)}`);
  }
  return out.join('\n');
}

async function runPrompt(database: Database.Database, id: number, out: string | null): Promise<string> {
  const row = database
    .prepare<[number], { id: number; request_json: string | null }>(
      `SELECT id, request_json FROM model_calls
       WHERE invocation_id = ? AND request_json IS NOT NULL ORDER BY id DESC LIMIT 1`,
    )
    .get(id);
  if (row?.request_json === null || row === undefined) {
    throw new Error(`Invocation ${id} has no recorded model request`);
  }
  const parsed: unknown = JSON.parse(row.request_json);
  const request = parsed as {
    readonly messages?: readonly { readonly role?: unknown; readonly content?: unknown }[];
    readonly tools?: readonly {
      readonly function?: { readonly name?: unknown } | undefined;
      readonly name?: unknown;
    }[];
  };
  const system = request.messages?.find((message) => message.role === 'system');
  const systemText = typeof system?.content === 'string' ? system.content : '';
  if (systemText.length === 0) {
    throw new Error(`Invocation ${id}: the recorded request has no string system message`);
  }
  const tools = (request.tools ?? [])
    .map((tool) => field(tool.function?.name ?? tool.name))
    .filter((name) => name.length > 0);
  const header = `# invocation ${id}, model_call ${row.id}, ${systemText.length} characters, ${tools.length} tools\n# tools: ${tools.join(', ')}\n`;
  if (out !== null) {
    await writeFile(out, `${header}${systemText}\n`, 'utf8');
    return `wrote ${systemText.length} characters of system prompt to ${out} (${tools.length} tools)`;
  }
  return `${header}\n${systemText}`;
}

function runSearch(
  database: Database.Database,
  text: string,
  limit: number,
  since: string | null,
  json: boolean,
): string {
  const rows = database
    .prepare<
      [string, string, string, number],
      { invocation_id: number; conversation_id: number; sends_used: number; created_at: string; text: string }
    >(
      `SELECT m.invocation_id, i.conversation_id, i.sends_used, m.created_at, m.text
       FROM agent_messages m JOIN invocations i ON i.id = m.invocation_id
       WHERE m.role = 'assistant' AND m.text LIKE '%' || ? || '%'
         AND (? = '' OR m.created_at >= ?)
       ORDER BY m.id DESC LIMIT ?`,
    )
    .all(text, since ?? '', since ?? '', limit);
  if (json) {
    return JSON.stringify({ pattern: text, matches: rows }, null, 2);
  }
  const out: string[] = [`=== private assistant texts matching 「${text}」 (${rows.length}) ===`];
  const invocationIds = new Set(rows.map((row) => row.invocation_id));
  const silent = rows.filter((row) => row.sends_used === 0).length;
  for (const row of rows) {
    out.push(
      `invocation ${row.invocation_id} conversation ${row.conversation_id} sends=${row.sends_used} ${row.created_at}: ${preview(row.text, 200)}`,
    );
  }
  out.push('', `invocations matched: ${invocationIds.size}; matches inside send-less invocations: ${silent}`);
  return out.join('\n');
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const database = openDatabase(options.database);
  try {
    if (options.command === 'invocation') {
      console.log(renderInvocation(database, Number(options.target), options.json));
      return;
    }
    if (options.command === 'conversation') {
      console.log(renderConversation(database, Number(options.target), options.limit, options.json));
      return;
    }
    if (options.command === 'prompt') {
      console.log(await runPrompt(database, Number(options.target), options.out));
      return;
    }
    console.log(runSearch(database, options.text ?? '', options.limit, options.since, options.json));
  } finally {
    database.close();
  }
}

await main();
