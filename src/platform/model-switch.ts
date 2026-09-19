import type { Api, Model, Models } from '@earendil-works/pi-ai';
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

export class AgentModelSwitcher {
  readonly #configStore: RuntimeConfigurationStore;
  readonly #models: Models;
  #override: { readonly provider: string; readonly model: string } | null = null;

  constructor(configStore: RuntimeConfigurationStore, models: Models) {
    this.#configStore = configStore;
    this.#models = models;
  }

  current(): AgentModelOption {
    return this.#option(this.#reference().provider, this.#reference().model);
  }

  model(): Model<Api> {
    const reference = this.#reference();
    const found = this.#models.getModel(reference.provider, reference.model);
    if (found === undefined) {
      throw new Error(`Agent model ${reference.provider}/${reference.model} is not registered`);
    }
    return found;
  }

  list(): readonly AgentModelOption[] {
    const options: AgentModelOption[] = [];
    for (const alias of Object.keys(this.#configStore.current().config.providers)) {
      for (const candidate of this.#models.getModels(alias)) {
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

  switch(provider: string, modelId: string): AgentModelOption {
    const option = this.#option(provider, modelId);
    this.#override = { provider, model: modelId };
    return option;
  }

  reset(): AgentModelOption {
    this.#override = null;
    return this.current();
  }

  #reference(): { readonly provider: string; readonly model: string } {
    const config = this.#configStore.current().config;
    return this.#override ?? { provider: config.agent.provider, model: config.agent.model };
  }

  #option(provider: string, modelId: string): AgentModelOption {
    if (this.#configStore.current().config.providers[provider] === undefined) {
      throw new ModelSwitchError('unknown_provider', `Provider ${provider} is not configured`);
    }
    const found = this.#models.getModel(provider, modelId);
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
