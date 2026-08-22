export interface PromptTemplateModel {
  readonly provider: string;
  readonly model: string;
}

export interface PromptTemplateValues {
  readonly agent: PromptTemplateModel;
  readonly vision: PromptTemplateModel;
  readonly timezone: string;
}

const TEMPLATE_VALUES: Readonly<Record<string, (values: PromptTemplateValues) => string>> = {
  'agent.provider': (values) => values.agent.provider,
  'agent.model': (values) => values.agent.model,
  'vision.provider': (values) => values.vision.provider,
  'vision.model': (values) => values.vision.model,
  timezone: (values) => values.timezone,
};

function templateKey(value: string): string {
  return value.trim();
}

export function validatePromptTemplate(template: string, label: string): void {
  let cursor = 0;
  while (cursor < template.length) {
    const opening = template.indexOf('{{', cursor);
    const closing = template.indexOf('}}', cursor);
    if (opening < 0) {
      if (closing >= 0) throw new Error(`${label} contains a malformed template expression`);
      return;
    }
    if (closing >= 0 && closing < opening) {
      throw new Error(`${label} contains a malformed template expression`);
    }
    const expressionEnd = template.indexOf('}}', opening + 2);
    if (expressionEnd < 0) {
      throw new Error(`${label} contains a malformed template expression`);
    }
    const key = templateKey(template.slice(opening + 2, expressionEnd));
    if (TEMPLATE_VALUES[key] === undefined) {
      throw new Error(`${label} contains unsupported template variable "${key}"`);
    }
    cursor = expressionEnd + 2;
  }
}

export function renderPromptTemplate(template: string, values: PromptTemplateValues): string {
  validatePromptTemplate(template, 'Prompt');
  return template.replace(/\{\{([\s\S]*?)\}\}/g, (_match, rawKey: string) => {
    const key = templateKey(rawKey);
    const resolve = TEMPLATE_VALUES[key];
    if (resolve === undefined) throw new Error(`Prompt contains unsupported template variable "${key}"`);
    return resolve(values);
  });
}
