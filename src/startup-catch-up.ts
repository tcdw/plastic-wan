import type { Update } from "grammy/types";
import type { SqliteStore } from "./database.ts";
import { BucketScheduler, STARTUP_CATCH_UP_STATE_KEY } from "./scheduler.ts";
import type { TelegramIngestion } from "./telegram-ingestion.ts";

interface GetUpdatesOptions {
  readonly offset?: number;
  readonly limit: number;
  readonly timeout: number;
  readonly allowed_updates?: readonly Exclude<keyof Update, "update_id">[];
}

export interface StartupCatchUpApi {
  getUpdates(options: GetUpdatesOptions): Promise<Update[]>;
}

export interface StartupCatchUpOptions {
  readonly api: StartupCatchUpApi;
  readonly store: SqliteStore;
  readonly ingestion: TelegramIngestion;
  readonly scheduler: BucketScheduler;
  readonly allowedUpdates: readonly Exclude<keyof Update, "update_id">[];
  readonly signal?: AbortSignal;
  readonly now?: () => Date;
}

export interface StartupCatchUpResult {
  readonly updates: number;
  readonly storedMessages: number;
  readonly invocationIds: readonly bigint[];
}

export async function runStartupCatchUp(options: StartupCatchUpOptions): Promise<StartupCatchUpResult> {
  const currentTime = options.now ?? (() => new Date());
  const requestedStart = currentTime();
  const startedAt = options.store.transaction(() => {
    options.store.db
      .query("INSERT INTO app_state(key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING")
      .run(STARTUP_CATCH_UP_STATE_KEY, requestedStart.toISOString(), requestedStart.toISOString());
    const state = options.store.db
      .query<{ value: string }, [string]>("SELECT value FROM app_state WHERE key = ?")
      .get(STARTUP_CATCH_UP_STATE_KEY);
    if (state === null || !Number.isFinite(Date.parse(state.value))) {
      throw new Error("Startup catch-up state is missing or invalid");
    }
    return new Date(state.value);
  });

  let offset: number | undefined;
  let updatesReceived = 0;
  let storedMessages = 0;
  let firstRequest = true;
  while (true) {
    const request: GetUpdatesOptions = {
      limit: 100,
      timeout: 0,
      ...(offset === undefined ? {} : { offset }),
      ...(firstRequest ? { allowed_updates: options.allowedUpdates } : {}),
    };
    options.signal?.throwIfAborted();
    const updates = await options.api.getUpdates(request);
    if (updates.length === 0) break;
    for (const update of updates) {
      const result = options.ingestion.ingestCatchUp(update, currentTime());
      updatesReceived += 1;
      if (result.messageId !== undefined && update.message !== undefined) storedMessages += 1;
    }
    offset = updates.at(-1)!.update_id + 1;
    firstRequest = false;
  }

  const invocationIds = options.scheduler.finishStartupCatchUp(startedAt, currentTime());
  return { updates: updatesReceived, storedMessages, invocationIds };
}
