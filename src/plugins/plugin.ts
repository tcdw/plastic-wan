import type { ExecutableCapability } from '../capabilities/execute-tool.ts';
import type { RawConfig } from '../platform/config.ts';
import type { InvocationContext } from '../platform/invocation-context.ts';
import { finishToolCall, startToolCall, type SqliteStore } from '../store/database.ts';

const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

/**
 * Invocation-bound audit for a capability that records its own `tool_calls`
 * row next to the `execute` row. Plugins get this instead of the store, so
 * audit stays the only database access a stateless plugin has.
 */
export interface ToolAudit {
  start(toolCallId: string, toolName: string, argumentsJson: string, sideEffect: boolean): ToolAuditRecord;
}

export interface ToolAuditRecord {
  succeed(resultText: string): void;
  fail(errorCode: string): void;
}

/**
 * What the host hands a plugin when it assembles tools for one invocation.
 * `context` is the live invocation state, refreshed by hot injection, so tools
 * read it at call time instead of copying it.
 */
export interface InvocationScope {
  readonly config: RawConfig;
  readonly context: InvocationContext;
  readonly deadline: number;
  readonly audit: ToolAudit;
}

/**
 * A built-in agent plugin. It only declares contributions; the host decides
 * when to assemble them. Lifecycle hooks are added once a plugin needs one.
 */
export interface AgentPlugin {
  readonly id: string;
  /** Absolute skill directories; each basename is the skill name and holds SKILL.md. */
  readonly skills?: readonly string[];
  /** Runtime-internal capabilities, dispatched and audited through `execute`. */
  readonly capabilities?: (scope: InvocationScope) => readonly ExecutableCapability[];
}

/** Type helper for plugin modules. It validates nothing: `loadPlugins` does. */
export function definePlugin<const T extends AgentPlugin>(plugin: T): T {
  return plugin;
}

export interface LoadedPlugins {
  /** Mounted under system:///skills/ next to the bundled tree, see `SystemResources.load`. */
  readonly skillDirectories: readonly string[];
  capabilities(
    store: SqliteStore,
    config: RawConfig,
    context: InvocationContext,
    deadline: number,
  ): readonly ExecutableCapability[];
}

/**
 * Validates plugin definitions and merges their contributions. Skill name
 * conflicts surface when the skill directories are loaded, capability name
 * conflicts when the execute registry is built.
 */
export function loadPlugins(plugins: readonly AgentPlugin[]): LoadedPlugins {
  const ids = new Set<string>();
  for (const plugin of plugins) {
    if (!PLUGIN_ID_PATTERN.test(plugin.id)) {
      throw new Error(`Plugin id is invalid: ${plugin.id}`);
    }
    if (ids.has(plugin.id)) {
      throw new Error(`Duplicate plugin id: ${plugin.id}`);
    }
    ids.add(plugin.id);
  }
  return {
    skillDirectories: plugins.flatMap((plugin) => plugin.skills ?? []),
    capabilities: (store, config, context, deadline) => {
      const scope: InvocationScope = {
        config,
        context,
        deadline,
        audit: createToolAudit(store, context.invocationId),
      };
      return plugins.flatMap((plugin) => plugin.capabilities?.(scope) ?? []);
    },
  };
}

export function createToolAudit(store: SqliteStore, invocationId: bigint): ToolAudit {
  return {
    start(toolCallId, toolName, argumentsJson, sideEffect) {
      const startedAt = performance.now();
      const auditId = startToolCall(store.orm, invocationId, toolCallId, toolName, argumentsJson, sideEffect);
      return {
        succeed: (resultText) =>
          finishToolCall(store.orm, auditId, 'success', resultText, null, { startedAt, pendingOnly: true }),
        fail: (errorCode) =>
          finishToolCall(store.orm, auditId, 'error', null, errorCode, { startedAt, pendingOnly: true }),
      };
    },
  };
}
