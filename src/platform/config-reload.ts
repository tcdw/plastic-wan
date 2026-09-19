import { createHash } from 'node:crypto';
import type { Api, Model, MutableModels, Provider } from '@earendil-works/pi-ai';
import {
  assertConfigPermissions,
  type FileConfig,
  type LoadedConfig,
  loadConfig,
  validateSemantics,
} from './config.ts';
import { type ConfigChange, type ConfigSource, deepEqual, diffConfig } from './config-diff.ts';
import { ConfigWriteError, writeConfigEdits } from './config-file.ts';
import { type AgentModelSwitcher, ModelSwitchError } from './model-switch.ts';
import { type CustomProviderConfig, rebuildCustomProvider } from './providers.ts';
import type { RuntimeConfigurationStore } from './runtime-config.ts';
import type { SecretStore } from './secrets.ts';

export type ConfigErrorCode =
  | 'config_permissions'
  | 'config_invalid'
  | 'candidate_invalid'
  | 'model_unusable'
  | 'unknown_provider'
  | 'unknown_model'
  | 'not_text_capable'
  | 'config_symlink'
  | 'config_write_failed';

export interface ConfigErrorDetail {
  readonly code: ConfigErrorCode;
  readonly message: string;
  readonly at: string;
}

export interface ConfigStatus {
  readonly generation: number;
  /** Identity of the configuration the process is running. */
  readonly activeHash: string;
  /** Identity of the file as of the last successful load. */
  readonly fileHash: string;
  readonly restartRequired: readonly string[];
  readonly lastError: ConfigErrorDetail | null;
}

export type ConfigApplyResult =
  | {
      readonly ok: true;
      readonly applied: readonly string[];
      readonly restartRequired: readonly string[];
      readonly outsideServe: readonly string[];
      readonly status: ConfigStatus;
    }
  | {
      readonly ok: false;
      readonly code: ConfigErrorCode;
      readonly message: string;
      /** Only a failed `setAgentModel` that already rewrote the file sets this. */
      readonly fileWritten: boolean;
      readonly status: ConfigStatus;
    };

export interface ConfigReloaderOptions {
  /** The startup load result: the base for the first diff. */
  readonly loaded: LoadedConfig;
  readonly store: RuntimeConfigurationStore;
  /** `registry.models`: shared with the switcher, the runtime and media. */
  readonly models: MutableModels;
  readonly modelSwitcher: AgentModelSwitcher;
  readonly secrets: SecretStore;
  /** Throws when the tool registry does not fit the model's context window. */
  readonly validateAgentModel: (model: Model<Api>) => void;
  /** Called after every successful publish; the composition root wakes the scheduler. */
  readonly onPublished: () => void;
}

interface RebuiltProvider {
  readonly alias: string;
  readonly provider: Provider;
}

/**
 * Applies the configuration file to the running process.
 *
 * The file is the desired configuration; this class decides which of its changes
 * the process can adopt right now (the hot whitelist in `config-diff.ts`) and
 * which have to wait for a restart. Both layers of a candidate are validated
 * before anything is published: the file itself, so the next startup will work,
 * and the candidate, so the running process will.
 */
export class ConfigReloader {
  readonly #configPath: string;
  readonly #store: RuntimeConfigurationStore;
  readonly #models: MutableModels;
  readonly #modelSwitcher: AgentModelSwitcher;
  readonly #secrets: SecretStore;
  readonly #validateAgentModel: (model: Model<Api>) => void;
  readonly #onPublished: () => void;
  #activeFile: FileConfig;
  #fileHash: string;
  #restartRequired: readonly string[] = [];
  #lastError: ConfigErrorDetail | null = null;
  /** Serializes reloads; a reload and a `/model` write never interleave. */
  #tail: Promise<unknown> = Promise.resolve();

  constructor(options: ConfigReloaderOptions) {
    this.#configPath = options.loaded.configPath;
    this.#store = options.store;
    this.#models = options.models;
    this.#modelSwitcher = options.modelSwitcher;
    this.#secrets = options.secrets;
    this.#validateAgentModel = options.validateAgentModel;
    this.#onPublished = options.onPublished;
    this.#activeFile = structuredClone(options.loaded.fileConfig);
    this.#fileHash = options.loaded.hash;
  }

