import type { AspectRatio, ModelDefinition, ResolutionClass } from './contracts.ts';
import type { AllowedMime } from './image-store.ts';

/**
 * The seam between the core and provider plugins. The core assembles one
 * invocation per output item from the frozen snapshot and knows nothing about
 * how the adapter maps it onto a vendor API: aspectRatio/resolution are intent
 * classes, `extendedData` is interpreted solely by the adapter, and results are
 * normalized back into `ProviderImage`.
 */
export type ProviderInvocation = {
  model: ModelDefinition;
  credential: string;
  prompt: string;
  /** Reference images already verified and re-encoded by the core. */
  inputImages: Array<{ mime: AllowedMime; base64: string }>;
  aspectRatio: AspectRatio;
  resolution: ResolutionClass;
  /** Opaque adapter-owned payload; the core never inspects it. */
  extendedData: Record<string, unknown> | undefined;
  /** Milliseconds before the call is abandoned as an uncertain (interrupted) call. */
  timeoutMs: number;
  /** Caller-owned abort signal, e.g. server shutdown. */
  signal: AbortSignal;
};

export type ProviderImage = {
  base64: string;
  /** What the vendor claimed; the core still verifies the actual bytes. */
  mediaType: string | null;
  providerRequestId: string | null;
  usage: Record<string, number> | null;
};

export type ImageProviderAdapter = {
  /** Adapter identity, matching `ModelDefinition.provider`. */
  readonly id: string;
  generate(invocation: ProviderInvocation): Promise<ProviderImage>;
};
