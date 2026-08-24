import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message, Update } from 'grammy/types';
import { seedConfigAdmins } from '../src/admin/admins.ts';
import {
  BOT_COMMANDS,
  type BotCommandRegistration,
  BotCommandService,
  type CommandSender,
  parseBotCommand,
  registerBotCommands,
} from '../src/bot-commands.ts';
import { type FileConfig, type LoadedConfig, loadConfig } from '../src/config.ts';
import { SqliteStore } from '../src/database.ts';
import { AgentModelSwitcher } from '../src/model-switch.ts';
import { createModelRegistry } from '../src/providers.ts';
import { BucketScheduler, STARTUP_CATCH_UP_STATE_KEY } from '../src/scheduler.ts';
import { SecretStore } from '../src/secrets.ts';
import { TelegramIngestion } from '../src/telegram-ingestion.ts';
import { testConfigJsonc, writeTestConfig } from './helpers.ts';

const directories: string[] = [];
const BOT_USERNAME = 'plasticwan_test_bot';
const ALICE: CommandSender = { id: 42n, name: 'Alice', username: 'alice' };

type ConfigTransform = (config: FileConfig) => void;

afterAll(async () => {
  Bun.gc(true);
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});

async function setup(
  transform: ConfigTransform = (config) => {
    config.telegram.admins = [42];
  },
  handler: ConstructorParameters<typeof BucketScheduler>[3] = async () => ({ state: 'completed', reason: 'done' }),
): Promise<{
  loaded: LoadedConfig;
  store: SqliteStore;
  ingestion: TelegramIngestion;
  scheduler: BucketScheduler;
  commands: BotCommandService;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-commands-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath, testConfigJsonc(directory, transform));
  const loaded = await loadConfig(configPath);
  const store = await SqliteStore.open(loaded.config);
  seedConfigAdmins(store.db, loaded.config.telegram.admins ?? [], new Date('2026-08-15T00:00:00.000Z'));
  const scheduler = new BucketScheduler(store, loaded.config, loaded.hash, handler);
  return {
    loaded,
    store,
    ingestion: new TelegramIngestion(store, loaded.config, { id: 999, username: BOT_USERNAME }),
    scheduler,
    commands: new BotCommandService(store, loaded.config, scheduler),
  };
}

function commandUpdate(updateId: number, messageId: number, token: string, chatId = 123456789): Update {
  // A bot_command entity spans only the command token (mention included),
  // never the trailing argument text.
  const entityLength = token.includes(' ') ? token.indexOf(' ') : token.length;
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 1_700_000_000 + messageId,
      chat: { id: chatId, type: 'private', first_name: 'Owner' },
      from: { id: 42, is_bot: false, first_name: 'Alice' },
      text: token,
      entities: [{ offset: 0, length: entityLength, type: 'bot_command' }],
    },
  };
}

function textUpdate(updateId: number, messageId: number, text: string, chatId = 123456789): Update {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 1_700_000_000 + messageId,
      chat: { id: chatId, type: 'private', first_name: 'Owner' },
      from: { id: 42, is_bot: false, first_name: 'Alice' },
      text,
    },
  };
}

function message(message: Update['message']): Message {
  return message!;
}

const FIXED_NOW = new Date('2026-08-15T12:00:00.000Z');

