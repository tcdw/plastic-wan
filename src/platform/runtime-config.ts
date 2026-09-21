import type { Api, Model, Models } from '@earendil-works/pi-ai';
import type { RawConfig } from './config.ts';

/**
 * The model registry half of one configuration: the providers and models this
 * generation registers, and the vision model it points at.
 *
 * The type is the read-only `Models`, not `MutableModels`: a published registry
 * is never edited again, so a run that took a snapshot keeps the models and the
 * provider connections it started with.
 */
export interface ConfigurationModels {
  readonly models: Models;
  /** The model `config.vision` names, checked to exist and accept image input. */
  readonly visionModel: Model<Api>;
}

/** What a store is created or republished with: a configuration and its registry. */
export interface RuntimeConfigurationInput extends ConfigurationModels {
  readonly config: RawConfig;
  readonly hash: string;
}

/**
 * One published configuration. The store is created at startup with generation
 * 1, and every reload publishes a whole new object, so a snapshot taken earlier
 * keeps describing the run it started with.
 */
export interface RuntimeConfiguration extends RuntimeConfigurationInput {
  readonly generation: number;
}

/** The configuration an invocation runs under; taken at `queued → running`. */
export type InvocationConfigSnapshot = RuntimeConfiguration;

/**
 * The single entry point for reading configuration at runtime. Anything that
 * reads a hot field holds this store instead of a `RawConfig`; invocation-time
 * reads take a snapshot so a published change cannot reach a run already in
 * flight.
 *
 * Nothing may mutate the `RawConfig` or the registry a snapshot points at — a
 * reload swaps the objects, never edits them in place.
 */
export class RuntimeConfigurationStore {
  #current: RuntimeConfiguration;

  constructor(initial: RuntimeConfigurationInput) {
    this.#current = { generation: 1, ...initial };
  }

  current(): RuntimeConfiguration {
    return this.#current;
  }

  beginInvocation(): InvocationConfigSnapshot {
    return this.#current;
  }

  /**
   * Replaces the published configuration wholesale. Only `ConfigReloader` (and
   * tests) calls this: a reload validates and prepares the whole candidate
   * first, and the swap itself is synchronous so no run can observe a half
   * applied configuration.
   */
  publish(next: RuntimeConfigurationInput): RuntimeConfiguration {
    this.#current = { generation: this.#current.generation + 1, ...next };
    return this.#current;
  }
}
