import {
  effectiveParameters,
  scanReferences,
  type GenerationInput,
  type GenerationSnapshot,
  type ImageAsset,
  type ModelDefinition,
  type PromptAsset,
  type Reference,
} from './contracts.ts';
import { inputError } from './errors.ts';
import { ADAPTER_VERSION } from './openrouter.ts';
import type { ImageService, PromptService } from './assets.ts';

export type ResolveDeps = {
  prompts: PromptService;
  images: ImageService;
  configVersion: string;
};

/**
 * The single input truth: `{{prompt:UUID}}` expands in place, `{{image:UUID}}` is
 * removed from the text and its first appearance fixes reference order. Names are
 * display only. Malformed or dangling references fail loudly instead of being sent
 * upstream as plain text.
 */
export function resolveSnapshot(deps: ResolveDeps, input: GenerationInput, model: ModelDefinition): GenerationSnapshot {
  let references: Reference[];
  try {
    references = scanReferences(input.authoredPrompt);
  } catch {
    throw inputError('malformed_reference', '素材引用语法损坏；请使用 {{prompt:UUID}} 或 {{image:UUID}}');
  }

  const promptAssets = new Map<string, PromptAsset>();
  const imageAssets = new Map<string, ImageAsset>();

  for (const reference of references) {
    if (reference.kind === 'prompt') {
      if (promptAssets.has(reference.id)) {
        continue;
      }
      const asset = deps.prompts.get(reference.id);
      if (asset === null) {
        throw inputError('missing_reference', '引用的 Prompt 素材不存在');
      }
      if (asset.deletedAt !== null) {
        throw inputError('missing_reference', '引用的 Prompt 素材已归档');
      }
      if (asset.body.includes('{{') || asset.body.includes('}}')) {
        throw inputError('recursive_reference', 'Prompt 素材包含引用语法，Phase 1 不支持递归引用');
      }
      promptAssets.set(reference.id, asset);
    } else {
      if (imageAssets.has(reference.id)) {
        continue;
      }
      const asset = deps.images.get(reference.id);
      if (asset === null) {
        throw inputError('missing_reference', '引用的图片素材不存在');
      }
      if (asset.deletedAt !== null) {
        throw inputError('missing_reference', '引用的图片素材已归档');
      }
      imageAssets.set(reference.id, asset);
    }
  }

  if (imageAssets.size > model.capabilities.maxReferences) {
    throw inputError('too_many_references', `参考图数量超过模型上限（${model.capabilities.maxReferences}）`);
  }

  let effective: Record<string, string | number>;
  try {
    effective = effectiveParameters(model, input);
  } catch (error) {
    throw inputError('invalid_parameters', error instanceof Error ? error.message : '生成参数无效');
  }

  const resolvedPrompt = expandText(input.authoredPrompt, references, promptAssets);
  if (resolvedPrompt.trim().length === 0) {
    throw inputError('empty_prompt', '解析后的 Prompt 不能为空');
  }

  return {
    schemaVersion: 1,
    authored: input,
    resolvedPrompt,
    finalPrompt: resolvedPrompt,
    promptAssets: [...promptAssets.values()],
    imageAssets: [...imageAssets.values()],
    model,
    configVersion: deps.configVersion,
    effectiveParameters: effective,
    requestSemantics: {
      adapterVersion: ADAPTER_VERSION,
      calls: input.outputCount,
      imagesPerCall: 1,
      appendedInstructions: [],
    },
  };
}

function expandText(text: string, references: Reference[], promptAssets: Map<string, PromptAsset>): string {
  let result = '';
  let cursor = 0;
  for (const reference of references) {
    result += text.slice(cursor, reference.start);
    if (reference.kind === 'prompt') {
      const asset = promptAssets.get(reference.id);
      if (asset !== undefined) {
        result += asset.body;
      }
    }
    cursor = reference.end;
  }
  result += text.slice(cursor);
  return result;
}