describe('parseBotCommand', () => {
  test('recognizes pause, resume and status case-insensitively', async () => {
    expect(parseBotCommand(message(commandUpdate(1, 1, '/pause').message), BOT_USERNAME)).toEqual({ name: 'pause' });
    expect(parseBotCommand(message(commandUpdate(1, 1, '/Resume').message), BOT_USERNAME)).toEqual({ name: 'resume' });
    expect(parseBotCommand(message(commandUpdate(1, 1, '/STATUS').message), BOT_USERNAME)).toEqual({ name: 'status' });
  });

  test('accepts an explicit matching bot mention and rejects others', async () => {
    expect(parseBotCommand(message(commandUpdate(1, 1, '/pause@plasticwan_test_bot').message), BOT_USERNAME)).toEqual({
      name: 'pause',
    });
    expect(parseBotCommand(message(commandUpdate(1, 1, '/pause@other_bot').message), BOT_USERNAME)).toBeNull();
  });

  test('captures the optional /model argument', async () => {
    expect(parseBotCommand(message(commandUpdate(1, 1, '/model').message), BOT_USERNAME)).toEqual({ name: 'model' });
    expect(parseBotCommand(message(commandUpdate(1, 1, '/model 2').message), BOT_USERNAME)).toEqual({
      name: 'model',
      argument: '2',
    });
    expect(parseBotCommand(message(commandUpdate(1, 1, '/model page 2').message), BOT_USERNAME)).toEqual({
      name: 'model',
      argument: 'page 2',
    });
    expect(parseBotCommand(message(commandUpdate(1, 1, '/Model reset').message), BOT_USERNAME)).toEqual({
      name: 'model',
      argument: 'reset',
    });
    expect(parseBotCommand(message(commandUpdate(1, 1, '/model@plasticwan_test_bot 2').message), BOT_USERNAME)).toEqual(
      { name: 'model', argument: '2' },
    );
    expect(parseBotCommand(message(commandUpdate(1, 1, '/pause whatever').message), BOT_USERNAME)).toEqual({
      name: 'pause',
    });
  });

  test('ignores non-commands, unknown commands and trailing text', async () => {
    expect(parseBotCommand(message(commandUpdate(1, 1, '/pausefoo').message), BOT_USERNAME)).toBeNull();
    expect(parseBotCommand(message(commandUpdate(1, 1, '/unknown').message), BOT_USERNAME)).toBeNull();
    const inline: Update = {
      update_id: 1,
      message: {
        message_id: 1,
        date: 1_700_000_001,
        chat: { id: 123456789, type: 'private', first_name: 'Owner' },
        from: { id: 42, is_bot: false, first_name: 'Alice' },
        text: 'hello /pause',
        entities: [{ offset: 6, length: 6, type: 'bot_command' }],
      },
    };
    expect(parseBotCommand(message(inline.message), BOT_USERNAME)).toBeNull();
    const trailing: Update = {
      update_id: 2,
      message: {
        message_id: 2,
        date: 1_700_000_002,
        chat: { id: 123456789, type: 'private', first_name: 'Owner' },
        from: { id: 42, is_bot: false, first_name: 'Alice' },
        text: '/pause please',
        entities: [{ offset: 0, length: 6, type: 'bot_command' }],
      },
    };
    expect(parseBotCommand(message(trailing.message), BOT_USERNAME)).toEqual({ name: 'pause' });
  });

  test('ignores commands from bots and messages without text', async () => {
    const fromBot: Update = {
      update_id: 1,
      message: {
        message_id: 1,
        date: 1_700_000_001,
        chat: { id: 123456789, type: 'private', first_name: 'Owner' },
        from: { id: 77, is_bot: true, first_name: 'OtherBot' },
        text: '/pause',
        entities: [{ offset: 0, length: 6, type: 'bot_command' }],
      },
    };
    expect(parseBotCommand(message(fromBot.message), BOT_USERNAME)).toBeNull();
    const noText: Message = {
      message_id: 1,
      date: 1_700_000_001,
      chat: { id: 123456789, type: 'private', first_name: 'Owner' },
      from: { id: 42, is_bot: false, first_name: 'Alice' },
    };
    expect(parseBotCommand(noText, BOT_USERNAME)).toBeNull();
  });
});

