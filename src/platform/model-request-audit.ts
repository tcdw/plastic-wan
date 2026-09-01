import { createHash } from 'node:crypto';

const IMAGE_DATA_URL_PREFIX = /^data:(image\/[a-z0-9.+-]+)(?:;[^,]*)?;base64,/i;

export interface ScrubbedModelRequestAudit {
  readonly json: string;
  readonly replacements: number;
  readonly removedCharacters: number;
  readonly decodedBytes: number;
}

export function serializeModelRequestForAudit(payload: unknown): string {
  return scrubModelRequestAuditJson(JSON.stringify(payload ?? null)).json;
}

export function scrubModelRequestAuditJson(json: string): ScrubbedModelRequestAudit {
  let replacements = 0;
  let _encodedCharacters = 0;
  let decodedBytes = 0;
  const parsed: unknown = JSON.parse(json);
  const scrubbed = JSON.stringify(parsed, (_key, value: unknown) => {
    if (typeof value !== 'string') {
      return value;
    }
    const prefix = IMAGE_DATA_URL_PREFIX.exec(value);
    if (prefix === null) {
      return value;
    }
    const mimeType = prefix[1];
    if (mimeType === undefined) {
      return value;
    }
    const encoded = value.slice(prefix[0].length);
    const bytes = Buffer.from(encoded, 'base64');
    replacements += 1;
    _encodedCharacters += encoded.length;
    decodedBytes += bytes.byteLength;
    return {
      __plasticwan_audit_omission__: 'base64_image',
      mime_type: mimeType.toLowerCase(),
      encoded_characters: encoded.length,
      decoded_bytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  });
  return {
    json: scrubbed,
    replacements,
    removedCharacters: Math.max(0, json.length - scrubbed.length),
    decodedBytes,
  };
}
