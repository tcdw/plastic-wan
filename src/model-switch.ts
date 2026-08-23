import type { Api, Model, Models } from '@earendil-works/pi-ai';
import type { RawConfig } from './config.ts';

export class ModelSwitchError extends Error {
  constructor(
    readonly code: 'unknown_provider' | 'unknown_model' | 'not_text_capable',
    message: string,
  ) {
    super(message);
    this.name = 'ModelSwitchError';
  }
}

export interface AgentModelOption {
  readonly provider: string;
  readonly model: string;
  readonly name: string;
  readonly contextWindow: number;
  readonly maxTokens: number;
}

// Runtime agent-model selection. config.toml stays the default; a switch
// overrides it in memory until reset or restart, and applies to invocations
// that start afterwards ("next agent session").
export class AgentModelSwitcher {
  readonly #config: RawConfig;
  readonly #models: Models;
  #override: { readonly provider: string; readonly model: string } | null = null;

  constructor(config: RawConfig, models: Models) {
    this.#config = config;
    this.#models = models;
  }

  /** Effective agent model: runtime override when set, else the config default. */
  current(): AgentModelOption {
    return this.#option(this.#reference().provider, this.#reference().model);
  }

  /** The resolved model the next agent session streams with. */
  model(): Model<Api> {
    const reference = this.#reference();
    const found = this.#models.getModel(reference.provider, reference.model);
    if (found === undefined) {
      throw new Error(`Agent model ${reference.provider}/${reference.model} is not registered`);
    }
    return found;
  }

  /** Every switchable agent model: text-capable models of configured providers. */
  list(): readonly AgentModelOption[] {
    const options: AgentModelOption[] = [];
    for (const alias of Object.keys(this.#config.providers)) {
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

  /** Validate and set the runtime override; effective for the next session. */
  switch(provider: string, modelId: string): AgentModelOption {
    const option = this.#option(provider, modelId);
    this.#override = { provider, model: modelId };
    return option;
  }

  /** Revert to the config.toml default. */
  reset(): AgentModelOption {
    this.#override = null;
    return this.current();
  }

  #reference(): { readonly provider: string; readonly model: string } {
    return this.#override ?? { provider: this.#config.agent.provider, model: this.#config.agent.model };
  }

  #option(provider: string, modelId: string): AgentModelOption {
    if (this.#config.providers[provider] === undefined) {
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