describe('registerBotCommands', () => {
  test('registers every command also handled by parseBotCommand', async () => {
    let captured: readonly BotCommandRegistration[] | undefined;
    const api = {
      setMyCommands: async (commands: readonly BotCommandRegistration[]) => {
        captured = commands;
      },
    };
    await registerBotCommands(api);
    expect(captured?.map((entry) => entry.command)).toEqual(BOT_COMMANDS.map((entry) => entry.command));
    for (const entry of BOT_COMMANDS) {
      expect(entry.command).toMatch(/^[a-z][a-z0-9_]{0,31}$/);
      expect(entry.description.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeLessThanOrEqual(256);
    }
    const message = (text: string): Message => ({
      message_id: 1,
      date: 1_700_000_001,
      chat: { id: 123456789, type: 'private', first_name: 'Owner' },
      from: { id: 42, is_bot: false, first_name: 'Alice' },
      text,
      entities: [{ offset: 0, length: text.length, type: 'bot_command' }],
    });
    for (const entry of BOT_COMMANDS) {
      const parsed = parseBotCommand(message(`/${entry.command}`), BOT_USERNAME);
      expect(parsed).not.toBeNull();
      expect(parsed?.name as string).toBe(entry.command);
    }
  });
});

describe('bot command service', () => {
  test('pause expires pending buckets, aborts queued invocations and blocks new buckets', async () => {
    const { store, ingestion, scheduler, commands } = await setup();
    const start = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(textUpdate(1, 10, 'hello'), start);
    const [invocationId] = scheduler.processDue(new Date(start.getTime() + 15_000));
    if (invocationId === undefined) {
      throw new Error('Expected queued invocation');
    }
    expect(store.db.query<{ state: string }, []>('SELECT state FROM invocations').get()?.state).toBe('queued');

    const reply = commands.run({ name: 'pause' }, 123456789n, ALICE, FIXED_NOW);
    expect(reply).toContain('/resume');
    expect(store.db.query<{ paused_at: string }, []>('SELECT paused_at FROM chat_pause').get()?.paused_at).toBe(
      FIXED_NOW.toISOString(),
    );
    expect(store.db.query<{ state: string }, []>('SELECT state FROM buckets').get()?.state).toBe('expired');
    const invocation = store.db
      .query<{ state: string; completion_reason: string }, []>('SELECT state, completion_reason FROM invocations')
      .get();
    expect(invocation?.state).toBe('aborted');
    expect(invocation?.completion_reason).toBe('chat_paused');

    ingestion.ingest(textUpdate(2, 11, 'while paused'), new Date(start.getTime() + 20_000));
    expect(store.db.query<{ count: bigint }, []>('SELECT COUNT(*) AS count FROM buckets').get()?.count).toBe(1n);
    expect(store.db.query<{ count: bigint }, []>('SELECT COUNT(*) AS count FROM messages').get()?.count).toBe(2n);
    expect(scheduler.processDue(new Date(start.getTime() + 60_000))).toHaveLength(0);
    store.close();
  });

  test('resume removes the pause and restores interaction', async () => {
    const { store, ingestion, scheduler, commands } = await setup();
    const start = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(textUpdate(1, 10, 'hello'), start);
    scheduler.processDue(new Date(start.getTime() + 15_000));
    commands.run({ name: 'pause' }, 123456789n, ALICE, FIXED_NOW);
    commands.run({ name: 'resume' }, 123456789n, ALICE, FIXED_NOW);
    expect(store.db.query<{ count: bigint }, []>('SELECT COUNT(*) AS count FROM chat_pause').get()?.count).toBe(0n);
    ingestion.ingest(textUpdate(2, 11, 'after resume'), new Date(start.getTime() + 30_000));
    expect(scheduler.processDue(new Date(start.getTime() + 45_000))).toHaveLength(1);
    store.close();
  });

  test("status reports model, thinking effort and today's split token usage", async () => {
    const { store, ingestion, scheduler, commands } = await setup();
    ingestion.ingest(textUpdate(1, 10, 'hello'), FIXED_NOW);
    store.db
      .query(
        "INSERT INTO daily_usage(utc_date, scope, resource, metric, amount, updated_at) VALUES (?, 'chat', ?, 'model_tokens', 1234, ?)",
      )
      .run(FIXED_NOW.toISOString().slice(0, 10), '123456789', FIXED_NOW.toISOString());
    store.db
      .query(
        "INSERT INTO daily_usage(utc_date, scope, resource, metric, amount, updated_at) VALUES (?, 'chat', ?, 'model_tokens', 66, ?)",
      )
      .run(FIXED_NOW.toISOString().slice(0, 10), '987654321', FIXED_NOW.toISOString());
    const [invocationId] = scheduler.processDue(new Date(FIXED_NOW.getTime() + 15_000));
    if (invocationId === undefined) {
      throw new Error('Expected queued invocation');
    }
    store.db
      .query(
        "INSERT INTO model_calls(invocation_id, role, provider, model, attempt, state, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens, created_at, finished_at) VALUES (?, 'agent', 'agent', 'agent-model', 1, 'success', 500, 200, 400, 134, 1234, ?, ?)",
      )
      .run(invocationId, FIXED_NOW.toISOString(), FIXED_NOW.toISOString());
    const status = commands.run({ name: 'status' }, 123456789n, ALICE, FIXED_NOW);
    expect(status).toContain('agent / agent-model');
    expect(status).toContain('思考强度: low');
    expect(status).toContain(
      '本群今日 token 用量: 1,234\n全局今日 token 用量: 1,300 / 300,000 (0.43%)\n读取: 500\n写入: 200\n缓存读取: 400\n缓存写入: 134',
    );
    expect(status).not.toContain('已暂停');
    commands.run({ name: 'pause' }, 123456789n, ALICE, FIXED_NOW);
    expect(commands.run({ name: 'status' }, 123456789n, ALICE, FIXED_NOW)).toContain('已暂停');
    store.close();
  });

  test('status reflects a runtime model switch', async () => {
    const { store, loaded, scheduler } = await setup();
    const registry = await createModelRegistry(loaded.config, new SecretStore());
    const switcher = new AgentModelSwitcher(loaded.config, registry.models);
    const commands = new BotCommandService(store, loaded.config, scheduler, switcher);
    switcher.switch('vision', 'vision-model');
    expect(commands.run({ name: 'status' }, 123456789n, ALICE, FIXED_NOW)).toContain('vision / vision-model');
    store.close();
  });

  describe('model command', () => {
    function manyModelTransform(count: number): ConfigTransform {
      return (config) => {
        config.telegram.admins = [42];
        const provider = config.providers.agent;
        if (provider?.kind !== 'custom') {
          throw new Error('Expected custom agent provider fixture');
        }
        provider.models.push(
          ...Array.from({ length: count }, (_, index) => ({
            id: `agent-extra-${index + 1}`,
            name: `Agent Extra ${index + 1}`,
            reasoning: false,
            input: ['text' as const],
            context_window: 128000,
            max_tokens: 8192,
            cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 1 },
          })),
        );
      };
    }

    async function commandSetup(transform?: ConfigTransform): Promise<{
      store: SqliteStore;
      commands: BotCommandService;
      switcher: AgentModelSwitcher;
    }> {
      const { store, loaded, scheduler } = await setup(transform);
      const registry = await createModelRegistry(loaded.config, new SecretStore());
      const switcher = new AgentModelSwitcher(loaded.config, registry.models);
      const commands = new BotCommandService(store, loaded.config, scheduler, switcher);
      return { store, commands, switcher };
    }

    test('is denied for non-admins without changing the model', async () => {
      const { store, commands, switcher } = await commandSetup();
      const stranger: CommandSender = { id: 99n, name: 'Mallory', username: 'mallory' };
      expect(commands.run({ name: 'model' }, 123456789n, stranger, FIXED_NOW)).toBe('该命令仅对本 Bot 的管理员可用。');
      expect(commands.run({ name: 'model', argument: '2' }, 123456789n, stranger, FIXED_NOW)).toBe(
        '该命令仅对本 Bot 的管理员可用。',
      );
      expect(switcher.current()).toMatchObject({ provider: 'agent', model: 'agent-model' });
      store.close();
    });

    test('without an argument lists the first page of switchable options', async () => {
      const { store, commands } = await commandSetup();
      const reply = commands.run({ name: 'model' }, 123456789n, ALICE, FIXED_NOW);
      expect(reply).toContain('当前模型: agent / agent-model');
      expect(reply).toContain('可用模型（第 1/1 页，共 2 条）:');
      expect(reply).toContain('1. agent / agent-model（Agent Model）');
      expect(reply).toContain('2. vision / vision-model（Vision Model）');
      expect(reply).toContain('使用 /model 序号 切换，/model page 页码 翻页，/model reset 恢复默认');
      store.close();
    });

    test('paginates model options by global index in pages of 20', async () => {
      const { store, commands } = await commandSetup(manyModelTransform(40));
      const firstPage = commands.run({ name: 'model' }, 123456789n, ALICE, FIXED_NOW).split('\n');
      expect(firstPage).toContain('可用模型（第 1/3 页，共 42 条）:');
      expect(firstPage).toContain('1. agent / agent-model（Agent Model）');
      expect(firstPage).toContain('20. agent / agent-extra-19（Agent Extra 19）');
      expect(firstPage.some((line) => line.startsWith('21. '))).toBeFalse();

      const secondPage = commands.run({ name: 'model', argument: 'page 2' }, 123456789n, ALICE, FIXED_NOW).split('\n');
      expect(secondPage).toContain('可用模型（第 2/3 页，共 42 条）:');
      expect(secondPage).toContain('21. agent / agent-extra-20（Agent Extra 20）');
      expect(secondPage).toContain('40. agent / agent-extra-39（Agent Extra 39）');
      expect(secondPage.filter((line) => /^\d+\. /.test(line))).toHaveLength(20);

      const thirdPage = commands.run({ name: 'model', argument: 'page 3' }, 123456789n, ALICE, FIXED_NOW).split('\n');
      expect(thirdPage).toContain('可用模型（第 3/3 页，共 42 条）:');
      expect(thirdPage).toContain('41. agent / agent-extra-40（Agent Extra 40）');
      expect(thirdPage).toContain('42. vision / vision-model（Vision Model）');
      expect(thirdPage.filter((line) => /^\d+\. /.test(line))).toHaveLength(2);
      store.close();
    });

    test('keeps a numeric argument as a global model selection', async () => {
      const { store, commands, switcher } = await commandSetup(manyModelTransform(40));
      expect(commands.run({ name: 'model', argument: '21' }, 123456789n, ALICE, FIXED_NOW)).toBe(
        '已切换: agent / agent-extra-20，将在下一次 agent session 生效。',
      );
      expect(switcher.current()).toMatchObject({ provider: 'agent', model: 'agent-extra-20' });
      store.close();
    });

    test('rejects pages outside the available range without changing the model', async () => {
      const { store, commands, switcher } = await commandSetup(manyModelTransform(40));
      for (const argument of ['page 0', 'page 4', 'page 999999999999999999999999999999999999999']) {
        const reply = commands.run({ name: 'model', argument }, 123456789n, ALICE, FIXED_NOW);
        expect(reply).toStartWith('无效页码。');
        expect(reply).toContain('可用模型（第 1/3 页，共 42 条）:');
        expect(switcher.current()).toMatchObject({ provider: 'agent', model: 'agent-model' });
      }
      store.close();
    });

    test('switches by index and the status command reflects it', async () => {
      const { store, commands, switcher } = await commandSetup();
      const reply = commands.run({ name: 'model', argument: '2' }, 123456789n, ALICE, FIXED_NOW);
      expect(reply).toBe('已切换: vision / vision-model，将在下一次 agent session 生效。');
      expect(switcher.current()).toMatchObject({ provider: 'vision', model: 'vision-model' });
      expect(commands.run({ name: 'status' }, 123456789n, ALICE, FIXED_NOW)).toContain('vision / vision-model');
      store.close();
    });

    test('reset reverts to the config default', async () => {
      const { store, commands, switcher } = await commandSetup();
      switcher.switch('vision', 'vision-model');
      const reply = commands.run({ name: 'model', argument: 'reset' }, 123456789n, ALICE, FIXED_NOW);
      expect(reply).toBe('已恢复 config.jsonc 默认模型: agent / agent-model。');
      expect(switcher.current()).toMatchObject({ provider: 'agent', model: 'agent-model' });
      store.close();
    });

    test('rejects invalid arguments without changing the model', async () => {
      const { store, commands, switcher } = await commandSetup();
      for (const argument of ['0', '3', 'abc', '1x']) {
        const reply = commands.run({ name: 'model', argument }, 123456789n, ALICE, FIXED_NOW);
        expect(reply).toContain('无效序号');
        expect(switcher.current()).toMatchObject({ provider: 'agent', model: 'agent-model' });
      }
      store.close();
    });
  });

  test('status isolates per-chat usage and includes other chats in the global total', async () => {
    const { store, commands } = await setup();
    store.db
      .query(
        "INSERT INTO daily_usage(utc_date, scope, resource, metric, amount, updated_at) VALUES (?, 'chat', ?, 'model_tokens', 999, ?)",
      )
      .run('2026-08-14', '123456789', FIXED_NOW.toISOString());
    store.db
      .query(
        "INSERT INTO daily_usage(utc_date, scope, resource, metric, amount, updated_at) VALUES (?, 'chat', ?, 'model_tokens', 888, ?)",
      )
      .run(FIXED_NOW.toISOString().slice(0, 10), '987654321', FIXED_NOW.toISOString());
    expect(commands.run({ name: 'status' }, 123456789n, ALICE, FIXED_NOW)).toContain(
      '本群今日 token 用量: 0\n全局今日 token 用量: 888 / 300,000 (0.30%)',
    );
    store.close();
  });

  test('pause and resume are denied for non-admins without side effects', async () => {
    const { store, ingestion, scheduler, commands } = await setup();
    const start = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(textUpdate(1, 10, 'hello'), start);
    const [invocationId] = scheduler.processDue(new Date(start.getTime() + 15_000));
    if (invocationId === undefined) {
      throw new Error('Expected queued invocation');
    }
    const mallory: CommandSender = { id: 99n, name: 'Mallory', username: 'mallory' };
    expect(commands.run({ name: 'pause' }, 123456789n, mallory, FIXED_NOW)).toBe('该命令仅对本 Bot 的管理员可用。');
    expect(store.db.query<{ count: bigint }, []>('SELECT COUNT(*) AS count FROM chat_pause').get()?.count).toBe(0n);
    expect(store.db.query<{ state: string }, []>('SELECT state FROM buckets').get()?.state).toBe('queued');
    expect(store.db.query<{ state: string }, []>('SELECT state FROM invocations').get()?.state).toBe('queued');
    expect(commands.run({ name: 'resume' }, 123456789n, mallory, FIXED_NOW)).toBe('该命令仅对本 Bot 的管理员可用。');
    store.close();
  });

  test('anonymous senders and absent admins are denied', async () => {
    const { store, commands } = await setup(() => {});
    expect(commands.run({ name: 'pause' }, 123456789n, null, FIXED_NOW)).toBe('该命令仅对本 Bot 的管理员可用。');
    const stranger: CommandSender = { id: 42n, name: 'Alice', username: 'alice' };
    expect(commands.run({ name: 'pause' }, 123456789n, stranger, FIXED_NOW)).toBe('该命令仅对本 Bot 的管理员可用。');
    expect(commands.run({ name: 'status' }, 123456789n, stranger, FIXED_NOW)).toContain('当前模型');
    expect(store.db.query<{ count: bigint }, []>('SELECT COUNT(*) AS count FROM chat_pause').get()?.count).toBe(0n);
    store.close();
  });

  test('acting admins refresh their display name in the admin list', async () => {
    const { store, ingestion, commands } = await setup();
    ingestion.ingest(textUpdate(1, 10, 'hello'), FIXED_NOW);
    commands.run({ name: 'pause' }, 123456789n, { id: 42n, name: 'Alice Liddell', username: 'alice' }, FIXED_NOW);
    const row = store.db
      .query<{ display_name: string; added_by: string }, []>('SELECT display_name, added_by FROM bot_admins')
      .get();
    expect(row?.display_name).toBe('Alice Liddell');
    expect(row?.added_by).toBe('config');
    store.close();
  });
});

