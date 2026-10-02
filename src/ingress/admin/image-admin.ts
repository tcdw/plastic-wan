import {
  type GenerationActor,
  generationCreateSchema,
  imageCreateSchema,
  imageUpdateSchema,
  listSchema,
  promptCreateSchema,
  promptUpdateSchema,
} from '@plasticwan/image-service';
import type { ImageBridge } from '../../image/bridge.ts';
import type { ImageService } from '../../image/service.ts';

/**
 * The Admin panel's image API: workspace (submit/resolve with an admin actor),
 * audit (generation list/detail), asset management (prompts and images), and
 * the enable/disable switch that writes the `image` configuration section
 * through the same write-and-apply path as the other panel editors.
 *
 * All write operations here are panel-authenticated; the server router only
 * dispatches after session auth, and the config write additionally requires
 * the `If-Match` revision like every other configuration editor.
 */

export interface ImageAdminDeps {
  readonly service?: ImageService;
  readonly bridge?: ImageBridge;
}

export interface ImageAdminContext {
  /** Authenticated panel username; binds admin-submitted generations. */
  readonly username: string;
}

export type ImageAdminResponse =
  | { readonly status: number; readonly body: unknown }
  | { readonly status: number; readonly bytes: Uint8Array; readonly mime: string };

export function adminActor(username: string): GenerationActor {
  return {
    id: `admin:${username}`,
    name: username,
    source: 'admin',
    scopes: [],
    privileged: true,
  };
}

function coreErrorStatus(error: unknown): { status: number; message: string; code: string } | undefined {
  if (
    error !== null &&
    typeof error === 'object' &&
    'issues' in error &&
    Array.isArray((error as { issues: unknown }).issues)
  ) {
    const detail = (error as { issues: { message: string }[] }).issues
      .slice(0, 2)
      .map((issue) => issue.message)
      .join('; ');
    return { status: 400, code: 'invalid_input', message: detail };
  }
  if (error !== null && typeof error === 'object' && 'code' in error && 'message' in error) {
    const code = String((error as { code: unknown }).code);
    const message = String((error as { message: unknown }).message);
    const status =
      code === 'not_found' || code === 'forbidden'
        ? 404
        : code === 'idempotency_conflict' || code === 'already_archived'
          ? 409
          : code === 'config_invalid' || code === 'model_not_found'
            ? 409
            : 400;
    return { status, code, message };
  }
  return undefined;
}

/** exactOptionalPropertyTypes: core update inputs reject explicit undefined. */
function compact<T extends Record<string, unknown>>(input: T): T {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result as T;
}

function errorResponse(error: unknown): ImageAdminResponse {
  const mapped = coreErrorStatus(error);
  if (mapped !== undefined) {
    return { status: mapped.status, body: { error: mapped.code, message: mapped.message } };
  }
  return { status: 500, body: { error: 'image_internal', message: '图片功能内部错误' } };
}

/** Prompt/generation bodies stay small; uploads carry a base64 payload. */
const IMAGE_BODY_TEXT_LIMIT = 30_000_000;

