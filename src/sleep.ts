import type { Database } from 'bun:sqlite';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import Type from 'typebox';
import { finishToolCall, startToolCall } from './database.ts';

export const SLEEP_REMAINING_BUDGET_PERCENT = 5n;
export const MINIMUM_SLEEP_MILLISECONDS = 8 * 60 * 60 * 1_000;
export const SLEEP_STATE_KEY = 'bot_sleep_until';

const ZzzInputSchema = Type.Object({}, { additionalProperties: false });

export interface DailyTokenBudget {
  readonly usedTokens: bigint;
  readonly maxTokens: bigint;
}

export interface SleepTransition {
  readonly sleepUntil: string;
  readonly entered: boolean;
}

export function readDailyTokenBudget(
  db: Database,
  chatId: bigint,
  maxTokens: number,
  now = new Date(),
): DailyTokenBudget {
  const usedTokens =
    db
      .query<{ amount: bigint }, [string, string]>(
        "SELECT amount FROM daily_usage WHERE utc_date = ? AND scope = 'chat' AND resource = ? AND metric = 'model_tokens'",
      )
      .get(now.toISOString().slice(0, 10), chatId.toString())?.amount ?? 0n;
  return { usedTokens, maxTokens: BigInt(maxTokens) };
}

export function isLowDailyTokenBudget(budget: DailyTokenBudget): boolean {
  const remainingTokens = budget.usedTokens >= budget.maxTokens ? 0n : budget.maxTokens - budget.usedTokens;
  return remainingTokens * 100n < budget.maxTokens * SLEEP_REMAINING_BUDGET_PERCENT;
}

export function storedSleepUntil(db: Database): string | null {
  return db.query<{ value: string }, [string]>('SELECT value FROM app_state WHERE key = ?').get(SLEEP_STATE_KEY)?.value ?? null;
}

export function activeSleepUntil(db: Database, now = new Date()): string | null {
  return db
    .transaction(() => {
      const sleepUntil = storedSleepUntil(db);
      if (sleepUntil === null) return null;
      if (sleepUntil > now.toISOString()) return sleepUntil;
      const deleted = db.query('DELETE FROM app_state WHERE key = ? AND value = ?').run(SLEEP_STATE_KEY, sleepUntil);
      if (deleted.changes === 1) {
        console.log(
          JSON.stringify({ event: 'bot_awake_after_budget_reset', sleep_until: sleepUntil, at: now.toISOString() }),
        );
      }
      return null;
    })
    .immediate();
}

export function enterSleep(db: Database, now = new Date()): SleepTransition {
  return db
    .transaction(() => {
      const current = db.query<{ value: string }, [string]>('SELECT value FROM app_state WHERE key = ?').get(SLEEP_STATE_KEY);
      if (current !== null && current.value > now.toISOString()) {
        return { sleepUntil: current.value, entered: false };
      }
      const nextResetAt = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
      const sleepUntil = new Date(Math.max(now.getTime() + MINIMUM_SLEEP_MILLISECONDS, nextResetAt)).toISOString();
      db.query(
        'INSERT INTO app_state(key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      ).run(SLEEP_STATE_KEY, sleepUntil, now.toISOString());
      return { sleepUntil, entered: true };
    })
    .immediate();
}

export function createZzzTool(options: {
  readonly db: Database;
  readonly invocationId: bigint;
  readonly chatId: bigint;
  readonly onSleep: () => void;
}): AgentTool<typeof ZzzInputSchema, { sleep_until: string; entered: boolean }> {
  return {
    name: 'zzz',
    label: 'Sleep',
    description:
      'You are very sleepy now. If the current conversation is at a natural stopping point, use this tool to go to sleep.',
    parameters: ZzzInputSchema,
    executionMode: 'sequential',
    execute: async (toolCallId, input) => {
      const now = new Date();
      const auditId = startToolCall(options.db, options.invocationId, toolCallId, 'zzz', JSON.stringify(input), true, now);
      console.log(
        JSON.stringify({
          event: 'zzz_called',
          invocation_id: options.invocationId.toString(),
          chat_id: options.chatId.toString(),
          at: now.toISOString(),
        }),
      );
      try {
        const transition = enterSleep(options.db, now);
        options.onSleep();
        if (transition.entered) {
          console.log(
            JSON.stringify({
              event: 'bot_sleeping',
              invocation_id: options.invocationId.toString(),
              chat_id: options.chatId.toString(),
              sleep_until: transition.sleepUntil,
              at: now.toISOString(),
            }),
          );
        }
        finishToolCall(
          options.db,
          auditId,
          'success',
          `sleep_until=${transition.sleepUntil} entered=${transition.entered}`,
          null,
          { now },
        );
        return {
          content: [
            {
              type: 'text',
              text: transition.entered
                ? `Sleeping until ${transition.sleepUntil}`
                : `Already sleeping until ${transition.sleepUntil}`,
            },
          ],
          details: { sleep_until: transition.sleepUntil, entered: transition.entered },
        };
      } catch (error) {
        finishToolCall(options.db, auditId, 'error', null, 'sleep_error', { now });
        throw error;
      }
    },
  };
}
