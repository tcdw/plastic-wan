export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface SessionState {
  readonly setup_required: boolean;
  readonly authenticated: boolean;
  readonly username: string | null;
  readonly expires_at: string | null;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly next_cursor: string | null;
}

export interface ChatSummary {
  readonly telegram_chat_id: string;
  readonly type: string;
  readonly title: string | null;
  readonly username?: string | null;
  readonly message_thread_id: number;
}

export interface InvocationListItem {
  readonly id: string;
  readonly state: string;
  readonly created_at: string;
  readonly started_at: string | null;
  readonly finished_at: string | null;
  readonly completion_reason: string | null;
  readonly error_code: string | null;
  readonly sends_used: number;
  readonly tool_calls_used: number;
  readonly turns_used: number;
  readonly side_effect_started: boolean;
  readonly config_hash: string;
  readonly chat: ChatSummary;
  readonly tool_call_count: number;
  readonly total_tokens: number;
  readonly total_cost: number | null;
}

export interface ToolCallEntry {
  readonly id: string;
  readonly tool_call_id: string;
  readonly tool_name: string;
  readonly arguments_json: string;
  readonly result_text: string | null;
  readonly state: string;
  readonly side_effect: boolean;
  readonly error_code: string | null;
  readonly duration_ms: number | null;
  readonly created_at: string;
  readonly finished_at: string | null;
}

export interface ModelCallEntry {
  readonly id: string;
  readonly role: string;
  readonly provider: string;
  readonly model: string;
  readonly attempt: number;
  readonly state: string;
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
  readonly cache_read_tokens: number | null;
  readonly cache_write_tokens: number | null;
  readonly total_tokens: number | null;
  readonly cost: number | null;
  readonly duration_ms: number | null;
  readonly error_code: string | null;
  readonly created_at: string;
  readonly finished_at: string | null;
}

export interface AgentMessageEntry {
  readonly sequence_no: number;
  readonly role: string;
  readonly text: string;
  readonly created_at: string;
}

export interface TelegramSendEntry {
  readonly id: string;
  readonly tool_call_id: string;
  readonly kind: string;
  readonly request_json: string;
  readonly state: string;
  readonly telegram_message_id: string | null;
  readonly error_code: string | null;
  readonly created_at: string;
  readonly finished_at: string | null;
}

export interface ContextMessageEntry {
  readonly section: string;
  readonly sequence_no: number;
  readonly message_id: string;
  readonly revision_id: string;
  readonly omitted_before: number;
  readonly snapshot_json: string;
}

export interface InvocationDetail extends InvocationListItem {
  readonly bucket_id: string;
  readonly prompt_version: number;
  readonly tool_registry_hash: string | null;
  readonly tool_calls: readonly ToolCallEntry[];
  readonly model_calls: readonly ModelCallEntry[];
  readonly agent_messages: readonly AgentMessageEntry[];
  readonly telegram_sends: readonly TelegramSendEntry[];
  readonly context_messages: readonly ContextMessageEntry[];
}

export interface SenderSummary {
  readonly display_name: string;
  readonly username: string | null;
  readonly is_bot?: boolean;
}

export interface MessageListItem {
  readonly id: string;
  readonly telegram_message_id: string;
  readonly telegram_date: string;
  readonly received_at: string;
  readonly visible: boolean;
  readonly sent_by_bot: boolean;
  readonly chat: ChatSummary;
  readonly revision_no: number | null;
  readonly kind: string | null;
  readonly text: string | null;
  readonly caption: string | null;
  readonly reply_to_message_id: string | null;
  readonly media_group_id: string | null;
  readonly sender: SenderSummary | null;
  readonly revision_count: number;
  readonly media_count: number;
}

export interface RevisionEntry {
  readonly id: string;
  readonly revision_no: number;
  readonly kind: string;
  readonly text: string | null;
  readonly caption: string | null;
  readonly reply_to_message_id: string | null;
  readonly reply_snapshot_json: string | null;
  readonly forward_origin_json: string | null;
  readonly media_group_id: string | null;
  readonly service_json: string | null;
  readonly created_at: string;
  readonly sender: SenderSummary | null;
}

export interface MediaEntry {
  readonly id: string;
  readonly revision_id: string;
  readonly kind: string;
  readonly file_unique_id: string;
  readonly mime_type: string | null;
  readonly file_size: number | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly analysis_state: string | null;
  readonly analysis_description: string | null;
}

export interface MessageDetail {
  readonly id: string;
  readonly telegram_message_id: string;
  readonly telegram_date: string;
  readonly received_at: string;
  readonly visible: boolean;
  readonly sent_by_bot: boolean;
  readonly chat: ChatSummary;
  readonly revisions: readonly RevisionEntry[];
  readonly media: readonly MediaEntry[];
}

export interface StickerSetEntry {
  readonly id: string;
  readonly alias: string;
  readonly telegram_name: string;
  readonly title: string | null;
  readonly configured: boolean;
  readonly sync_state: string;
  readonly last_synced_at: string | null;
  readonly error_code: string | null;
  readonly updated_at: string;
  readonly sticker_count: number;
  readonly indexed_count: number;
  readonly pending_count: number;
  readonly error_count: number;
}