  status(): ConfigStatus {
    const current = this.#store.current();
    return {
      generation: current.generation,
      activeHash: current.hash,
      fileHash: this.#fileHash,
      restartRequired: this.#restartRequired,
      lastError: this.#lastError,
    };
  }

  reloadFromFile(): Promise<ConfigApplyResult> {
    return this.#withLock(() => this.#applyFile());
  }

  /**
   * Writes `agent.provider` / `agent.model` into the configuration file and
   * applies the file. The model must be usable before anything is written, so a
   * rejected switch leaves the file untouched; once it is written, a failed
   * apply reports `fileWritten` instead of pretending nothing happened.
   */
  setAgentModel(provider: string, model: string): Promise<ConfigApplyResult> {
    return this.#withLock(async () => {
      let selected: { readonly provider: string; readonly model: string };
      try {
        selected = this.#modelSwitcher.option(provider, model);
      } catch (error) {
        if (error instanceof ModelSwitchError) {
          return this.#failure(error.code, error.message, false);
        }
        throw error;
      }
      const resolved = this.#models.getModel(selected.provider, selected.model);
      if (resolved === undefined) {
        return this.#failure('model_unusable', `Model ${selected.provider}/${selected.model} is not registered`, false);
      }
      try {
        this.#validateAgentModel(resolved);
      } catch (error) {
        return this.#failure('model_unusable', messageOf(error), false);
      }
      try {
        await writeConfigEdits(this.#configPath, [
          { path: ['agent', 'provider'], value: provider },
          { path: ['agent', 'model'], value: model },
        ]);
      } catch (error) {
        return error instanceof ConfigWriteError
          ? this.#failure(error.code, error.message, false)
          : this.#failure('config_write_failed', messageOf(error), false);
      }
      const result = await this.#applyFile();
      return result.ok ? result : { ...result, fileWritten: true };
    });
  }

  async #applyFile(): Promise<ConfigApplyResult> {
    const active: ConfigSource = { file: this.#activeFile, raw: this.#store.current().config };
    try {
      await assertConfigPermissions(this.#configPath);
    } catch (error) {
      return this.#failure('config_permissions', messageOf(error), false);
    }
    let file: LoadedConfig;
    try {
      file = await loadConfig(this.#configPath);
    } catch (error) {
      return this.#failure('config_invalid', messageOf(error), false);
    }
    const fromFile: ConfigSource = { file: file.fileConfig, raw: file.config };
    const diff = diffConfig(active, fromFile);
    const restartRequired = pathsOf(diff.changes, 'restart');
    try {
      validateSemantics(diff.candidate.file);
    } catch (error) {
      // The file is valid on its own, so the next startup is fine; only this
      // process cannot adopt it while the restart-only fields are still pending.
      const pending = restartRequired.length === 0 ? '' : ` Pending restart paths: ${restartRequired.join(', ')}.`;
      return this.#failure(
        'candidate_invalid',
        `The file itself is valid, but it is not valid together with the restart-only fields still pending in this process; those take effect together after a restart. ${messageOf(error)}${pending}`,
        false,
      );
    }
    const rebuilt = this.#rebuildProviders(diff.candidate.file);
    if (rebuilt.error !== null) {
      return this.#failure('model_unusable', rebuilt.error, false);
    }
    const model = this.#resolveAgentModel(diff.candidate.file, rebuilt.providers);
    if (model === null) {
      const { provider, model: modelId } = diff.candidate.file.agent;
      return this.#failure('model_unusable', `Agent model ${provider}/${modelId} is not usable`, false);
    }
    try {
      this.#validateAgentModel(model);
    } catch (error) {
      return this.#failure('model_unusable', messageOf(error), false);
    }
    const applied = pathsOf(diff.changes, 'hot');
    const outsideServe = pathsOf(diff.changes, 'outside_serve');
    if (applied.length === 0 && outsideServe.length === 0) {
      // Only restart-only fields changed: nothing to publish, but the file hash
      // and the pending list still move.
      this.#fileHash = file.hash;
      this.#restartRequired = restartRequired;
      this.#lastError = null;
      this.#logReloaded(applied, restartRequired, outsideServe);
      return this.#applied(applied, restartRequired, outsideServe);
    }
    // With nothing pending, the candidate is exactly the file, so the hash can
    // stay comparable with `check-config` output.
    const activeHash =
      restartRequired.length === 0
        ? file.hash
        : createHash('sha256').update(JSON.stringify(diff.candidate.raw)).digest('hex');
    // Synchronous from here on: the provider swap and the publication must not be
    // separated by an await, or a run could start against a half-applied state.
    for (const entry of rebuilt.providers) {
      this.#models.setProvider(entry.provider);
    }
    this.#store.publish({ config: diff.candidate.raw, hash: activeHash });
    this.#activeFile = diff.candidate.file;
    this.#fileHash = file.hash;
    this.#restartRequired = restartRequired;
    this.#lastError = null;
    this.#onPublished();
    this.#logReloaded(applied, restartRequired, outsideServe);
    return this.#applied(applied, restartRequired, outsideServe);
  }

  #rebuildProviders(candidateFile: FileConfig): { providers: readonly RebuiltProvider[]; error: string | null } {
    const providers: RebuiltProvider[] = [];
    for (const [alias, configured] of Object.entries(candidateFile.providers)) {
      if (configured.kind !== 'custom') {
        continue;
      }
      const activeProvider = this.#activeFile.providers[alias];
      if (activeProvider === undefined || activeProvider.kind !== 'custom') {
        continue;
      }
      if (deepEqual(activeProvider.models, configured.models)) {
        continue;
      }
      try {
        providers.push({
          alias,
          provider: rebuildCustomProvider(this.#models, alias, configured as CustomProviderConfig),
        });
      } catch (error) {
        return { providers: [], error: messageOf(error) };
      }
    }
    return { providers, error: null };
  }

  #resolveAgentModel(candidateFile: FileConfig, rebuilt: readonly RebuiltProvider[]): Model<Api> | null {
    const { provider: alias, model: modelId } = candidateFile.agent;
    const replacement = rebuilt.find((entry) => entry.alias === alias)?.provider;
    const model =
      replacement === undefined
        ? this.#models.getModel(alias, modelId)
        : replacement.getModels().find((candidate) => candidate.id === modelId);
    if (model === undefined || !model.input.includes('text')) {
      return null;
    }
    return model;
  }

  #applied(
    applied: readonly string[],
    restartRequired: readonly string[],
    outsideServe: readonly string[],
  ): ConfigApplyResult {
    return { ok: true, applied, restartRequired, outsideServe, status: this.status() };
  }

  #failure(code: ConfigErrorCode, message: string, fileWritten: boolean): ConfigApplyResult {
    const redacted = this.#secrets.redact(message);
    this.#lastError = { code, message: redacted, at: new Date().toISOString() };
    console.log(JSON.stringify({ event: 'config_reload_failed', code, error: redacted, at: this.#lastError.at }));
    return { ok: false, code, message: redacted, fileWritten, status: this.status() };
  }

  #logReloaded(applied: readonly string[], restartRequired: readonly string[], outsideServe: readonly string[]): void {
    const current = this.#store.current();
    console.log(
      JSON.stringify({
        event: 'config_reloaded',
        generation: current.generation,
        active_hash: current.hash,
        file_hash: this.#fileHash,
        applied: applied.join(','),
        restart_required: restartRequired.join(','),
        outside_serve: outsideServe.join(','),
        at: new Date().toISOString(),
      }),
    );
  }

  async #withLock<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return await result;
  }
}

function pathsOf(changes: readonly ConfigChange[], kind: ConfigChange['kind']): readonly string[] {
  return changes.filter((change) => change.kind === kind).map((change) => change.path);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
