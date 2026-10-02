import { randomUUID } from 'node:crypto';
import { and, count, desc, eq, isNull, like, or, type SQL } from 'drizzle-orm';
import type { ImageAsset, ListQuery, Page, PromptAsset } from './contracts.ts';
import { conflict, inputError, notFound, storageFailure } from './errors.ts';
import type { ImageDatabase } from './db.ts';
import { images, prompts } from './schema.ts';
import { decodeBase64Image, MAX_IMAGE_BYTES, type AllowedMime, type ImageStore } from './image-store.ts';

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function searchPattern(q: string): string {
  return `%${escapeLike(q)}%`;
}

type PromptRow = typeof prompts.$inferSelect;
type ImageRow = typeof images.$inferSelect;

export function toPromptAsset(row: PromptRow): PromptAsset {
  return {
    id: row.id,
    name: row.name,
    body: row.body,
    description: row.description,
    category: row.category,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}

export function toImageAsset(row: ImageRow): ImageAsset {
  return {
    id: row.id,
    name: row.name,
    mime: row.mime,
    width: row.width,
    height: row.height,
    bytes: row.bytes,
    description: row.description,
    category: row.category,
    source: row.source,
    generationId: row.generationId,
    outputIndex: row.outputIndex,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}

/** Rejects `{{` / `}}` so a prompt asset can never smuggle a recursive reference. */
function assertNoReferenceSyntax(body: string): void {
  if (body.includes('{{') || body.includes('}}')) {
    throw inputError('recursive_reference', 'Prompt 素材正文不能包含引用语法 {{ }}');
  }
}

export type PromptService = ReturnType<typeof createPromptService>;

export function createPromptService(deps: { db: ImageDatabase }) {
  const { db } = deps;

  function list(query: ListQuery): Page<PromptAsset> {
    const status = isNull(prompts.deletedAt);
    const search: SQL | undefined =
      query.q.length > 0
        ? or(
            like(prompts.name, searchPattern(query.q)),
            like(prompts.description, searchPattern(query.q)),
            like(prompts.category, searchPattern(query.q)),
          )
        : undefined;
    const where = search === undefined ? status : and(status, search);
    const total = db.select({ value: count() }).from(prompts).where(where).get()?.value ?? 0;
    const rows = db
      .select()
      .from(prompts)
      .where(where)
      .orderBy(desc(prompts.createdAt), desc(prompts.id))
      .limit(query.limit)
      .offset(query.offset)
      .all();
    return { items: rows.map(toPromptAsset), total, limit: query.limit, offset: query.offset };
  }

  /** Archived assets stay readable so accepted generations keep their provenance. */
  function get(id: string): PromptAsset | null {
    const row = db.select().from(prompts).where(eq(prompts.id, id)).get();
    return row === undefined ? null : toPromptAsset(row);
  }

  function getActive(id: string): PromptAsset | null {
    const row = db
      .select()
      .from(prompts)
      .where(and(eq(prompts.id, id), isNull(prompts.deletedAt)))
      .get();
    return row === undefined ? null : toPromptAsset(row);
  }

  function create(input: { name: string; body: string; description: string; category: string }): PromptAsset {
    assertNoReferenceSyntax(input.body);
    const now = new Date().toISOString();
    const row: PromptRow = {
      id: randomUUID(),
      name: input.name,
      body: input.body,
      description: input.description,
      category: input.category,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    db.insert(prompts).values(row).run();
    return toPromptAsset(row);
  }

  function update(
    id: string,
    patch: Partial<{ name: string; body: string; description: string; category: string }>,
  ): PromptAsset {
    const row = db.select().from(prompts).where(eq(prompts.id, id)).get();
    if (row === undefined) {
      throw notFound('Prompt 素材不存在');
    }
    if (row.deletedAt !== null) {
      throw conflict('asset_archived', '已归档的素材不能修改');
    }
    if (patch.body !== undefined) {
      assertNoReferenceSyntax(patch.body);
    }
    const now = new Date().toISOString();
    const next: PromptRow = {
      ...row,
      name: patch.name ?? row.name,
      body: patch.body ?? row.body,
      description: patch.description ?? row.description,
      category: patch.category ?? row.category,
      updatedAt: now,
    };
    db.update(prompts).set(next).where(eq(prompts.id, id)).run();
    return toPromptAsset(next);
  }

  function remove(id: string): PromptAsset {
    const row = db.select().from(prompts).where(eq(prompts.id, id)).get();
    if (row === undefined) {
      throw notFound('Prompt 素材不存在');
    }
    if (row.deletedAt === null) {
      const now = new Date().toISOString();
      db.update(prompts).set({ deletedAt: now, updatedAt: now }).where(eq(prompts.id, id)).run();
      return toPromptAsset({ ...row, deletedAt: now, updatedAt: now });
    }
    return toPromptAsset(row);
  }

  return { list, get, getActive, create, update, remove };
}

export type ImageService = ReturnType<typeof createImageService>;

export type CreateImageInput = {
  name: string;
  base64: string;
  mime: AllowedMime;
  description: string;
  category: string;
  source: 'upload' | 'generation';
  generationId?: string | null;
  outputIndex?: number | null;
};

export function createImageService(deps: { db: ImageDatabase; store: ImageStore }) {
  const { db, store } = deps;

  async function create(input: CreateImageInput): Promise<ImageAsset> {
    const bytes = decodeBase64Image(input.base64);
    if (bytes.length > MAX_IMAGE_BYTES) {
      throw inputError('payload_too_large', '图片超过 20MiB 上限');
    }
    const stored = await store.store({ bytes, expectedMime: input.mime });
    return persist(stored, input);
  }

  function persist(
    stored: {
      id: string;
      fileName: string;
      mime: string;
      width: number;
      height: number;
      bytes: number;
      sha256: string;
    },
    input: {
      name: string;
      description: string;
      category: string;
      source: 'upload' | 'generation';
      generationId?: string | null;
      outputIndex?: number | null;
    },
  ): ImageAsset {
    const now = new Date().toISOString();
    const row: ImageRow = {
      id: stored.id,
      name: input.name,
      mime: stored.mime,
      width: stored.width,
      height: stored.height,
      bytes: stored.bytes,
      sha256: stored.sha256,
      fileName: stored.fileName,
      description: input.description,
      category: input.category,
      source: input.source,
      generationId: input.generationId ?? null,
      outputIndex: input.outputIndex ?? null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    db.insert(images).values(row).run();
    return toImageAsset(row);
  }

  function list(query: ListQuery): Page<ImageAsset> {
    const status = isNull(images.deletedAt);
    const search: SQL | undefined =
      query.q.length > 0
        ? or(
            like(images.name, searchPattern(query.q)),
            like(images.description, searchPattern(query.q)),
            like(images.category, searchPattern(query.q)),
          )
        : undefined;
    const where = search === undefined ? status : and(status, search);
    const total = db.select({ value: count() }).from(images).where(where).get()?.value ?? 0;
    const rows = db
      .select()
      .from(images)
      .where(where)
      .orderBy(desc(images.createdAt), desc(images.id))
      .limit(query.limit)
      .offset(query.offset)
      .all();
    return { items: rows.map(toImageAsset), total, limit: query.limit, offset: query.offset };
  }

  function get(id: string): ImageAsset | null {
    const row = db.select().from(images).where(eq(images.id, id)).get();
    return row === undefined ? null : toImageAsset(row);
  }

  function update(id: string, patch: Partial<{ name: string; description: string; category: string }>): ImageAsset {
    const row = db.select().from(images).where(eq(images.id, id)).get();
    if (row === undefined) {
      throw notFound('图片素材不存在');
    }
    if (row.deletedAt !== null) {
      throw conflict('asset_archived', '已归档的素材不能修改');
    }
    const now = new Date().toISOString();
    const next: ImageRow = {
      ...row,
      name: patch.name ?? row.name,
      description: patch.description ?? row.description,
      category: patch.category ?? row.category,
      updatedAt: now,
    };
    db.update(images).set(next).where(eq(images.id, id)).run();
    return toImageAsset(next);
  }

  /** Archival only: the immutable file stays on disk for history. */
  function remove(id: string): ImageAsset {
    const row = db.select().from(images).where(eq(images.id, id)).get();
    if (row === undefined) {
      throw notFound('图片素材不存在');
    }
    if (row.deletedAt === null) {
      const now = new Date().toISOString();
      db.update(images).set({ deletedAt: now, updatedAt: now }).where(eq(images.id, id)).run();
      return toImageAsset({ ...row, deletedAt: now, updatedAt: now });
    }
    return toImageAsset(row);
  }

  function readContent(id: string): { asset: ImageAsset; bytes: Buffer } {
    const asset = get(id);
    if (asset === null) {
      throw notFound('图片素材不存在');
    }
    const row = db.select().from(images).where(eq(images.id, id)).get();
    if (row === undefined) {
      throw storageFailure('image_file_missing', '图片文件不可读取');
    }
    if (!store.exists(row.fileName)) {
      throw storageFailure('image_file_missing', '图片文件不可读取');
    }
    return { asset, bytes: store.read(row.fileName) };
  }

  function toBase64(id: string): { asset: ImageAsset; base64: string } {
    const { asset, bytes } = readContent(id);
    return { asset, base64: bytes.toString('base64') };
  }

  function listByGeneration(generationId: string): ImageAsset[] {
    return db
      .select()
      .from(images)
      .where(eq(images.generationId, generationId))
      .orderBy(images.outputIndex)
      .all()
      .map(toImageAsset);
  }

  return { create, persist, list, get, update, remove, readContent, toBase64, listByGeneration };
}
