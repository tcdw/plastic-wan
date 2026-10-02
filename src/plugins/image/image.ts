import type { AgentTool } from '@earendil-works/pi-agent-core';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import type { InvocationScope } from '../plugin.ts';

/**
 * The `image_generate` capability: submits a generation intent to the image
 * core and returns immediately with the generation id. Delivery is decoupled:
 * when the generation settles, the host reconciles the outstanding task and a
 * completion receipt is injected into the conversation; the model then decides
 * whether and what to send with `send kind:image`.
 */

const IMAGE_GENERATE_MAX_PER_INVOCATION = 3;

const IMAGE_PROMPT_MAX = 8000;

export const ImageGenerateInputSchema = Type.Object(
  {
    prompt: Type.String({ minLength: 1, maxLength: IMAGE_PROMPT_MAX }),
    // Omit to use the only configured model; required once several exist.
    model_id: Type.Optional(Type.String({ pattern: '^[a-zA-Z0-9_-]{1,80}$' })),
    aspect_ratio: Type.Optional(
      Type.Union([
        Type.Literal('auto'),
        Type.Literal('1:1'),
        Type.Literal('2:3'),
        Type.Literal('3:2'),
        Type.Literal('4:3'),
        Type.Literal('3:4'),
        Type.Literal('16:9'),
        Type.Literal('9:16'),
      ]),
    ),
    resolution: Type.Optional(
      Type.Union([Type.Literal('auto'), Type.Literal('low'), Type.Literal('medium'), Type.Literal('high')]),
    ),
    output_count: Type.Optional(Type.Number({ minimum: 1, maximum: 4 })),
    // img_… media references from this conversation only; never guess ids.
    input_image_refs: Type.Optional(Type.Array(Type.String({ minLength: 4, maxLength: 80 }), { maxItems: 16 })),
    extended_data: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);

const inputValidator = Compile(ImageGenerateInputSchema);

export function createImageGenerateTool(
  scope: InvocationScope,
): AgentTool<typeof ImageGenerateInputSchema, ImageGenerateDetails> {
  const bridge = scope.image;
  if (bridge === undefined) {
    throw new Error('image_generate requires an image bridge');
  }
  return {
    name: 'image_generate',
    label: 'Generate image',
    description:
      'Submit an image generation request for this conversation. Use when the user asks for a picture, an illustration, or an image edit of media they shared. prompt is the full visual description you author (1-8000 chars); write intent, not instructions to the user. model_id may be omitted when exactly one model is configured; call this capability via execute search or ask nothing — model list is available through the image-generation skill. aspect_ratio and resolution are coarse intent classes; extended_data is provider-specific and rarely needed. input_image_refs accepts only img_ references visible in this conversation (from read_image or media the user shared), never arbitrary ids. The call returns immediately with a generation id; the result arrives later as a task completion receipt. At most 3 generations may be submitted per invocation. After submitting, tell the user briefly that the request is running; when the receipt arrives, use send kind:image to deliver the pictures or the error.',
    parameters: ImageGenerateInputSchema,
    executionMode: 'sequential',
    execute: async (toolCallId, input, signal) => {
      const argumentsJson = JSON.stringify(input);
      if (!inputValidator.Check(input)) {
        scope.audit.reject(toolCallId, 'image_generate', argumentsJson, true, 'image_generate_input_invalid');
        throw new Error('image_generate input is invalid');
      }
      if (bridge === undefined || !bridge.enabled()) {
        scope.audit.reject(toolCallId, 'image_generate', argumentsJson, true, 'image_generation_disabled');
        throw new Error('image generation is not enabled');
      }
      const inputMediaIds: bigint[] = [];
      for (const ref of input.input_image_refs ?? []) {
        const mediaId = scope.resolveMedia?.(ref);
        if (mediaId === undefined) {
          scope.audit.reject(toolCallId, 'image_generate', argumentsJson, true, 'image_input_ref_unauthorized');
          throw new Error(`input image reference ${ref} is not authorized in this conversation`);
        }
        inputMediaIds.push(mediaId);
      }
      const audit = scope.audit.start(toolCallId, 'image_generate', argumentsJson, true);
      try {
        const result = await bridge.submit(
          {
            conversationId: scope.context.conversationId,
            invocationId: scope.context.invocationId,
            toolCallId,
            authoredPrompt: input.prompt,
            modelId: input.model_id,
            aspectRatio: input.aspect_ratio,
            resolution: input.resolution,
            outputCount: input.output_count,
            inputMediaIds,
            extendedData: input.extended_data,
          },
          signal,
        );
        audit.succeed(`generation_id=${result.generationId} model=${result.modelId} replayed=${result.replayed}`);
        return {
          content: [
            {
              type: 'text',
              text: result.replayed
                ? `Generation ${result.generationId} was already submitted (replayed, not re-billed); its receipt is still pending.`
                : `Generation ${result.generationId} submitted on model ${result.modelId} (${result.outputCount} output(s)). The result arrives as a completion receipt; do not claim the image exists before then.`,
            },
          ],
          details: {
            generation_id: result.generationId,
            model_id: result.modelId,
            output_count: result.outputCount,
            replayed: result.replayed,
          },
        };
      } catch (error) {
        const quota = error instanceof Error && error.name === 'TaskQuotaError';
        audit.fail(quota ? 'image_generate_quota_exceeded' : 'image_generate_error');
        if (quota) {
          throw new Error(`image generation quota of ${IMAGE_GENERATE_MAX_PER_INVOCATION} per invocation reached`);
        }
        throw error;
      }
    },
  };
}

export interface ImageGenerateDetails {
  generation_id: string;
  model_id: string;
  output_count: number;
  replayed: boolean;
}
