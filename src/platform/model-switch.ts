import type { Api, Model, ModelThinkingLevel } from '@earendil-works/pi-ai';
import type { RuntimeConfigurationStore } from './runtime-config.ts';

export class ModelSwitchError extends Error {
  readonly code: 'unknown_provider' | 'unknown_model' | 'not_text_capable';

  constructor(code: 'unknown_provider' | 'unknown_model' | 'not_text_capable', message: string) {
    super(message);
    this.name = 'ModelSwitchError';
    this.code = code;
  }
}

export interface AgentModelOption {
  readonly provider: string;
  readonly model: string;
  readonly name: string;
  readonly contextWindow: number;
  readonly maxTokens: number;
}

/**
 * Reads and validates agent model references against the live configuration and
 * the model registry published with it.
 *
 * There is no in-memory override: the model in use is always the one the active
 * configuration names, so a switch has to reach the configuration file to mean
 * anything (`ConfigReloader.setAgentModel`).
 */
export class AgentModelSwitcher {
  readonly #configStore: RuntimeConfigurationStore;

  constructor(configStore: RuntimeConfigurationStore) {
    this.#configStore = configStore;
  }

  current(): AgentModelOption {
    const config = this.#configStore.current().config;
    return this.option(config.agent.provider, config.agent.model);
  }

  /** The live thinking level; a model switch resets it (`ConfigReloader.setAgentModel`). */
  thinkingLevel(): ModelThinkingLevel {
    return this.#configStore.current().config.agent.thinking_level;
  }

  model(): Model<Api> {
    const snapshot = this.#configStore.current();
    const config = snapshot.config;
    const found = snapshot.models.getModel(config.agent.provider, config.agent.model);
    if (found === undefined) {
      throw new Error(`Agent model ${config.agent.provider}/${config.agent.model} is not registered`);
    }
    return found;
  }

  list(): readonly AgentModelOption[] {
    const snapshot = this.#configStore.current();
    const options: AgentModelOption[] = [];
    for (const alias of Object.keys(snapshot.config.providers)) {
      for (const candidate of snapshot.models.getModels(alias)) {
        if (!candidate.input.includes('text')) {
          continue;
        }
        options.push({
          provider: alias,
          model: candidate.id,
          name: candidate.name,
          contextWindow: candidate.contextWindow,
          maxTokens: candidate.maxTokens,
        });
      }
    }
    return options;
  }

  /** Validates a target without applying it. */
  option(provider: string, modelId: string): AgentModelOption {
    const snapshot = this.#configStore.current();
    if (snapshot.config.providers[provider] === undefined) {
      throw new ModelSwitchError('unknown_provider', `Provider ${provider} is not configured`);
    }
    const found = snapshot.models.getModel(provider, modelId);
    if (found === undefined) {
      throw new ModelSwitchError('unknown_model', `Model ${provider}/${modelId} is not registered`);
    }
    if (!found.input.includes('text')) {
      throw new ModelSwitchError('not_text_capable', `Model ${provider}/${modelId} does not accept text input`);
    }
    return {
      provider,
      model: modelId,
      name: found.name,
      contextWindow: found.contextWindow,
      maxTokens: found.maxTokens,
    };
  }
}