describe('ingestion command interception', () => {
  test('commands are audited but not stored and never create buckets', async () => {
    const { store, ingestion } = await setup();
    const result = ingestion.ingest(commandUpdate(1, 10, '/status'), FIXED_NOW);
    expect(result.command).toEqual({ name: 'status' });
    expect(result.messageId).toBeUndefined();
    expect(result.bucketId).toBeUndefined();
    expect(store.db.query<{ count: bigint }, []>('SELECT COUNT(*) AS count FROM messages').get()?.count).toBe(0n);
    expect(store.db.query<{ count: bigint }, []>('SELECT COUNT(*) AS count FROM buckets').get()?.count).toBe(0n);
    const audit = store.db
      .query<{ allowed: bigint; rejection_reason: string | null }, []>(
        'SELECT allowed, rejection_reason FROM telegram_updates',
      )
      .get();
    expect(audit?.allowed).toBe(1n);
    expect(audit?.rejection_reason).toBeNull();
    store.close();
  });

  test('commands with a foreign mention fall through to normal storage', async () => {
    const { store, ingestion } = await setup();
    const result = ingestion.ingest(commandUpdate(1, 10, '/pause@OtherBot'), FIXED_NOW);
    expect(result.command).toBeUndefined();
    expect(result.messageId).toBeDefined();
    expect(store.db.query<{ count: bigint }, []>('SELECT COUNT(*) AS count FROM messages').get()?.count).toBe(1n);
    store.close();
  });

  test('commands are not intercepted for disallowed chats', async () => {
    const { store, ingestion } = await setup();
    const result = ingestion.ingest(commandUpdate(1, 10, '/pause', 987654321), FIXED_NOW);
    const audit = store.db
      .query<{ allowed: bigint; rejection_reason: string }, []>(
        'SELECT allowed, rejection_reason FROM telegram_updates',
      )
      .get();
    expect(audit?.allowed).toBe(0n);
    expect(audit?.rejection_reason).toBe('chat_not_allowed');
    expect(result.command).toBeUndefined();
    store.close();
  });
});