export interface StickerAnalysis {
  readonly id: string;
  readonly state: string | null;
  readonly analysis_version: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly prompt_version: number | null;
  readonly description: string | null;
  readonly metadata_json: string | null;
  readonly updated_at: string | null;
}

export interface StickerEntry {
  readonly id: string;
  readonly set_alias: string;
  readonly file_unique_id: string;
  readonly emoji: string | null;
  readonly format: string;
  readonly active: boolean;
  readonly index_state: string;
  readonly failure_count: number;
  readonly next_retry_at: string | null;
  readonly updated_at: string;
  readonly analysis: StickerAnalysis | null;
}

export interface LabelCount {
  readonly label: string;
  readonly count: number;
}

export interface UsageEntry {
  readonly resource: string;
  readonly metric: string;
  readonly scope: string;
  readonly amount: number;
}

export interface CancelPendingResult {
  readonly canceled_buckets: number;
  readonly canceled_invocations: number;
  readonly refunded_invocations: number;
}

export interface Overview {
  readonly generated_at: string;
  readonly invocation_states: readonly LabelCount[];
  readonly sticker_index_states: readonly LabelCount[];
  readonly top_tools: readonly LabelCount[];
  readonly daily_usage: readonly UsageEntry[];
  readonly message_count: number;
  readonly cached_analysis_count: number;
}
export interface UsageResponse {
  readonly days: number;
  readonly series: readonly UsagePoint[];
}

export interface UsagePoint {
  readonly date: string;
  readonly model_tokens: number;
  readonly vision_tokens: number;
  readonly tool_calls: number;
  readonly agent_invocations: number;
}

export interface ListFilters {
  readonly limit?: number;
  readonly cursor?: string | null;
  readonly state?: string | undefined;
  readonly chat?: string | undefined;
  readonly set?: string | undefined;
  readonly search?: string | undefined;
}

export interface Credentials {
  readonly username: string;
  readonly password: string;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, { credentials: "same-origin", ...init });
  const text = await response.text();
  let payload: unknown = null;
  if (text.length > 0) {
    try {
      payload = JSON.parse(text);
    } catch {
      throw new ApiError(response.status, "invalid_response", "Admin API returned a non-JSON response");
    }
  }
  if (!response.ok) {
    const body = payload as { error?: string; message?: string } | null;
    throw new ApiError(
      response.status,
      body?.error ?? "request_failed",
      body?.message ?? `Admin API request failed with status ${response.status}`,
    );
  }
  return payload as T;
}

function listPath(path: string, filters: ListFilters): string {
  const params = new URLSearchParams();
  if (filters.limit !== undefined) params.set("limit", String(filters.limit));
  if (filters.cursor !== undefined && filters.cursor !== null) params.set("cursor", filters.cursor);
  for (const key of ["state", "chat", "set", "search"] as const) {
    const value = filters[key];
    if (value !== undefined && value.length > 0) params.set(key, value);
  }
  const query = params.toString();
  return query.length === 0 ? path : `${path}?${query}`;
}

export function getSession(): Promise<SessionState> {
  return call<SessionState>("/auth/session");
}

export function createFirstAdmin(credentials: Credentials): Promise<{ status: string }> {
  return call("/auth/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(credentials),
  });
}

export function login(credentials: Credentials): Promise<{ status: string }> {
  return call("/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(credentials),
  });
}
export function updateCredentials(credentials: Credentials): Promise<{ status: string }> {
  return call("/auth/credentials", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(credentials),
  });
}


export function logout(): Promise<{ status: string }> {
  return call("/auth/logout", { method: "POST" });
}

export function getOverview(): Promise<Overview> {
  return call<Overview>("/overview");
}

export function listInvocations(filters: ListFilters): Promise<Page<InvocationListItem>> {
  return call<Page<InvocationListItem>>(listPath("/invocations", filters));
}

export function getInvocation(id: string): Promise<InvocationDetail> {
  return call<InvocationDetail>(`/invocations/${encodeURIComponent(id)}`);
}

export function listMessages(filters: ListFilters): Promise<Page<MessageListItem>> {
  return call<Page<MessageListItem>>(listPath("/messages", filters));
}

export function getMessage(id: string): Promise<MessageDetail> {
  return call<MessageDetail>(`/messages/${encodeURIComponent(id)}`);
}

export function listStickerSets(): Promise<{ items: readonly StickerSetEntry[] }> {
  return call<{ items: readonly StickerSetEntry[] }>("/sticker-sets");
}

export function listStickers(filters: ListFilters): Promise<Page<StickerEntry>> {
  return call<Page<StickerEntry>>(listPath("/stickers", filters));
}

export function cancelPendingSessions(): Promise<CancelPendingResult> {
  return call<CancelPendingResult>("/cancel-pending-sessions", { method: "POST" });
}

export function getUsage(days: number): Promise<UsageResponse> {
  return call<UsageResponse>(`/usage?days=${encodeURIComponent(String(days))}`);
}
