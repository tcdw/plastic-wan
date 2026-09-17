import { describe, expect, test } from 'vitest';
import type {
  AgentMessageEntry,
  ContextMessageEntry,
  InvocationDetail,
  ModelCallEntry,
  TelegramSendEntry,
  ToolCallEntry,
} from './api.ts';
import {
  buildInvocationTimeline,
  contextMessageTimestamp,
  indexSendsByToolCall,
  isNewContextSection,
  parseJsonObject,
  parseSendArguments,
  sortTimelineEvents,
  timelineEventKey,
  type InvocationTimelineEvent,
} from './timeline.ts';

const AT = '2026-09-15T10:00:00.000Z';

function contextMessage(overrides: Partial<ContextMessageEntry> = {}): ContextMessageEntry {
  return {
    section: 'new',
    sequence_no: 1,
    message_id: '7001',
    revision_id: '8001',
    omitted_before: 0,
    snapshot_json:
      '{"sender":{"username":"alice","name":"Alice"},"kind":"text","text":"hello","telegram_date":"2026-09-15T09:59:00.000Z","message_id":"7001"}',
    ...overrides,
  };
}

function modelCall(overrides: Partial<ModelCallEntry> = {}): ModelCallEntry {
  return {
    id: '3001',
    role: 'agent',
    provider: 'openai',
    model: 'gpt-4.1-mini',
    attempt: 1,
    state: 'success',
    input_tokens: 100,
    output_tokens: 50,
    cache_read_tokens: null,
    cache_write_tokens: null,
    total_tokens: 150,
    cost: 0.0004,
    duration_ms: 320,
    error_code: null,
    error_detail: null,
    request_json: null,
    response_json: null,
    created_at: AT,
    finished_at: AT,
    tools: ['send', 'read'],
    ...overrides,
  };
}

function toolCall(overrides: Partial<ToolCallEntry> = {}): ToolCallEntry {
  return {
    id: '2001',
    tool_call_id: 'call_1',
    tool_name: 'read',
    arguments_json: '{"path":"system:///skills/readme.md"}',
    result_text: 'ok',
    state: 'success',
    side_effect: false,
    error_code: null,
    duration_ms: 12,
    created_at: AT,
    finished_at: AT,
    ...overrides,
  };
}

function telegramSend(overrides: Partial<TelegramSendEntry> = {}): TelegramSendEntry {
  return {
    id: '4001',
    tool_call_id: 'call_1',
    kind: 'text',
    request_json: '{"chat_id":"123","text":"hi"}',
    state: 'success',
    telegram_message_id: '555',
    error_code: null,
    created_at: AT,
    finished_at: AT,
    ...overrides,
  };
}

function agentMessage(overrides: Partial<AgentMessageEntry> = {}): AgentMessageEntry {
  return {
    sequence_no: 1,
    role: 'assistant',
    text: 'thinking privately',
    created_at: AT,
    ...overrides,
  };
}

function invocation(overrides: Partial<InvocationDetail> = {}): InvocationDetail {
  return {
    id: '9001',
    state: 'completed',
    created_at: AT,
    started_at: AT,
    finished_at: AT,
    completion_reason: 'turn_limit_reached',
    error_code: null,
    sends_used: 1,
    tool_calls_used: 1,
    turns_used: 1,
    side_effect_started: true,
    config_hash: 'cfg-hash-1',
    chat: { telegram_chat_id: '123456789', type: 'supergroup', title: 'Test Group', message_thread_id: 0 },
    tool_call_count: 1,
    total_tokens: 150,
    total_cost: 0.0004,
    bucket_id: '42',
    prompt_version: 7,
    tool_registry_hash: 'reg-1',
    tool_registry: null,
    tool_calls: [],
    model_calls: [],
    agent_messages: [],
    telegram_sends: [],
    context_messages: [],
    ...overrides,
  };
}

function kinds(events: readonly InvocationTimelineEvent[]): string[] {
  return events.map((event) => event.kind);
}