describe('scheduler pause enforcement', () => {
  test("due processing skips a paused chat's collecting bucket", async () => {
    const { store, ingestion, scheduler, commands } = await setup();
    const start = new Date('2026-08-15T00:00:00.000Z');
    ingestion.ingest(textUpdate(1, 10, 'hello'), start);
    commands.run({ name: 'pause' }, 123456789n, ALICE, FIXED_NOW);
    const chatId = store.db.query<{ chat_id: bigint }, []>('SELECT chat_id FROM conversations LIMIT 1').get()!.chat_id;
    const now = new Date(start.getTime() + 15_000).toISOString();
    store.db
      .query(
        "INSERT INTO buckets(conversation_id, state, first_received_at, deadline_at, created_at, updated_at) VALUES ((SELECT id FROM conversations LIMIT 1), 'collecting', ?, ?, ?, ?)",
      )
      .run(now, now, now, now);
    expect(scheduler.processDue(new Date(start.getTime() + 60_000))).toHaveLength(0);
    const bucket = store.db.query<{ state: string }, []>('SELECT state FROM buckets').get();
    expect(bucket?.state).toBe('collecting');
    expect(
      store.db
        .query<{ count: bigint }, [bigint]>('SELECT COUNT(*) AS count FROM chat_pause WHERE chat_id = ?')
        .get(chatId)?.count,
    ).toBe(1n);
    store.close();
  });

  test('startup catch-up skips paused chats', async () => {
    const { store, ingestion, scheduler, commands } = await setup();
    const start = new Date('2026-08-15T00:00:00.000Z');
    store.db
      .query('INSERT INTO app_state(key, value, updated_at) VALUES (?, ?, ?)')
      .run(STARTUP_CATCH_UP_STATE_KEY, start.toISOString(), start.toISOString());
    ingestion.ingestCatchUp(textUpdate(1, 10, 'pending'), start);
    commands.run({ name: 'pause' }, 123456789n, ALICE, FIXED_NOW);
    expect(scheduler.finishStartupCatchUp(start)).toEqual([]);
    const bucket = store.db
      .query<{ state: string; error_code: string | null }, []>('SELECT state, error_code FROM buckets')
      .get();
    expect(bucket?.state).toBe('skipped_budget');
    expect(bucket?.error_code).toBe('chat_paused');
    store.close();
  });

  test('pauseChat aborts a running invocation', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let sawAbort = false;
    const { store, ingestion, scheduler } = await setup(
      () => {},
      async (_id, signal) => {
        await gate;
        if (signal.aborted) {
          sawAbort = true;
          return { state: 'aborted', reason: 'aborted' };
        }
        return { state: 'completed', reason: 'done' };
      },
    );
    const start = new Date();
    ingestion.ingest(textUpdate(1, 10, 'hello'), start);
    store.db
      .query('UPDATE buckets SET deadline_at = ? WHERE id = (SELECT id FROM buckets LIMIT 1)')
      .run(new Date(start.getTime() - 1_000).toISOString());
    const waitForState = async (state: string): Promise<void> => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (store.db.query<{ state: string }, []>('SELECT state FROM invocations LIMIT 1').get()?.state === state) {
          return;
        }
        await Bun.sleep(10);
      }
      throw new Error(`Invocation never reached ${state}`);
    };
    try {
      scheduler.start();
      await waitForState('running');
      const chatId = store.db
        .query<{ chat_id: bigint }, []>('SELECT chat_id FROM conversations LIMIT 1')
        .get()!.chat_id;
      scheduler.pauseChat(chatId);
      release();
      await waitForState('aborted');
      expect(sawAbort).toBe(true);
    } finally {
      release();
      await scheduler.stop();
      store.close();
    }
  });
});
