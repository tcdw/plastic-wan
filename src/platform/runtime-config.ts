import type { RawConfig } from './config.ts';

/**
 * One published configuration. The store is created at startup with generation
 * 1, and every reload publishes a whole new object, so a snapshot taken earlier
 * keeps describing the run it started with.
 */
export interface RuntimeConfiguration {
  readonly generation: number;
  /** `LoadedConfig.hash`, the identity of the exact configuration this holds. */
  readonly hash: string;
  readonly config: RawConfig;
}

/** The configuration an invocation runs under; taken at `queued → running`. */
export type InvocationConfigSnapshot = RuntimeConfiguration;

/**
 * The single entry point for reading configuration at runtime. Anything that
 * reads a hot field holds this store instead of a `RawConfig`; invocation-time
 * reads take a snapshot so a published change cannot reach a run already in
 * flight.
 *
 * Nothing may mutate the `RawConfig` a snapshot points at — a reload swaps the
 * object, never edits it in place.
 */
export class RuntimeConfigurationStore {
  #current: RuntimeConfiguration;

  constructor(initial: { readonly config: RawConfig; readonly hash: string }) {
    this.#current = { generation: 1, hash: initial.hash, config: initial.config };
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
  publish(next: { readonly config: RawConfig; readonly hash: string }): RuntimeConfiguration {
    this.#current = { generation: this.#current.generation + 1, hash: next.hash, config: next.config };
    return this.#current;
  }
}