describe('parseSendArguments', () => {
  test('malformed JSON degrades to null fields, never throws', () => {
    expect(parseSendArguments('not json{')).toEqual({
      kind: null,
      text: null,
      sticker_ref: null,
      reply_to_message_id: null,
    });
    expect(parseSendArguments('')).toEqual({
      kind: null,
      text: null,
      sticker_ref: null,
      reply_to_message_id: null,
    });
  });

  test('parses kind/text/sticker_ref', () => {
    expect(
      parseSendArguments('{"kind":"text","text":"hello there","sticker_ref":"stk_1","reply_to_message_id":"987"}'),
    ).toEqual({
      kind: 'text',
      text: 'hello there',
      sticker_ref: 'stk_1',
      reply_to_message_id: '987',
    });
  });

  test('stringifies a numeric reply_to_message_id instead of dropping it', () => {
    const parsed = parseSendArguments('{"kind":"text","text":"hi","reply_to_message_id":123}');
    expect(parsed.reply_to_message_id).toBe('123');
  });

  test('missing fields fall back to null; empty strings are treated as absent', () => {
    const parsed = parseSendArguments('{"kind":"text","text":"","reply_to_message_id":null}');
    expect(parsed.text).toBeNull();
    expect(parsed.reply_to_message_id).toBeNull();
    expect(parsed.sticker_ref).toBeNull();
  });
});

