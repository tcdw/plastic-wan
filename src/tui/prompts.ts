import { checkbox, input, password, select } from '@inquirer/prompts';
import type { ProviderApi, SecretRef } from '../platform/config.ts';
import { newKeyJarName, updateKeyJar } from '../platform/key-jar.ts';

export type ApiAdapter = ProviderApi;

const API_ADAPTER_LABELS: Record<ApiAdapter, string> = {
  'openai-responses': 'OpenAI Responses API',
  'openai-completions': 'OpenAI Chat Completions API',
  'anthropic-messages': 'Anthropic Messages API',
  'google-generative-ai': 'Google Generative AI API (base URL must include the version path)',
};

/**
 * A typed value goes into the key jar right away, so fetching models can resolve
 * it before the configuration is saved; `configure` prunes it again if the saved
 * file ends up not using it.
 */
export async function promptSecretRef(message: string, keyJar: string): Promise<SecretRef> {
  type SecretKind = 'env' | 'command' | 'jar';
  const kind = await select<SecretKind>({
    message: `${message}: source`,
    choices: [
      {
        value: 'env',
        name: 'Environment variable',
        description: 'Recommended: reads from an environment variable at runtime',
      },
      { value: 'command', name: 'External command', description: 'Runs a fixed argv and uses stdout as the secret' },
      {
        value: 'jar',
        name: 'Value in key.json',
        description: 'Stores the value in key.json next to the config file; the config only names it',
      },
    ],
  });
  switch (kind) {
    case 'env': {
      const env = await input({
        message: `${message}: environment variable name`,
        validate: (value) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(value) || 'Invalid environment variable name',
      });
      return { env };
    }
    case 'command': {
      const commandString = await input({
        message: `${message}: command (space-separated argv)`,
        validate: (value) => value.trim().length > 0 || 'Command cannot be empty',
      });
      return { command: commandString.trim().split(/\s+/) };
    }
    default: {
      const value = await password({
        message: `${message}: value`,
        mask: true,
        validate: (candidate) => candidate.length > 0 || 'Secret cannot be empty',
      });
      const name = newKeyJarName();
      await updateKeyJar(keyJar, { add: { [name]: value } });
      return { jar: name };
    }
  }
}

export async function promptApiAdapter(message = 'API adapter'): Promise<ApiAdapter> {
  return select<ApiAdapter>({
    message,
    choices: (Object.keys(API_ADAPTER_LABELS) as ApiAdapter[]).map((value) => ({
      value,
      name: API_ADAPTER_LABELS[value],
    })),
  });
}

export async function promptInputCapabilities(
  initial: Array<'text' | 'image'> = ['text'],
): Promise<Array<'text' | 'image'>> {
  const selected = await checkbox<'text' | 'image'>({
    message: 'Input capabilities',
    choices: [
      { value: 'text', name: 'Text', checked: initial.includes('text') },
      { value: 'image', name: 'Image', checked: initial.includes('image') },
    ],
    required: true,
  });
  return selected;
}

export async function promptPositiveInteger(message: string, initial?: number): Promise<number> {
  const value = await input({
    message,
    default: initial !== undefined ? String(initial) : undefined,
    validate: (raw) => {
      const number = Number(raw);
      if (!Number.isInteger(number) || number < 1) {
        return 'Must be a positive integer';
      }
      return true;
    },
  });
  return Number(value);
}

export async function promptNonNegativeNumber(message: string, initial?: number): Promise<number> {
  const value = await input({
    message,
    default: initial !== undefined ? String(initial) : undefined,
    validate: (raw) => {
      const number = Number(raw);
      if (Number.isNaN(number) || number < 0) {
        return 'Must be a non-negative number';
      }
      return true;
    },
  });
  return Number(value);
}

export async function promptString(message: string, initial?: string, required = true): Promise<string> {
  return input({
    message,
    default: initial,
    validate: (value) => {
      if (!required) {
        return true;
      }
      return value.trim().length > 0 || 'Required';
    },
  });
}
