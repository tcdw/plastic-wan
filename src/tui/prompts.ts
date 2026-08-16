import { input, select, confirm, checkbox } from "@inquirer/prompts";
import type { SecretRef } from "../config.ts";

export type ApiAdapter = "openai-responses" | "openai-completions" | "anthropic-messages";

const API_ADAPTER_LABELS: Record<ApiAdapter, string> = {
  "openai-responses": "OpenAI Responses API",
  "openai-completions": "OpenAI Chat Completions API",
  "anthropic-messages": "Anthropic Messages API",
};

export async function promptSecretRef(message: string, allowLiteral = true): Promise<SecretRef> {
  type SecretKind = "env" | "command" | "literal";
  const choices: { value: SecretKind; name: string; description?: string }[] = [
    { value: "env", name: "Environment variable", description: "Recommended: reads from an environment variable at runtime" },
    { value: "command", name: "External command", description: "Runs a fixed argv and uses stdout as the secret" },
  ];
  if (allowLiteral) {
    choices.push({
      value: "literal",
      name: "Literal value",
      description: "Not recommended: the secret will be written into the config file",
    });
  }
  const kind = await select<SecretKind>({
    message: `${message}: source`,
    choices,
  });
  switch (kind) {
    case "env": {
      const env = await input({
        message: `${message}: environment variable name`,
        validate: (value) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(value) || "Invalid environment variable name",
      });
      return { env };
    }
    case "command": {
      const commandString = await input({
        message: `${message}: command (space-separated argv)`,
        validate: (value) => value.trim().length > 0 || "Command cannot be empty",
      });
      return { command: commandString.trim().split(/\s+/) };
    }
    case "literal":
    default: {
      const literal = await input({
        message: `${message}: value`,
        validate: (value) => value.length > 0 || "Secret cannot be empty",
      });
      return literal;
    }
  }
}

export async function promptApiAdapter(message = "API adapter"): Promise<ApiAdapter> {
  return select<ApiAdapter>({
    message,
    choices: (Object.keys(API_ADAPTER_LABELS) as ApiAdapter[]).map((value) => ({
      value,
      name: API_ADAPTER_LABELS[value],
    })),
  });
}

export async function promptBoolean(message: string, initial = false): Promise<boolean> {
  return confirm({ message, default: initial });
}

export async function promptInputCapabilities(initial: Array<"text" | "image"> = ["text"]): Promise<Array<"text" | "image">> {
  const selected = await checkbox<"text" | "image">({
    message: "Input capabilities",
    choices: [
      { value: "text", name: "Text", checked: initial.includes("text") },
      { value: "image", name: "Image", checked: initial.includes("image") },
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
      if (!Number.isInteger(number) || number < 1) return "Must be a positive integer";
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
      if (Number.isNaN(number) || number < 0) return "Must be a non-negative number";
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
      if (!required) return true;
      return value.trim().length > 0 || "Required";
    },
  });
}