describe('parseJsonObject', () => {
  test('accepts objects, rejects arrays, strings and garbage', () => {
    expect(parseJsonObject('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonObject('[1,2]')).toBeNull();
    expect(parseJsonObject('"str"')).toBeNull();
    expect(parseJsonObject('{broken')).toBeNull();
    expect(parseJsonObject(null)).toBeNull();
    expect(parseJsonObject('')).toBeNull();
  });
});

describe('indexSendsByToolCall', () => {
  test('maps telegram_sends by string tool_call_id', () => {
    const map = indexSendsByToolCall([
      telegramSend({ tool_call_id: 'call_a' }),
      telegramSend({ id: '4002', tool_call_id: 'call_b' }),
    ]);
    expect(map.get('call_a')?.id).toBe('4001');
    expect(map.get('call_b')?.id).toBe('4002');
    expect(map.get('missing')).toBeUndefined();
  });
});

describe('context sections and timestamps', () => {
  test('section classification: new vs history', () => {
    expect(isNewContextSection('new')).toBe(true);
    expect(isNewContextSection('history')).toBe(false);
    expect(isNewContextSection('other')).toBe(false);
  });

  test('uses snapshot telegram_date when present', () => {
    const message = contextMessage({ snapshot_json: '{"telegram_date":"2026-09-14T01:02:03.000Z"}' });
    expect(contextMessageTimestamp(message, AT)).toBe('2026-09-14T01:02:03.000Z');
  });

  test('falls back to the invocation timestamp when telegram_date is absent', () => {
    const message = contextMessage({ snapshot_json: '{"kind":"text","text":"x"}' });
    expect(contextMessageTimestamp(message, AT)).toBe(AT);
  });
});

describe('sortTimelineEvents', () => {
  test('ties are broken by the order field', () => {
    const events: InvocationTimelineEvent[] = [
      { kind: 'finished', at: AT, order: 10_000 },
      { kind: 'started', at: AT, order: -2_000 },
      { kind: 'queued', at: AT, order: -3_000 },
    ];
    expect(kinds(sortTimelineEvents(events))).toEqual(['queued', 'started', 'finished']);
  });

  test('distinct timestamps win over order', () => {
    const events: InvocationTimelineEvent[] = [
      { kind: 'queued', at: '2026-09-15T10:00:02.000Z', order: -3_000 },
      { kind: 'started', at: '2026-09-15T10:00:01.000Z', order: -2_000 },
    ];
    expect(kinds(sortTimelineEvents(events))).toEqual(['started', 'queued']);
  });

  test('unparseable timestamps group by order instead of producing NaN sort', () => {
    const events: InvocationTimelineEvent[] = [
      { kind: 'queued', at: 'not-a-date', order: 2 },
      { kind: 'started', at: 'not-a-date', order: 1 },
    ];
    expect(kinds(sortTimelineEvents(events))).toEqual(['started', 'queued']);
  });
});

describe('buildInvocationTimeline', () => {
  test('queued, started and finished are ordered by order when timestamps tie', () => {
    const events = buildInvocationTimeline(invocation());
    expect(kinds(events)).toEqual(['queued', 'started', 'finished']);
  });

  test('omits started/finished markers when the timestamps are null', () => {
    const events = buildInvocationTimeline(invocation({ started_at: null, finished_at: null }));
    expect(kinds(events)).toEqual(['queued']);
  });

  test('send tool calls carry the linked telegram send by tool_call_id', () => {
    const send = telegramSend({ id: '4001', tool_call_id: 'call_send' });
    const detail = invocation({
      tool_calls: [
        toolCall({
          id: '2001',
          tool_call_id: 'call_send',
          tool_name: 'send',
          arguments_json: '{"kind":"text","text":"hi"}',
        }),
        toolCall({ id: '2002', tool_call_id: 'call_read', tool_name: 'read' }),
      ],
      telegram_sends: [send],
    });
    const events = buildInvocationTimeline(detail);
    const toolEvents = events.filter((event) => event.kind === 'tool_call');
    expect(toolEvents).toHaveLength(2);
    const sendEvent = toolEvents[0];
    const readEvent = toolEvents[1];
    if (sendEvent?.kind === 'tool_call') {
      expect(sendEvent.linkedSend?.id).toBe('4001');
    }
    if (readEvent?.kind === 'tool_call') {
      expect(readEvent.linkedSend).toBeNull();
    }
  });

  test('bigint-derived IDs stay strings in the timeline payloads', () => {
    const send = telegramSend({ tool_call_id: 'call_send', telegram_message_id: '555' });
    const message = contextMessage({ message_id: '7001', revision_id: '8001' });
    const detail = invocation({
      tool_calls: [toolCall({ tool_call_id: 'call_send', tool_name: 'send' })],
      telegram_sends: [send],
      context_messages: [message],
    });
    const events = buildInvocationTimeline(detail);
    const contextEvent = events.find((event) => event.kind === 'context_message');
    const toolEvent = events.find((event) => event.kind === 'tool_call');
    if (contextEvent?.kind === 'context_message') {
      expect(contextEvent.message.message_id).toBe('7001');
      expect(contextEvent.message.revision_id).toBe('8001');
      expect(typeof contextEvent.message.message_id).toBe('string');
    }
    if (toolEvent?.kind === 'tool_call') {
      expect(toolEvent.linkedSend?.telegram_message_id).toBe('555');
      expect(typeof toolEvent.linkedSend?.telegram_message_id).toBe('string');
    }
  });

  test('context message partition is preserved on the event', () => {
    const detail = invocation({
      context_messages: [
        contextMessage({ section: 'new', sequence_no: 1 }),
        contextMessage({ section: 'history', sequence_no: 2 }),
      ],
    });
    const events = buildInvocationTimeline(detail).filter((event) => event.kind === 'context_message');
    expect(events.map((event) => (event.kind === 'context_message' ? event.message.section : null))).toEqual([
      'new',
      'history',
    ]);
  });

  test('failed model call keeps its stable error code', () => {
    const failed = modelCall({ state: 'error', error_code: 'provider_timeout', error_detail: 'redacted: key=***' });
    const detail = invocation({ model_calls: [failed] });
    const event = buildInvocationTimeline(detail).find((entry) => entry.kind === 'model_call');
    if (event?.kind === 'model_call') {
      expect(event.model.state).toBe('error');
      expect(event.model.error_code).toBe('provider_timeout');
      expect(event.model.error_detail).toContain('redacted');
    }
  });

  test('context messages precede model calls when the snapshot dates are older', () => {
    const detail = invocation({
      context_messages: [contextMessage({ snapshot_json: '{"telegram_date":"2026-09-15T09:00:00.000Z"}' })],
      model_calls: [modelCall({ created_at: '2026-09-15T10:00:01.000Z' })],
    });
    const events = buildInvocationTimeline(detail);
    expect(kinds(events)).toEqual(['context_message', 'queued', 'started', 'finished', 'model_call']);
  });

  test('timelineEventKey is unique per event', () => {
    const detail = invocation({
      tool_calls: [
        toolCall({ id: '2001', tool_call_id: 'call_send', tool_name: 'send' }),
        toolCall({ id: '2002', tool_call_id: 'call_read', tool_name: 'read' }),
      ],
      model_calls: [modelCall({ id: '3001' })],
      agent_messages: [agentMessage({ sequence_no: 1 })],
      context_messages: [contextMessage({ sequence_no: 1 })],
    });
    const events = buildInvocationTimeline(detail);
    const keys = events.map(timelineEventKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain('context-1');
    expect(keys).toContain('model-3001');
    expect(keys).toContain('tool-2001');
    expect(keys).toContain('agent-1');
  });
});