export function createImageAdminHandler(deps: ImageAdminDeps) {
  const { service, bridge } = deps;
  const core = service?.core;

  /** Maps the panel's snake_case body onto the generation intent schema. */
  function parseGenerationBody(raw: Record<string, unknown>) {
    const authored = typeof raw.prompt === 'string' ? raw.prompt : '';
    const promptRefs = Array.isArray(raw.prompt_refs)
      ? raw.prompt_refs.filter((entry): entry is string => typeof entry === 'string')
      : [];
    const withRefs =
      promptRefs.length === 0 ? authored : `${authored} ${promptRefs.map((id) => `{{prompt:${id}}}`).join(' ')}`;
    return generationCreateSchema.parse({
      authoredPrompt: withRefs,
      modelId: typeof raw.model_id === 'string' ? raw.model_id : '',
      aspectRatio: typeof raw.aspect_ratio === 'string' ? raw.aspect_ratio : 'auto',
      resolution: typeof raw.resolution === 'string' ? raw.resolution : 'auto',
      outputCount: typeof raw.output_count === 'number' ? raw.output_count : 1,
      inputImages:
        promptRefs.length === 0 && !Array.isArray(raw.input_image_refs)
          ? []
          : Array.isArray(raw.input_image_refs)
            ? raw.input_image_refs.filter((entry): entry is string => typeof entry === 'string')
            : [],
      ...(raw.extended_data !== undefined && typeof raw.extended_data === 'object' && raw.extended_data !== null
        ? { extendedData: raw.extended_data as Record<string, unknown> }
        : {}),
    });
  }

  return async function handle(
    request: Request,
    segments: readonly string[],
    url: URL,
    context: ImageAdminContext,
    /** Reads a bounded JSON body; the image upload path allows 30 MB of text. */
    readBody: (maxBytes?: number) => Promise<Record<string, unknown>>,
    applyImageConfig: (body: Record<string, unknown>) => Promise<ImageAdminResponse>,
  ): Promise<ImageAdminResponse> {
    if (core === undefined || bridge === undefined) {
      return { status: 503, body: { error: 'image_unavailable', message: 'Image generation is not wired' } };
    }
    const actor = adminActor(context.username);
    const method = request.method;
    const [, resource, id, action] = segments;

    // ---- status & models -------------------------------------------------
    if (resource === 'status' && method === 'GET') {
      return {
        status: 200,
        body: {
          enabled: bridge.enabled(),
          models: bridge.modelList(),
        },
      };
    }

    // ---- prompts ----------------------------------------------------------
    if (resource === 'prompts') {
      if (id === undefined && method === 'GET') {
        const query = listSchema.safeParse(Object.fromEntries(url.searchParams));
        if (!query.success) {
          return { status: 400, body: { error: 'invalid_query', message: '查询参数不合法' } };
        }
        return { status: 200, body: core.prompts.list(query.data) };
      }
      if (id === undefined && method === 'POST') {
        try {
          const body = promptCreateSchema.parse(await readBody(IMAGE_BODY_TEXT_LIMIT));
          return { status: 201, body: core.prompts.create(body) };
        } catch (error) {
          return errorResponse(error);
        }
      }
      if (id !== undefined && method === 'GET') {
        const asset = core.prompts.get(id);
        return asset === null || asset.deletedAt !== null
          ? { status: 404, body: { error: 'not_found', message: '素材不存在' } }
          : { status: 200, body: asset };
      }
      if (id !== undefined && method === 'PUT') {
        try {
          const body = promptUpdateSchema.parse(await readBody(IMAGE_BODY_TEXT_LIMIT));
          return { status: 200, body: core.prompts.update(id, compact(body)) };
        } catch (error) {
          return errorResponse(error);
        }
      }
      if (id !== undefined && method === 'DELETE') {
        try {
          core.prompts.remove(id);
          return { status: 200, body: { status: 'archived' } };
        } catch (error) {
          return errorResponse(error);
        }
      }
    }

    // ---- images -----------------------------------------------------------
    if (resource === 'images') {
      if (id === undefined && method === 'GET') {
        const query = listSchema.safeParse(Object.fromEntries(url.searchParams));
        if (!query.success) {
          return { status: 400, body: { error: 'invalid_query', message: '查询参数不合法' } };
        }
        return { status: 200, body: core.images.list(query.data) };
      }
      if (id === undefined && method === 'POST') {
        try {
          const body = imageCreateSchema.parse(await readBody(IMAGE_BODY_TEXT_LIMIT));
          return { status: 201, body: await core.images.create({ ...body, source: 'upload' }) };
        } catch (error) {
          return errorResponse(error);
        }
      }
      if (id !== undefined && action === 'content' && method === 'GET') {
        try {
          const { asset, bytes } = core.images.readContent(id);
          return { status: 200, bytes: new Uint8Array(bytes), mime: asset.mime };
        } catch {
          return { status: 404, body: { error: 'not_found', message: '图片不存在' } };
        }
      }
      if (id !== undefined && method === 'GET') {
        const asset = core.images.get(id);
        return asset === null || asset.deletedAt !== null
          ? { status: 404, body: { error: 'not_found', message: '图片不存在' } }
          : { status: 200, body: asset };
      }
      if (id !== undefined && method === 'PUT') {
        try {
          const body = imageUpdateSchema.parse(await readBody(IMAGE_BODY_TEXT_LIMIT));
          return { status: 200, body: core.images.update(id, compact(body)) };
        } catch (error) {
          return errorResponse(error);
        }
      }
      if (id !== undefined && method === 'DELETE') {
        try {
          core.images.remove(id);
          return { status: 200, body: { status: 'archived' } };
        } catch (error) {
          return errorResponse(error);
        }
      }
    }

    // ---- generations --------------------------------------------------------
    if (resource === 'generations') {
      if (id === 'resolve' && method === 'POST') {
        try {
          const input = parseGenerationBody(await readBody(IMAGE_BODY_TEXT_LIMIT));
          const snapshot = core.generations.resolve(input);
          return { status: 200, body: snapshot };
        } catch (error) {
          return errorResponse(error);
        }
      }
      if (id === undefined && method === 'GET') {
        const query = listSchema.safeParse(Object.fromEntries(url.searchParams));
        if (!query.success) {
          return { status: 400, body: { error: 'invalid_query', message: '查询参数不合法' } };
        }
        return { status: 200, body: core.generations.list(query.data, actor) };
      }
      if (id === undefined && method === 'POST') {
        try {
          const raw = (await readBody(IMAGE_BODY_TEXT_LIMIT)) as Record<string, unknown>;
          const key =
            typeof raw.idempotency_key === 'string'
              ? raw.idempotency_key
              : `admin:${context.username}:${new Date().toISOString()}`;
          const input = parseGenerationBody(raw);
          const { generation, replayed } = core.generations.create(input, actor, key);
          return {
            status: replayed ? 200 : 201,
            body: { generation, replayed },
          };
        } catch (error) {
          return errorResponse(error);
        }
      }
      if (id !== undefined && method === 'GET') {
        try {
          return { status: 200, body: core.generations.get(id, actor) };
        } catch (error) {
          return errorResponse(error);
        }
      }
      if (id !== undefined && action === 'retry' && method === 'POST') {
        try {
          const raw = (await readBody(IMAGE_BODY_TEXT_LIMIT)) as Record<string, unknown>;
          const key =
            typeof raw.idempotency_key === 'string'
              ? raw.idempotency_key
              : `admin:${context.username}:${new Date().toISOString()}`;
          const { generation, replayed } = core.generations.retry(id, actor, key);
          return { status: replayed ? 200 : 201, body: { generation, replayed } };
        } catch (error) {
          return errorResponse(error);
        }
      }
    }

    // ---- configuration (enable/disable / models / credentials) ------------
    if (resource === 'config' && method === 'PUT') {
      return await applyImageConfig(await readBody(IMAGE_BODY_TEXT_LIMIT));
    }

    return { status: 404, body: { error: 'not_found', message: 'Unknown image route' } };
  };
}
