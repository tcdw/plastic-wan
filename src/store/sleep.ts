import type { AgentTool } from '@earendil-works/pi-agent-core';
import { and, eq, sql } from 'drizzle-orm';
import Type from 'typebox';
import { type Orm, asRunResult, finishToolCall, startToolCall } from './database.ts';
import { appState } from './schema.ts';

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

export function readDailyTokenBudget(orm: Orm, maxTokens: number, now = new Date()): DailyTokenBudget {
  const row = orm
    .all<{ amount: bigint }>(
      sql`SELECT COALESCE(SUM(amount), 0) AS amount FROM daily_usage WHERE utc_date = ${now.toISOString().slice(0, 10)} AND scope = 'chat' AND metric = 'model_tokens'`,
    )
    .at(0);
  return { usedTokens: row?.amount ?? 0n, maxTokens: BigInt(maxTokens) };
}

export function isLowDailyTokenBudget(budget: DailyTokenBudget): boolean {
  const remainingTokens = budget.usedTokens >= budget.maxTokens ? 0n : budget.maxTokens - budget.usedTokens;
  return remainingTokens * 100n < budget.maxTokens * SLEEP_REMAINING_BUDGET_PERCENT;
}
export function isDailyTokenBudgetReached(budget: DailyTokenBudget): boolean {
  return budget.usedTokens >= budget.maxTokens;
}

export function storedSleepUntil(orm: Orm): string | null {
  return (
    orm.select({ value: appState.value }).from(appState).where(eq(appState.key, SLEEP_STATE_KEY)).get()?.value ?? null
  );
}

export function activeSleepUntil(orm: Orm, now = new Date()): string | null {
  return orm.transaction(
    () => {
      const sleepUntil = storedSleepUntil(orm);
      if (sleepUntil === null) {
        return null;
      }
      if (sleepUntil > now.toISOString()) {
        return sleepUntil;
      }
      const deleted = asRunResult(
        orm
          .delete(appState)
          .where(and(eq(appState.key, SLEEP_STATE_KEY), eq(appState.value, sleepUntil)))
          .run(),
      );
      if (deleted.changes === 1) {
        console.log(
          JSON.stringify({ event: 'bot_awake_after_budget_reset', sleep_until: sleepUntil, at: now.toISOString() }),
        );
      }
      return null;
    },
    { behavior: 'immediate' },
  );
}

export function wakeFromSleep(orm: Orm, now = new Date()): boolean {
  return orm.transaction(
    () => {
      const sleepUntil = storedSleepUntil(orm);
      if (sleepUntil === null) {
        return false;
      }
      const deleted = asRunResult(
        orm
          .delete(appState)
          .where(and(eq(appState.key, SLEEP_STATE_KEY), eq(appState.value, sleepUntil)))
          .run(),
      );
      if (deleted.changes !== 1) {
        return false;
      }
      console.log(JSON.stringify({ event: 'bot_awake_manually', sleep_until: sleepUntil, at: now.toISOString() }));
      return true;
    },
    { behavior: 'immediate' },
  );
}

export function enterSleep(orm: Orm, now = new Date()): SleepTransition {
  return orm.transaction(
    () => {
      const current = orm
        .select({ value: appState.value })
        .from(appState)
        .where(eq(appState.key, SLEEP_STATE_KEY))
        .get();
      if (current !== undefined && current.value > now.toISOString()) {
        return { sleepUntil: current.value, entered: false };
      }
      const nextResetAt = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
      const sleepUntil = new Date(Math.max(now.getTime() + MINIMUM_SLEEP_MILLISECONDS, nextResetAt)).toISOString();
      orm
        .insert(appState)
        .values({ key: SLEEP_STATE_KEY, value: sleepUntil, updatedAt: now.toISOString() })
        .onConflictDoUpdate({
          target: appState.key,
          set: { value: sleepUntil, updatedAt: now.toISOString() },
        })
        .run();
      return { sleepUntil, entered: true };
    },
    { behavior: 'immediate' },
  );
}

export function createZzzTool(options: {
  readonly orm: Orm;
  readonly invocationId: bigint;
  readonly chatId: bigint;
  readonly onSleep: () => void;
}): AgentTool<typeof ZzzInputSchema, { sleep_until: string; entered: boolean }> {
  return {
    name: 'zzz',
    label: 'Sleep',
    description:
      'You are very sleepy now. Use this only when the current conversation is at a natural stopping point and no useful response, clarification, or required side effect remains. Do not use it to abandon an unfinished user request. Calling it ends normal participation until the sleep period expires.',
    parameters: ZzzInputSchema,
    executionMode: 'sequential',
    execute: async (toolCallId, input) => {
      const now = new Date();
      const auditId = startToolCall(
        options.orm,
        options.invocationId,
        toolCallId,
        'zzz',
        JSON.stringify(input),
        true,
        now,
      );
      console.log(
        JSON.stringify({
          event: 'zzz_called',
          invocation_id: options.invocationId.toString(),
          chat_id: options.chatId.toString(),
          at: now.toISOString(),
        }),
      );
      try {
        const transition = enterSleep(options.orm, now);
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
          options.orm,
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
        finishToolCall(options.orm, auditId, 'error', null, 'sleep_error', { now });
        throw error;
      }
    },
  };
}
