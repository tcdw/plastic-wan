/**
 * Public surface of the image generation core. Adapters (host plugin, Admin API)
 * import from here; the core has no knowledge of hosts, HTTP or Telegram.
 */

export { createImageService, createPromptService, toImageAsset, toPromptAsset } from './assets.ts';
export type { ImageConfigHandle, ImageConfigSnapshot } from './config.ts';
export { createImageConfigSnapshot, ImageConfigStore } from './config.ts';
export type {
  AspectRatio,
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
  ModelCapability,
  ModelDefinition,
  Page,
  PromptAsset,
  PublicModel,
  Reference,
  ResolutionClass,
  ResolvedInput,
  SafeError,
} from './contracts.ts';
export {
  // Contracts
  aspectRatios,
  assertGenerationFitsCapability,
  generationCreateSchema,
  generationScopes,
  generationSourceSchema,
  idempotencyKeySchema,
  imageCreateSchema,
  imageUpdateSchema,
  listSchema,
  maxImageBytes,
  modelCapabilitySchema,
  modelDefinitionSchema,
  promptBodySchema,
  promptCreateSchema,
  promptUpdateSchema,
  // Pure functions
  referenceToken,
  removeReference,
  resolutionClasses,
  scanReferences,
} from './contracts.ts';
export type { ImageCore, ImageCoreOptions } from './core.ts';
export { createImageCore } from './core.ts';
export type { ImageDatabase } from './db.ts';
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
export {
  assertIdempotencyKey,
  computeStatus,
  createGenerationService,
  fingerprintOf,
  firstError,
} from './generations.ts';
export type { AllowedMime, StoredImage, VerifiedImage } from './image-store.ts';
export { decodeBase64Image, ImageStore, MAX_IMAGE_BYTES } from './image-store.ts';
export {
  ADAPTER_ID,
  ADAPTER_VERSION,
  buildImageRequestBody,
  createOpenRouterAdapter,
  OPENROUTER_IMAGES_ENDPOINT,
  ProviderCallError,
} from './openrouter.ts';
export type { ImageProviderAdapter, ProviderImage, ProviderInvocation } from './provider.ts';
export { Redactor, redactWith } from './redactor.ts';
export { resolveSnapshot } from './resolve.ts';
export {
  generationAttempts,
  generations,
  idempotencyKeys,
  imageSchema,
  images,
  prompts,
  safeInteger,
} from './schema.ts';
export { GenerationWorker } from './worker.ts';
