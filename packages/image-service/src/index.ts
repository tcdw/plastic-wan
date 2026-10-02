/**
 * Public surface of the image generation core. Adapters (host plugin, Admin API)
 * import from here; the core has no knowledge of hosts, HTTP or Telegram.
 */
export {
  // Errors
  AppError,
  configUnavailable,
  conflict,
  forbidden,
  inputError,
  notFound,
  providerFailure,
  storageFailure,
} from './errors.ts';
export { Redactor, redactWith } from './redactor.ts';
export {
  // Contracts
  generationCreateSchema,
  generationScopes,
  generationSourceSchema,
  idempotencyKeySchema,
  imageCreateSchema,
  imageUpdateSchema,
  listSchema,
  maxImageBytes,
  modelDefinitionSchema,
  parameterNames,
  parameterSchema,
  promptBodySchema,
  promptCreateSchema,
  promptUpdateSchema,
  // Pure functions
  effectiveParameters,
  referenceToken,
  removeReference,
  scanReferences,
} from './contracts.ts';
export type {
  AttemptStatus,
  ErrorResponse,
  Generation,
  GenerationActor,
  GenerationAttempt,
  GenerationInput,
  GenerationScope,
  GenerationSnapshot,
  GenerationSource,
  GenerationStatus,
  ImageAsset,
  ListQuery,
  ModelDefinition,
  Page,
  ParameterDefinition,
  PromptAsset,
  PublicModel,
  Reference,
  ResolvedInput,
  SafeError,
} from './contracts.ts';
export { imageSchema, prompts, images, generations, generationAttempts, idempotencyKeys } from './schema.ts';
export type { ImageDatabase } from './db.ts';
export { createImageConfigSnapshot, ImageConfigStore } from './config.ts';
export type { ImageConfigHandle, ImageConfigSnapshot } from './config.ts';
export {
  createProviderClient,
  buildImageRequestBody,
  ADAPTER_VERSION,
  OPENROUTER_IMAGES_ENDPOINT,
  ProviderCallError,
} from './openrouter.ts';
export { decodeBase64Image, ImageStore, MAX_IMAGE_BYTES } from './image-store.ts';
export type { AllowedMime, StoredImage, VerifiedImage } from './image-store.ts';
export { createImageService, createPromptService, toImageAsset, toPromptAsset } from './assets.ts';
export {
  createGenerationService,
  assertIdempotencyKey,
  computeStatus,
  fingerprintOf,
  firstError,
} from './generations.ts';
export { resolveSnapshot } from './resolve.ts';
export { GenerationWorker } from './worker.ts';
export { createImageCore } from './core.ts';
export type { ImageCore, ImageCoreOptions } from './core.ts';
